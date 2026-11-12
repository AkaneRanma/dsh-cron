import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, readdirSync, rmSync, chmodSync, statSync, lstatSync } from 'node:fs'
import { join, dirname, basename, extname, isAbsolute, resolve, parse as parsePath } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { request as httpsRequest } from 'node:https'

/**
 * dsh-cron —— 宿主半侧：自带 cron 调度内核（不依赖任何外部服务）。
 *
 * 唯一事实源：<DSH_HOME>/schedule/jobs.json，随插件走。
 * 执行账本：<DSH_HOME>/schedule/executions.db（node:sqlite）。
 * 定时靠进程内 ticker；到点执行的脚本 stdout 可投递到 Discord。
 */

export const name = 'dsh-cron'
export const inject = ['webServer']

const DEFAULTS = {
  enabled: true,
  writable: true,
  dataHome: '',
  pythonCommand: 'python',
  timeoutMs: 300000,
  tickMs: 20000,
  /* 到点后多久之内还算「晚到」，照跑；超过就记 missed（不再静默跳过） */
  catchUpSec: 3600,
  /* 老配置里的字段名，继续兼容；实际以 catchUpSec 为准 */
  maxLatenessSec: 3600,
  /* 漏跑要不要发一条 Discord 通知；同一任务有冷却，防止每分钟任务刷屏 */
  missedNotify: true,
  missedNotifyCooldownSec: 1800,
  /* 超过容差也不全作废：每个任务每次补扫最多真跑一次（最近一次到点），更早的合并记账 */
  missedCatchUpOnce: false,
  /* 漏跑回看窗口：只在这个时间范围内盘点「到点却没记录」的时刻 */
  missedLookbackMinutes: 4320,
  /* 一次最多补记多少条漏跑占位（按分钟排满 3 天也就 4320 条） */
  missedBulkCap: 4320,
  /* 一次性销毁任务：默认 N 分钟后执行；错过窗口多久还补跑（默认 30 天，关机一夜也能补上） */
  purgeDefaultMinutes: 120,
  purgeMaxLatenessSec: 2592000,
  discordToken: '',
  discordWebhook: '',
}

function dshHomeDir() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return join(homedir(), '.dsh')
}

function dataHomeOf(opts) {
  if (opts.dataHome) return opts.dataHome
  return join(dshHomeDir(), 'schedule')
}

/* ---------- 事实源读写 ---------- */

function readJobFile(file) {
  if (!existsSync(file)) return { file, jobs: [], missing: true }
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const parsed = JSON.parse(raw)
  const jobs = Array.isArray(parsed) ? parsed : Array.isArray(parsed.jobs) ? parsed.jobs : []
  return { file, jobs, wrapper: Array.isArray(parsed) ? { arrayForm: true } : parsed }
}

function writeJobFile(file, wrapper, jobs) {
  mkdirSync(dirname(file), { recursive: true })
  const backupDir = join(dirname(file), 'backups')
  mkdirSync(backupDir, { recursive: true })
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(file, join(backupDir, basename(file) + '.' + stamp + '.bak'))
    const olds = readdirSync(backupDir).filter((f) => f.startsWith(basename(file) + '.')).sort()
    for (const f of olds.slice(0, Math.max(0, olds.length - 10))) {
      try { rmSync(join(backupDir, f)) } catch { /* ignore */ }
    }
  }
  const next = wrapper && wrapper.arrayForm ? jobs : { ...(wrapper || {}), jobs }
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
  return file
}

function ownFile(opts) { return join(dataHomeOf(opts), 'jobs.json') }
function ledgerFile(opts) { return join(dataHomeOf(opts), 'executions.db') }
function settingsFile(opts) { return join(dataHomeOf(opts), 'settings.json') }
function namesFile(opts) { return join(dataHomeOf(opts), 'names.json') }

/** id -> 任务名 的登记表。任务被删掉以后，历史执行记录仍能显示中文名。 */
function loadNames(opts) {
  const file = namesFile(opts)
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function rememberNames(opts, jobs) {
  const known = loadNames(opts)
  let dirty = false
  for (const job of jobs || []) {
    if (!job || !job.id) continue
    const name = String(job.name || '').trim()
    if (name && known[job.id] !== name) { known[job.id] = name; dirty = true }
  }
  if (dirty && opts.writable !== false) {
    try {
      const file = namesFile(opts)
      mkdirSync(dirname(file), { recursive: true })
      const tmp = file + '.tmp-' + process.pid
      writeFileSync(tmp, JSON.stringify(known, null, 2) + '\n', 'utf8')
      renameSync(tmp, file)
    } catch { /* 名字缓存写不进去不影响主流程 */ }
  }
  return known
}

/**
 * 消息平台设置：<dataHome>/settings.json。
 * 面板改它即时生效（每次投递都重新读），不必重启；cordis.patch.yml 里的同名字段只作初值。
 */
function numberOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** 调度容差：settings.json 优先，其次插件配置（含老字段 maxLatenessSec），最后默认值。 */
function tuningOf(source, opts) {
  const base = source || {}
  const cfg = opts || {}
  const fromConfig = numberOr(cfg.catchUpSec !== undefined ? cfg.catchUpSec : cfg.maxLatenessSec, DEFAULTS.catchUpSec)
  return {
    catchUpSec: numberOr(base.catchUpSec, fromConfig),
    missedNotify: typeof base.missedNotify === 'boolean' ? base.missedNotify
      : (typeof cfg.missedNotify === 'boolean' ? cfg.missedNotify : DEFAULTS.missedNotify),
    missedNotifyCooldownSec: numberOr(base.missedNotifyCooldownSec, numberOr(cfg.missedNotifyCooldownSec, DEFAULTS.missedNotifyCooldownSec)),
    missedLookbackMinutes: numberOr(base.missedLookbackMinutes, numberOr(cfg.missedLookbackMinutes, DEFAULTS.missedLookbackMinutes)),
    missedCatchUpOnce: typeof base.missedCatchUpOnce === 'boolean' ? base.missedCatchUpOnce
      : (typeof cfg.missedCatchUpOnce === 'boolean' ? cfg.missedCatchUpOnce : DEFAULTS.missedCatchUpOnce),
  }
}

function loadSettings(opts) {
  const fromConfig = {
    discordToken: String(opts.discordToken || ''),
    discordWebhook: String(opts.discordWebhook || ''),
    discordChannel: String(opts.discordChannel || ''),
    allowedUsers: Array.isArray(opts.allowedUsers) ? opts.allowedUsers.map(String) : [],
  }
  const file = settingsFile(opts)
  if (!existsSync(file)) return { ...fromConfig, ...tuningOf(null, opts), extra: {}, file, fromFile: false }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {}
    return {
      discordToken: typeof parsed.discordToken === 'string' ? parsed.discordToken : fromConfig.discordToken,
      discordWebhook: typeof parsed.discordWebhook === 'string' ? parsed.discordWebhook : fromConfig.discordWebhook,
      discordChannel: typeof parsed.discordChannel === 'string' ? parsed.discordChannel : fromConfig.discordChannel,
      allowedUsers: Array.isArray(parsed.allowedUsers) ? parsed.allowedUsers.map(String) : fromConfig.allowedUsers,
      ...tuningOf(parsed, opts),
      extra: parsed,
      file,
      fromFile: true,
    }
  } catch {
    return { ...fromConfig, ...tuningOf(null, opts), extra: {}, file, fromFile: false, broken: true }
  }
}

function saveSettings(opts, body) {
  const current = loadSettings(opts)
  /* 保留文件里未知的键：面板只改它认识的字段，别顺手把别的配置洗掉 */
  const next = {
    ...(current.extra || {}),
    discordToken: current.discordToken,
    discordWebhook: current.discordWebhook,
    discordChannel: current.discordChannel,
    allowedUsers: current.allowedUsers.slice(),
  }
  if (typeof body.discordToken === 'string') next.discordToken = body.discordToken.trim()
  if (body.discordToken === null) next.discordToken = ''
  if (typeof body.discordWebhook === 'string') next.discordWebhook = body.discordWebhook.trim()
  if (body.discordWebhook === null) next.discordWebhook = ''
  if (typeof body.discordChannel === 'string') next.discordChannel = body.discordChannel.trim()
  if (body.discordChannel === null) next.discordChannel = ''
  if (Array.isArray(body.allowedUsers)) next.allowedUsers = body.allowedUsers.map((x) => String(x).trim()).filter(Boolean)
  if (body.catchUpSec !== undefined) {
    const n = Number(body.catchUpSec)
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'catchUpSec 需要 >= 0 的数字（秒）' }
    next.catchUpSec = Math.round(n)
    delete next.maxLatenessSec
  }
  if (body.missedNotify !== undefined) next.missedNotify = Boolean(body.missedNotify)
  if (body.missedCatchUpOnce !== undefined) next.missedCatchUpOnce = Boolean(body.missedCatchUpOnce)
  if (body.missedNotifyCooldownSec !== undefined) {
    const n = Number(body.missedNotifyCooldownSec)
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'missedNotifyCooldownSec 需要 >= 0 的数字（秒）' }
    next.missedNotifyCooldownSec = Math.round(n)
  }
  const tuningKeys = ['catchUpSec', 'missedNotify', 'missedNotifyCooldownSec', 'missedLookbackMinutes', 'missedCatchUpOnce']
  const hasTuning = tuningKeys.some((k) => next[k] !== undefined)
  if (!next.discordToken && !next.discordWebhook && !next.discordChannel && next.allowedUsers.length === 0 && !hasTuning) {
    /* 全清空：直接删文件，回到配置文件里的初值 */
    try { rmSync(settingsFile(opts)) } catch { /* ignore */ }
    return { ok: true, cleared: true, settings: publicSettings(loadSettings(opts)) }
  }
  const file = settingsFile(opts)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  try { chmodSync(tmp, 0o600) } catch { /* windows 上可能无效 */ }
  renameSync(tmp, file)
  return { ok: true, settings: publicSettings(loadSettings(opts)) }
}

function maskSecret(value) {
  const s = String(value || '')
  if (!s) return ''
  if (s.length <= 10) return s.slice(0, 2) + '…' + s.slice(-2)
  return s.slice(0, 4) + '…' + s.slice(-4)
}

function publicSettings(settings) {
  return {
    tokenSaved: Boolean(settings.discordToken),
    tokenMask: maskSecret(settings.discordToken),
    webhook: settings.discordWebhook || '',
    channel: settings.discordChannel || '',
    allowedUsers: settings.allowedUsers || [],
    catchUpSec: settings.catchUpSec,
    missedNotify: settings.missedNotify,
    missedNotifyCooldownSec: settings.missedNotifyCooldownSec,
    missedLookbackMinutes: settings.missedLookbackMinutes,
    missedCatchUpOnce: settings.missedCatchUpOnce === true,
    file: settings.file,
    fromFile: Boolean(settings.fromFile),
  }
}

function loadStore(opts) {
  return readJobFile(ownFile(opts))
}

/* ---------- 账本（自己的库，可写） ---------- */

async function openLedger(opts, readOnly) {
  let DatabaseSync
  try {
    ({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    throw new Error('node:sqlite 不可用（需要 Node >= 22.5）')
  }
  const file = ledgerFile(opts)
  if (readOnly && !existsSync(file)) throw new Error('no ledger yet')
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE IF NOT EXISTS executions (job_id TEXT NOT NULL, scheduled_instant TEXT NOT NULL, status TEXT, delivery_outcome TEXT, error TEXT, started_at TEXT, finished_at TEXT, PRIMARY KEY (job_id, scheduled_instant))')
  db.exec('CREATE TABLE IF NOT EXISTS incidents (job_id TEXT NOT NULL, error_sig TEXT NOT NULL, occurrences INTEGER NOT NULL DEFAULT 0, last_seen TEXT, PRIMARY KEY (job_id, error_sig))')
  /* 老库没有 detail 列：加一次，失败说明已经有了 */
  try { db.exec('ALTER TABLE executions ADD COLUMN detail TEXT') } catch { /* exist */ }
  return db
}

async function readLedger(opts) {
  try {
    const db = await openLedger(opts, false)
    try {
      const executions = db.prepare('SELECT job_id, scheduled_instant, status, delivery_outcome, error, detail FROM executions ORDER BY scheduled_instant DESC LIMIT 300').all()
      const incidents = db.prepare('SELECT job_id, error_sig, occurrences, last_seen FROM incidents ORDER BY occurrences DESC LIMIT 50').all()
      return { executions, incidents }
    } finally { db.close() }
  } catch (err) {
    return { executions: [], incidents: [], error: String(err && err.message ? err.message : err) }
  }
}

/* ---------- 最小 5 段 cron ---------- */

function parseField(text, min, max) {
  const out = new Set()
  for (const part of String(text).split(',')) {
    const [base, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isFinite(step) || step <= 0) throw new Error('bad step: ' + part)
    let lo
    let hi
    if (base === '*') { lo = min; hi = max }
    else if (base.includes('-')) { const [a, b] = base.split('-'); lo = Number(a); hi = Number(b) }
    else { lo = Number(base); hi = Number(base) }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) throw new Error('bad field: ' + part)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/)
  if (parts.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周')
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12),
    dow: parseField(parts[4], 0, 6),
    domStar: parts[2] === '*',
    dowStar: parts[4] === '*',
  }
}

function matchesCron(c, d) {
  if (!c.minute.has(d.getMinutes())) return false
  if (!c.hour.has(d.getHours())) return false
  if (!c.month.has(d.getMonth() + 1)) return false
  const domOk = c.dom.has(d.getDate())
  const dowOk = c.dow.has(d.getDay())
  if (c.domStar && c.dowStar) return true
  if (c.domStar) return dowOk
  if (c.dowStar) return domOk
  return domOk || dowOk
}

function stepMinute(d, delta) {
  const next = new Date(d.getTime())
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + delta)
  return next
}

function nextRuns(c, from, count) {
  const out = []
  let cursor = stepMinute(from, 1)
  const limit = 60 * 24 * 366
  for (let i = 0; i < limit && out.length < count; i += 1) {
    if (matchesCron(c, cursor)) out.push(new Date(cursor.getTime()))
    cursor = stepMinute(cursor, 1)
  }
  return out
}

/** 最近一个已经到点的时刻（含容差窗口）；找不到返回 null。 */
function latestOccurrence(c, now, lookbackMinutes) {
  let cursor = stepMinute(now, 0)
  const limit = lookbackMinutes || 60 * 24 * 40
  for (let i = 0; i < limit; i += 1) {
    if (matchesCron(c, cursor)) return new Date(cursor.getTime())
    cursor = stepMinute(cursor, -1)
  }
  return null
}

function decorate(job) {
  const out = { ...job }
  if (job.schedule && job.schedule.kind === 'once') {
    const at = new Date(job.schedule.at || '')
    const valid = Number.isFinite(at.getTime())
    out.kind = 'once'
    out.at = valid ? at.toISOString() : null
    out.dueInSec = valid ? Math.round((at.getTime() - Date.now()) / 1000) : null
    out.nextRuns = []
    return out
  }
  const expr = job.schedule && typeof job.schedule.expr === 'string' ? job.schedule.expr : ''
  if (!expr) return out
  try {
    out.nextRuns = nextRuns(parseCron(expr), new Date(), 3).map((d) => d.toISOString())
  } catch (err) {
    out.nextRuns = []
    out.nextRunsError = String(err && err.message ? err.message : err)
  }
  return out
}

/* ---------- 执行与投递 ---------- */

/** 测试投递：发一条固定文本，验证 token/webhook 能用。 */
async function testDeliver(opts, channel) {
  const settings = loadSettings(opts)
  const target = String(channel || settings.discordChannel || '').trim()
  const content = '**定时任务** · 测试消息 · ' + new Date().toLocaleString('zh-CN') + '\n连接正常，之后任务执行结果会发到这里。'
  const id = target.startsWith('discord:') ? target.slice(8).trim() : target
  const r = await postDiscord(opts, settings, id, content)
  return r.ok ? { ok: true, channel: settings.discordWebhook ? 'webhook' : id, status: r.status } : { ok: false, channel: settings.discordWebhook ? 'webhook' : id, error: r.error || 'HTTP ' + r.status }
}

function resolveScript(opts, job) {
  const dirs = [dataHomeOf(opts), join(dataHomeOf(opts), 'scripts')]
  const name = String(job.script || '')
  if (!name) return null
  const candidates = []
  if (isAbsolute(name)) candidates.push(name)
  for (const d of dirs) candidates.push(join(d, name))
  for (const d of dirs) candidates.push(join(d, 'scripts', basename(name)))
  return candidates.find((p) => existsSync(p)) || null
}

function runScript(opts, job) {
  const script = resolveScript(opts, job)
  if (!script) return Promise.resolve({ ok: false, error: 'script not found: ' + String(job.script || '') })
  const ext = extname(script).toLowerCase()
  const cmd = ext === '.py' ? (opts.pythonCommand || 'python')
    : (ext === '.mjs' || ext === '.js' || ext === '.cjs') ? process.execPath
      : process.platform === 'win32' ? 'cmd' : 'sh'
  const args = cmd === process.execPath ? [script]
    : (process.platform === 'win32' && cmd === 'cmd' ? ['/c', script] : [script])
  const started = Date.now()
  return new Promise((resolve) => {
    /* 管道不是终端：Windows 上 Python 默认按 ANSI 代码页输出，中文会变成乱码，
       这里强制 UTF-8，保证账本与 Discord 里看到的是原文。对 node/cmd 无副作用。 */
    const child = spawn(cmd, args, {
      cwd: dirname(script),
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, opts.timeoutMs || DEFAULTS.timeoutMs)
    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: String(err && err.message ? err.message : err) }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code, ms: Date.now() - started, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) })
    })
  })
}

function errorText(err) {
  if (!err) return 'unknown error'
  const parts = [String(err.message || err)]
  if (err.code) parts.push('code=' + err.code)
  if (err.cause) parts.push('cause=' + String(err.cause.code || err.cause.message || err.cause))
  if (Array.isArray(err.errors) && err.errors.length) {
    parts.push('tries=' + err.errors.map((e) => [e && e.code, e && e.message && String(e.message).slice(0, 60)].filter(Boolean).join(':')).join('|'))
  }
  return parts.join(' ')
}

/** POST JSON：带 Bot 授权头，优先用 fetch（对双栈/代理更宽容），失败再回落 https.request。 */
async function postJson(url, payload, auth) {
  const headers = { 'content-type': 'application/json', 'user-agent': 'DiscordBot (dsh-cron, 0.2.0)' }
  if (auth) headers.authorization = auth
  if (typeof fetch === 'function') {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      })
      const text = await res.text()
      const ok = res.status >= 200 && res.status < 300
      if (!ok) return { ok: false, status: res.status, error: 'HTTP ' + res.status + ' ' + text.slice(0, 200) }
      return { ok: true, status: res.status, text: text.slice(0, 400) }
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  }
  return await new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    let u
    try { u = new URL(url) } catch { resolve({ ok: false, error: 'bad url' }); return }
    const req = httpsRequest({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { ...headers, 'content-length': body.length },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (d) => { text += d })
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300
        resolve(ok ? { ok: true, status: res.statusCode, text: text.slice(0, 400) } : { ok: false, status: res.statusCode, error: 'HTTP ' + res.statusCode + ' ' + text.slice(0, 200) })
      })
    })
    req.on('error', (err) => resolve({ ok: false, error: errorText(err) }))
    req.write(body)
    req.end()
  })
}

function clip(text, max) {
  const s = String(text || '')
  if (s.length <= max) return s
  return s.slice(0, max - 20) + '\n…（截断 ' + (s.length - max + 20) + ' 字符）'
}

/** 按行切段，每段不超过 limit 字符（Discord 单条上限 2000）。 */
function chunkText(text, limit) {
  const src = String(text || '')
  if (src.length <= limit) return [src]
  const out = []
  let buf = ''
  for (const line of src.split('\n')) {
    if (buf && buf.length + line.length + 1 > limit) { out.push(buf); buf = '' }
    if (line.length > limit) {
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit))
      continue
    }
    buf = buf ? buf + '\n' + line : line
  }
  if (buf) out.push(buf)
  return out
}

/**
 * 投递：配置 webhook 优先，其次 bot token + discord:<channelId>。都没配就算 skipped。
 * 正文按原文发，保留脚本自己的 Markdown（粗体、列表、> 引用、链接都能正常渲染）；
 * 不套代码块 —— 套上以后所有 Markdown 都变成字面量，看起来就是一堆 ** 和反引号。
 */
async function deliver(opts, job, output) {
  const settings = loadSettings(opts)
  const target = String(job.deliver || '').trim()
  const text = String(output || '').trim()
  /* 不加额外的任务名标题行：脚本自己的首行就是标题，多一行反而重复。 */
  const pieces = chunkText(text || '**' + (job.name || job.id) + '**\n（这次没有输出）', 1800)
  const bodies = pieces.map((p, i) => (i === 0 ? p : '（续 ' + (i + 1) + '/' + pieces.length + '）\n' + p))
  const results = []
  for (const content of bodies) results.push(await postDiscord(opts, settings, target, content))
  const bad = results.find((r) => !r.ok)
  if (!bad) return { outcome: 'delivered', status: results[0] && results[0].status, parts: results.length }
  /* 没配频道不算「发送失败」，单独记成 skipped，面板显示「未配置频道」 */
  if (bad.noTarget) return { outcome: 'skipped', error: bad.error, parts: results.length }
  return { outcome: 'failed', error: bad.error || 'HTTP ' + bad.status, parts: results.length }
}

/** webhook 或 bot+频道 二选一，返回 {ok,status|error}。 */
async function postDiscord(opts, settings, target, content) {
  const payload = { content, allowed_mentions: { parse: [] } }
  if (settings.discordWebhook) return await postJson(settings.discordWebhook, payload)
  const token = settings.discordToken || process.env.DISCORD_BOT_TOKEN || ''
  const channel = target.startsWith('discord:') ? target.slice(8).trim() : (target || settings.discordChannel || '')
  if (!token || !channel) return { ok: false, noTarget: true, error: '没有配置投递频道' }
  return await postJson('https://discord.com/api/v10/channels/' + channel + '/messages', payload, 'Bot ' + token)
}

/* ---------- 一次性自毁任务（临时产物清理） ---------- */

/**
 * 删除前的硬闸：只接受绝对路径、拒绝盘符根与受保护目录本身。
 * 越界即拒，不做"尽力删除"——删错比没删严重得多。
 */
function cleanupGuard(target, opts) {
  const raw = String(target || '').trim()
  if (!raw) return '空路径'
  if (!isAbsolute(raw)) return '必须是绝对路径'
  const abs = resolve(raw)
  if (parsePath(abs).root === abs) return '不能删除盘符根'
  const norm = abs.replace(/[\\/]+$/, '')
  const lower = norm.toLowerCase()
  const depth = lower.split(/[\\/]+/).filter(Boolean).length
  if (depth < 2) return '路径层级太浅'
  const guards = [dshHomeDir(), opts ? dataHomeOf(opts) : '', process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], homedir(), join(process.env.SystemRoot || 'C:\\Windows', '')]
    .filter(Boolean)
    .map((x) => String(x).replace(/[\\/]+$/, '').toLowerCase())
  for (const g of guards) if (g && lower === g) return '受保护目录：' + g
  return null
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

function sizeOf(target) {
  try {
    const st = lstatSync(target)
    if (!st.isDirectory()) return st.size
    let total = 0
    for (const name of readdirSync(target)) total += sizeOf(join(target, name))
    return total
  } catch { return 0 }
}

/** 真删：目录递归、文件直接删；不存在的记为「已不存在」，不算失败。 */
function runCleanup(opts, job) {
  const paths = job && job.cleanup && Array.isArray(job.cleanup.paths) ? job.cleanup.paths : []
  const started = Date.now()
  const removed = []
  const missing = []
  const failed = []
  let bytes = 0
  for (const raw of paths) {
    const why = cleanupGuard(raw, opts)
    if (why) { failed.push({ path: String(raw), error: why }); continue }
    const target = resolve(String(raw))
    if (!existsSync(target)) { missing.push(target); continue }
    try {
      bytes += sizeOf(target)
      rmSync(target, { recursive: true, force: true })
      if (existsSync(target)) failed.push({ path: target, error: '删除后仍然存在（可能被占用）' })
      else removed.push(target)
    } catch (err) {
      failed.push({ path: target, error: String(err && err.message ? err.message : err) })
    }
  }
  const summary = '删除 ' + removed.length + ' 项' + (bytes ? '，释放 ' + fmtBytes(bytes) : '')
    + (missing.length ? '；已不存在 ' + missing.length + ' 项' : '')
    + (failed.length ? '；失败 ' + failed.length + ' 项：' + failed.map((f) => basename(f.path) + ' ' + f.error).join(' / ').slice(0, 300) : '')
  return { ok: failed.length === 0, removed, missing, failed, bytes, ms: Date.now() - started, summary }
}

/** 建一条一次性自毁任务：到点删除这些路径，成功后自己从 jobs.json 消失，记录留在账本。 */
function purgeLater(opts, input) {
  if (opts.writable === false) return { ok: false, error: '插件配置 writable: false，当前只读' }
  const body = input || {}
  const list = Array.isArray(body.paths) ? body.paths : (body.path ? [body.path] : [])
  const paths = []
  for (const item of list) {
    const text = String(item || '').trim()
    if (!text) continue
    const why = cleanupGuard(text, opts)
    if (why) return { ok: false, error: '路径不能用于自毁：' + text + '（' + why + '）' }
    paths.push(resolve(text))
  }
  if (!paths.length) return { ok: false, error: '至少给一个待删除的绝对路径' }
  const minutes = body.afterMinutes !== undefined ? Number(body.afterMinutes)
    : (body.afterHours !== undefined ? Number(body.afterHours) * 60 : NaN)
  const span = Number.isFinite(minutes) && minutes > 0 ? minutes : (opts.purgeDefaultMinutes || DEFAULTS.purgeDefaultMinutes)
  const at = new Date(Date.now() + span * 60000)
  const note = String(body.note || '').trim()
  const store = loadStore(opts)
  const jobs = (store.jobs || []).slice()
  const id = 'purge-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
  const label = note || paths.map((p) => basename(p)).join(', ')
  const job = {
    id,
    name: ('自毁 ' + label).slice(0, 60),
    schedule: { kind: 'once', at: at.toISOString(), display: '一次性 ' + at.toLocaleString('zh-CN') },
    no_agent: true,
    script: '',
    prompt: '',
    deliver: '',
    cleanup: { paths, note, createdAt: new Date().toISOString() },
    enabled: true,
  }
  jobs.push(job)
  const file = saveJobs(opts, store, jobs)
  return { ok: true, job: decorate(job), at: job.schedule.at, afterMinutes: span, paths, file }
}

/**
 * 执行一条一次性任务：到点才算；force 用于面板「立即销毁」。
 * 返回 null 表示没到点/已经执行过。drop=true 表示执行成功、可以从 jobs.json 移除。
 */
async function runOnceJob(opts, db, job, now, options) {
  const force = Boolean(options && options.force)
  const at = new Date(job.schedule && job.schedule.at ? job.schedule.at : '')
  if (!force) {
    if (!Number.isFinite(at.getTime())) return null
    if (now.getTime() < at.getTime()) return null
  }
  const instant = force ? now.toISOString() : at.toISOString()
  if (!force) {
    const exists = db.prepare('SELECT 1 FROM executions WHERE job_id = ? AND scheduled_instant = ?').get(job.id, instant)
    if (exists) return null
  }
  const tooLate = !force && (now.getTime() - at.getTime()) / 1000 > (opts.purgeMaxLatenessSec || DEFAULTS.purgeMaxLatenessSec)
  db.prepare('INSERT OR IGNORE INTO executions (job_id, scheduled_instant, status, started_at) VALUES (?, ?, ?, ?)')
    .run(job.id, instant, 'running', new Date().toISOString())
  if (tooLate) {
    const note = '错过执行窗口（超过 ' + Math.round((opts.purgeMaxLatenessSec || DEFAULTS.purgeMaxLatenessSec) / 86400) + ' 天），未执行'
    db.prepare('UPDATE executions SET status = ?, error = ?, detail = ?, finished_at = ? WHERE job_id = ? AND scheduled_instant = ?')
      .run('skipped', note, note, new Date().toISOString(), job.id, instant)
    return { id: job.id, instant, status: 'skipped', delivery: 'skipped', detail: note }
  }
  let result
  if (job.cleanup) result = runCleanup(opts, job)
  else if (job.script) {
    const out = await runScript(opts, job)
    result = { ok: out.ok, summary: String(out.ok ? (out.stdout || '') : (out.error || out.stderr || 'exit ' + out.code)).trim().slice(0, 1500) }
  } else result = { ok: false, summary: '一次性任务既没有 cleanup 也没有 script' }
  const status = result.ok ? 'completed' : 'failed'
  db.prepare('UPDATE executions SET status = ?, error = ?, detail = ?, finished_at = ? WHERE job_id = ? AND scheduled_instant = ?')
    .run(status, result.ok ? null : String(result.summary || '').slice(0, 400), String(result.summary || '').slice(0, 2000), new Date().toISOString(), job.id, instant)
  if (!result.ok) {
    const sig = String(result.summary || 'unknown').slice(0, 160)
    db.prepare('INSERT INTO incidents (job_id, error_sig, occurrences, last_seen) VALUES (?, ?, 1, ?) ON CONFLICT(job_id, error_sig) DO UPDATE SET occurrences = occurrences + 1, last_seen = ?')
      .run(job.id, sig, new Date().toISOString(), new Date().toISOString())
  }
  return { id: job.id, instant, status, delivery: 'skipped', detail: result.summary, drop: result.ok }
}

/* ---------- ticker ---------- */

/*
 * 重入保护：一次 tick 没跑完，后面来的 tick 直接返回 busy。
 * 没有它的话，脚本耗时超过 tickMs 时两个 tick 会同时看到「这一分钟没记录」，各跑一遍。
 */
const tickState = { running: false }
const runningJobs = new Set()
const missedNotifiedAt = new Map()

function fmtLocal(date) {
  const d = new Date(date)
  if (!Number.isFinite(d.getTime())) return String(date)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function humanSpan(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  if (s < 90) return s + ' 秒'
  if (s < 5400) return Math.round(s / 60) + ' 分钟'
  if (s < 172800) return (s / 3600).toFixed(1) + ' 小时'
  return (s / 86400).toFixed(1) + ' 天'
}

/**
 * 「到点但账本里没有记录」的时刻，最新在前。
 * - 只看回看窗口内（missedLookbackMinutes），窗口外不翻旧账
 * - 带毫秒的记录（手动执行、强制销毁）不是到点占位，不能当成已执行
 * - status=running 但已超过脚本超时很久的，视为上次进程崩掉的残留，允许本轮重跑
 */
function pendingOccurrences(cron, now, db, jobId, lookbackMinutes, staleMs, createdMs) {
  const rows = db.prepare('SELECT scheduled_instant, status, started_at FROM executions WHERE job_id = ? ORDER BY scheduled_instant DESC LIMIT 20000').all(jobId)
  let sinceMs = now.getTime() - lookbackMinutes * 60000
  if (Number.isFinite(createdMs)) {
    /* 任务创建之前它还不存在，不算漏跑；按下取整到分钟，让「创建那一分钟」的到点照常执行 */
    sinceMs = Math.max(sinceMs, Math.floor(createdMs / 60000) * 60000)
  } else if (!rows.length) {
    /* 老任务没有创建时间、账本又是空的：只回看最近一天，别翻出几周前的「历史漏跑」 */
    sinceMs = Math.max(sinceMs, now.getTime() - 1440 * 60000)
  }
  const have = new Set()
  for (const row of rows) {
    const t = Date.parse(row.scheduled_instant)
    if (!Number.isFinite(t) || t % 60000 !== 0) continue
    if (row.status === 'running') {
      const started = Date.parse(row.started_at || '')
      if (!Number.isFinite(started) || Date.now() - started > staleMs) continue
    }
    have.add(t)
  }
  const out = []
  let cursor = stepMinute(now, 0)
  for (let i = 0; i <= lookbackMinutes; i += 1) {
    if (cursor.getTime() < sinceMs) break
    if (matchesCron(cron, cursor) && !have.has(cursor.getTime())) out.push(new Date(cursor.getTime()))
    cursor = stepMinute(cursor, -1)
  }
  return out
}

const UPSERT_EXEC = 'INSERT OR REPLACE INTO executions (job_id, scheduled_instant, status, delivery_outcome, error, detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'

function recordIncident(db, job, text) {
  const sig = String(text || 'unknown').slice(0, 160)
  const stamp = new Date().toISOString()
  db.prepare('INSERT INTO incidents (job_id, error_sig, occurrences, last_seen) VALUES (?, ?, 1, ?) ON CONFLICT(job_id, error_sig) DO UPDATE SET occurrences = occurrences + 1, last_seen = ?')
    .run(job.id, sig, stamp, stamp)
}

/** 把一批到点时刻记成 missed（一个事务里写完）；返回真正写入的行数。 */
function recordMissed(db, job, moments, note, cap) {
  const stmt = db.prepare(UPSERT_EXEC)
  const stamp = new Date().toISOString()
  const list = moments.slice(0, cap)
  if (!list.length) return 0
  db.exec('BEGIN')
  try {
    for (const d of list) stmt.run(job.id, d.toISOString(), 'missed', 'skipped', note, note, null, stamp)
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw err
  }
  return list.length
}

/** 漏跑通知：同任务有冷却，避免每分钟任务把频道刷满。 */
function missedNotifyAllowed(opts, settings, job, cooldownSec) {
  if (settings.missedNotify === false) return false
  const cooldownMs = Math.max(0, Number(cooldownSec) || 0) * 1000
  const last = missedNotifiedAt.get(job.id) || 0
  if (cooldownMs && Date.now() - last < cooldownMs) return false
  missedNotifiedAt.set(job.id, Date.now())
  return true
}

async function tickOnce(opts) {
  const store = loadStore(opts)
  const now = new Date()
  const settings = loadSettings(opts)
  const tuning = tuningOf(settings.extra, opts)
  const catchUpSec = tuning.catchUpSec
  const staleMs = (opts.timeoutMs || DEFAULTS.timeoutMs) + 120000
  let db
  try {
    db = await openLedger(opts, false)
  } catch (err) {
    return { ran: 0, error: String(err && err.message ? err.message : err) }
  }
  const ran = []
  const dropIds = []
  let missedCount = 0
  try {
    for (const job of store.jobs) {
      if (!job || job.enabled === false) continue
      if (job.schedule && job.schedule.kind === 'once') {
        const one = await runOnceJob(opts, db, job, now)
        if (one) { ran.push(one); if (one.drop) dropIds.push(job.id) }
        continue
      }
      if (!job.no_agent || !job.script) continue
      const expr = job.schedule && job.schedule.expr
      if (!expr) continue
      let cron
      try { cron = parseCron(expr) } catch { continue }
      if (runningJobs.has(job.id)) continue

      const createdMs = Date.parse(job.created_at || '')
      const pending = pendingOccurrences(cron, now, db, job.id, tuning.missedLookbackMinutes, staleMs, createdMs)
      if (!pending.length) continue
      const late = (d) => (now.getTime() - d.getTime()) / 1000

      /* 1) 超出容差的到点时刻：默认只记账 + 通知；开了 missedCatchUpOnce 则保留最近一次真跑 */
      const missed = pending.filter((d) => late(d) > catchUpSec)
      const runnable = pending.filter((d) => late(d) <= catchUpSec)
      /* 容差内没有可跑的，才把最近一次漏跑捞回来补跑；有容差内的就以那一次为准 */
      const rescue = !runnable.length && missed.length && tuning.missedCatchUpOnce === true ? missed[0] : null
      const occ = runnable[0] || rescue
      const beyond = rescue ? missed.slice(1) : missed
      const merged = runnable.slice(1)
      if (beyond.length) {
        const note = '错过到点执行（晚 ' + humanSpan(late(beyond[0])) + '，容差 ' + humanSpan(catchUpSec) + '）'
          + (beyond.length > 1 ? '；本轮共 ' + beyond.length + ' 次没跑' : '')
        missedCount += recordMissed(db, job, beyond, note, tuning.missedBulkCap || DEFAULTS.missedBulkCap)
        ran.push({ id: job.id, instant: beyond[0].toISOString(), status: 'missed', delivery: 'skipped', count: beyond.length })
        if ((job.deliver || settings.discordWebhook) && missedNotifyAllowed(opts, settings, job, tuning.missedNotifyCooldownSec)) {
          const body = '**' + (job.name || job.id) + '** 错过到点执行\n'
            + '- 计划时间：' + fmtLocal(beyond[0]) + '\n'
            + '- 晚了：' + humanSpan(late(beyond[0])) + '（容差 ' + humanSpan(catchUpSec) + '）\n'
            + (beyond.length > 1 ? '- 本轮共 ' + beyond.length + ' 次没跑，已合并记录\n' : '')
            + (rescue ? '- 已补跑最近一次到点：' + fmtLocal(rescue) + '，更早的作废\n'
              : '- 这次没有执行脚本，下一次到点会正常跑；要让晚到也算数就调大容差。')
          const dres = await deliver(opts, { ...job, deliver: job.deliver || ('discord:' + (settings.discordChannel || '')) }, body)
          db.prepare('UPDATE executions SET delivery_outcome = ?, error = ? WHERE job_id = ? AND scheduled_instant = ?')
            .run(dres.outcome, dres.error || null, job.id, beyond[0].toISOString())
          if (dres.outcome === 'failed') recordIncident(db, job, 'missed notify: ' + (dres.error || 'failed'))
        }
      }

      /* 2) 只跑最新一次；更早的合并掉，避免开机后连环补跑 */
      if (!occ) continue
      if (merged.length) {
        const note = '已合并到最近一次补跑（到点 ' + fmtLocal(occ) + '）'
        missedCount += recordMissed(db, job, merged, note, tuning.missedBulkCap || DEFAULTS.missedBulkCap)
      }
      const instant = occ.toISOString()
      runningJobs.add(job.id)
      try {
        db.prepare('INSERT OR REPLACE INTO executions (job_id, scheduled_instant, status, started_at) VALUES (?, ?, ?, ?)')
          .run(job.id, instant, 'running', new Date().toISOString())
        const out = await runScript(opts, job)
        let delivery = { outcome: 'skipped' }
        if (out.ok && (job.deliver || settings.discordWebhook)) {
          delivery = await deliver(opts, job, out.stdout || '')
        }
        const status = out.ok ? 'completed' : 'failed'
        const lateSec = Math.round(late(occ))
        const detail = rescue
          ? '漏跑补跑一次（晚 ' + humanSpan(lateSec) + '，容差 ' + humanSpan(catchUpSec) + '）'
          : (lateSec > 60 ? '晚到执行（晚 ' + humanSpan(lateSec) + '）' : null)
        db.prepare('UPDATE executions SET status = ?, delivery_outcome = ?, error = ?, detail = ?, finished_at = ? WHERE job_id = ? AND scheduled_instant = ?')
          .run(status, delivery.outcome, out.ok ? (delivery.error || null) : (out.error || out.stderr || 'exit ' + out.code), detail, new Date().toISOString(), job.id, instant)
        if (!out.ok) recordIncident(db, job, String(out.error || out.stderr || 'unknown'))
        ran.push({ id: job.id, instant, status, delivery: delivery.outcome, lateSec })
      } finally {
        runningJobs.delete(job.id)
      }
    }
  } finally { try { db.close() } catch { /* ignore */ } }
  /* 一次性任务执行成功即自毁：只摘 jobs.json，账本与 names.json 留作记录 */
  if (dropIds.length) {
    const fresh = loadStore(opts)
    const kept = (fresh.jobs || []).filter((j) => !dropIds.includes(j.id))
    if (kept.length !== (fresh.jobs || []).length) saveJobs(opts, fresh, kept)
  }
  const executed = ran.filter((r) => r.status === 'completed' || r.status === 'failed').length
  return { ran: ran.length, executed, missed: missedCount, detail: ran }
}

function tick(opts) {
  return async () => {
    if (tickState.running) return { ran: 0, busy: true, detail: [], note: '上一次扫描还没结束，已跳过本轮' }
    tickState.running = true
    try {
      return await tickOnce(opts)
    } finally {
      tickState.running = false
    }
  }
}

/* ---------- HTTP ---------- */

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sameOrigin(req) {
  const remote = req.socket && req.socket.remoteAddress ? String(req.socket.remoteAddress) : ''
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  const origin = req.headers.origin
  if (!origin) return true
  try { return new URL(origin).host === host } catch { return false }
}

/** 每个任务最近一条账本记录（按时间取最大，账本的字符串时间格式不一定统一）。 */
function latestByJob(executions) {
  const map = new Map()
  for (const row of executions || []) {
    const t = Date.parse(row.scheduled_instant)
    const key = Number.isFinite(t) ? t : 0
    const prev = map.get(row.job_id)
    if (!prev || key >= prev.key) map.set(row.job_id, { key, row })
  }
  return map
}

/**
 * 用账本回填任务的最近一次执行结果。
 * 事实源 jobs.json 里不写运行态（避免每次 tick 都改任务文件、滚动备份），
 * 面板要的 last_run_at / last_status 一律从账本算。
 */
function withLatestRun(job, index) {
  const hit = index.get(job.id)
  if (!hit) return job
  const row = hit.row
  return {
    ...job,
    last_run_at: row.finished_at || row.started_at || row.scheduled_instant,
    last_status: row.status || null,
    last_delivery_outcome: row.delivery_outcome || null,
    last_detail: row.detail || row.error || null,
  }
}

async function stateOf(opts) {
  const store = loadStore(opts)
  const ledger = await readLedger(opts)
  const settingsNow = loadSettings(opts)
  const jobNames = rememberNames(opts, store.jobs)
  const index = latestByJob(ledger.executions)
  const tuning = tuningOf(settingsNow.extra, opts)
  return {
    ok: true,
    jobsFile: store.file,
    dataHome: dataHomeOf(opts),
    writable: opts.writable !== false,
    jobs: (store.jobs || []).map((job) => withLatestRun(decorate(job), index)),
    jobNames,
    error: store.missing ? '还没有任务文件，新建一条即可' : undefined,
    ledger,
    delivery: {
      webhook: Boolean(settingsNow.discordWebhook),
      token: Boolean(settingsNow.discordToken || process.env.DISCORD_BOT_TOKEN),
    },
    settings: publicSettings(settingsNow),
    tickMs: opts.tickMs || DEFAULTS.tickMs,
    tick: {
      tickMs: opts.tickMs || DEFAULTS.tickMs,
      catchUpSec: tuning.catchUpSec,
      missedNotify: tuning.missedNotify,
      missedNotifyCooldownSec: tuning.missedNotifyCooldownSec,
      missedLookbackMinutes: tuning.missedLookbackMinutes,
      missedCatchUpOnce: tuning.missedCatchUpOnce,
    },
    now: new Date().toISOString(),
  }
}

function saveJobs(opts, store, jobs) {
  const file = store.file || ownFile(opts)
  writeJobFile(file, store.wrapper, jobs)
  rememberNames(opts, jobs)
  return file
}

async function handleWrite(opts, body) {
  if (opts.writable === false) return { ok: false, error: '插件配置 writable: false，当前只读' }
  const store = loadStore(opts)
  const jobs = (store.jobs || []).slice()
  /* 先记一遍现有任务名：删除任务后历史记录仍要显示它的中文名 */
  rememberNames(opts, store.jobs || [])

  if (body.op === 'createJob') {
    const expr = String(body.expr || '').trim()
    try { nextRuns(parseCron(expr), new Date(), 1) } catch (err) {
      return { ok: false, error: 'cron 校验失败：' + String(err && err.message ? err.message : err) }
    }
    const job = {
      id: body.id && String(body.id).trim() || ('job-' + Date.now().toString(36)),
      name: String(body.name || '未命名任务').trim(),
      schedule: { kind: 'cron', expr, display: expr },
      no_agent: true,
      script: String(body.script || '').trim(),
      prompt: '',
      deliver: String(body.deliver || '').trim(),
      enabled: body.enabled !== false,
      created_at: new Date().toISOString(),
    }
    jobs.push(job)
    const where = saveJobs(opts, store, jobs)
    return { ok: true, job: decorate(job), file: where }
  }

  const index = jobs.findIndex((j) => j && j.id === body.id)
  if (index < 0) return { ok: false, error: 'job not found: ' + body.id }
  if (body.op === 'deleteJob') {
    jobs.splice(index, 1)
    saveJobs(opts, store, jobs)
    return { ok: true, deleted: body.id }
  }
  const job = { ...jobs[index] }
  if (body.op === 'setEnabled') {
    job.enabled = body.enabled === true
  } else if (body.op === 'saveJob') {
    if (typeof body.name === 'string' && body.name.trim()) job.name = body.name.trim()
    if (typeof body.expr === 'string' && body.expr.trim()) {
      try { nextRuns(parseCron(body.expr), new Date(), 1) } catch (err) {
        return { ok: false, error: 'cron 校验失败：' + String(err && err.message ? err.message : err) }
      }
      job.schedule = { ...(job.schedule || {}), kind: 'cron', expr: body.expr.trim(), display: body.expr.trim() }
    }
    if (typeof body.deliver === 'string') job.deliver = body.deliver.trim()
    if (typeof body.script === 'string') job.script = body.script.trim()
  } else {
    return { ok: false, error: 'unknown write op: ' + body.op }
  }
  jobs[index] = job
  saveJobs(opts, store, jobs)
  return { ok: true, job: decorate(job) }
}

function route(opts) {
  return async (req, res) => {
    if (!sameOrigin(req)) { sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' }); return }
    try {
      if (req.method === 'GET') {
        const url = new URL(req.url, 'http://localhost')
        const op = url.searchParams.get('op') || 'state'
        if (op === 'state') { sendJson(res, 200, await stateOf(opts)); return }
        if (op === 'tick') { sendJson(res, 200, { ok: true, ...(await tick(opts)()) }); return }
        if (op === 'settings') { sendJson(res, 200, { ok: true, settings: publicSettings(loadSettings(opts)) }); return }
        sendJson(res, 400, { ok: false, error: 'unknown op: ' + op })
        return
      }
      if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'GET/POST only' }); return }
      const raw = await readBody(req)
      const body = raw.trim() ? JSON.parse(raw) : {}
      if (body.op === 'state') { sendJson(res, 200, await stateOf(opts)); return }
      if (body.op === 'tickNow') { sendJson(res, 200, { ok: true, ...(await tick(opts)()) }); return }
      if (body.op === 'runNow') {
        const store = loadStore(opts)
        const job = (store.jobs || []).find((j) => j && j.id === body.id)
        if (!job) { sendJson(res, 404, { ok: false, error: 'job not found: ' + body.id }); return }
        if (!job.no_agent || !job.script) { sendJson(res, 400, { ok: false, error: '只执行脚本型任务（no_agent + script）' }); return }
        /* deliver:true 才投递；不传就是纯本地跑一遍，跟以前一样 */
        const wantDeliver = body.deliver === true || body.deliver === 'true' || body.notify === true
        const startedAt = new Date().toISOString()
        const out = await runScript(opts, job)
        const settings = loadSettings(opts)
        let delivery = null
        if (wantDeliver) {
          const target = String(body.channel || job.deliver || (settings.discordChannel ? 'discord:' + settings.discordChannel : '')).trim()
          const text = out.ok
            ? (out.stdout || '')
            : '**' + (job.name || job.id) + '** 手动执行失败 · exit ' + out.code + '\n' + String(out.error || out.stderr || '').slice(0, 1500)
          delivery = (!target && !settings.discordWebhook)
            ? { outcome: 'skipped', error: '没有配置投递频道' }
            : await deliver(opts, { ...job, deliver: target || job.deliver }, text)
        }
        /* 手动执行也记一笔账：面板「上次执行」不再一直显示无记录。
           时间戳带毫秒，ticker 不会把它当成「这一分钟已经跑过」。 */
        let ledgerError = null
        try {
          const db = await openLedger(opts, false)
          try {
            const instant = new Date().toISOString()
            db.prepare(UPSERT_EXEC).run(
              job.id, instant, out.ok ? 'completed' : 'failed',
              delivery ? delivery.outcome : null,
              out.ok ? (delivery && delivery.error ? delivery.error : null) : String(out.error || out.stderr || 'exit ' + out.code).slice(0, 400),
              '手动执行（立即执行）' + (wantDeliver ? '，投递 ' + (delivery ? delivery.outcome : '未执行') : ''),
              startedAt, new Date().toISOString(),
            )
            if (!out.ok) recordIncident(db, job, String(out.error || out.stderr || 'unknown'))
          } finally { try { db.close() } catch { /* ignore */ } }
        } catch (err) {
          ledgerError = String(err && err.message ? err.message : err)
        }
        sendJson(res, 200, { ...out, delivery, manual: true, ledgerError })
        return
      }
      if (body.op === 'purgeLater') {
        sendJson(res, 200, purgeLater(opts, body))
        return
      }
      if (body.op === 'runPurgeNow') {
        const store = loadStore(opts)
        const job = (store.jobs || []).find((j) => j && j.id === body.id)
        if (!job) { sendJson(res, 404, { ok: false, error: 'job not found: ' + body.id }); return }
        if (!job.cleanup) { sendJson(res, 400, { ok: false, error: '不是自毁任务（没有 cleanup）' }); return }
        let db
        try { db = await openLedger(opts, false) } catch (err) { sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) }); return }
        let out
        try { out = await runOnceJob(opts, db, job, new Date(), { force: true }) } finally { try { db.close() } catch { /* ignore */ } }
        if (out && out.drop) {
          const fresh = loadStore(opts)
          saveJobs(opts, fresh, (fresh.jobs || []).filter((j) => j.id !== job.id))
        }
        sendJson(res, 200, { ok: Boolean(out && out.status === 'completed'), ...out })
        return
      }
      if (body.op === 'saveSettings') {
        sendJson(res, 200, saveSettings(opts, body))
        return
      }
      if (body.op === 'testDeliver') {
        const store = loadStore(opts)
        const fallback = (store.jobs || []).map((j) => j && j.deliver).find((d) => typeof d === 'string' && d)
        sendJson(res, 200, await testDeliver(opts, body.channel || fallback || ''))
        return
      }
      if (['createJob', 'setEnabled', 'saveJob', 'deleteJob'].includes(body.op)) {
        sendJson(res, 200, await handleWrite(opts, body))
        return
      }
      sendJson(res, 400, { ok: false, error: 'unknown op: ' + String(body.op) })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
    }
  }
}

export function apply(ctx, config) {
  const opts = { ...DEFAULTS, ...(config || {}) }
  if (opts.enabled === false) return
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-cron/api',
    handler: route(opts),
  }))
  /* 进程内 ticker：到点就执行，唯一键保证同一分钟只跑一次。 */
  ctx.effect(() => {
    const run = () => { tick(opts)().catch(() => {}) }
    const timer = setInterval(run, opts.tickMs || DEFAULTS.tickMs)
    const boot = setTimeout(run, 3000)
    return () => { clearInterval(timer); clearTimeout(boot) }
  })
}

export const __internals = {
  parseCron, nextRuns, matchesCron, latestOccurrence, stateOf, tick, tickOnce, decorate, loadStore, deliver, chunkText,
  testDeliver, purgeLater, runCleanup, cleanupGuard, runOnceJob, pendingOccurrences, tuningOf, loadSettings, saveSettings,
  withLatestRun, DEFAULTS,
}
