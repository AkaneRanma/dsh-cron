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
  maxLatenessSec: 3600,
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
function loadSettings(opts) {
  const fromConfig = {
    discordToken: String(opts.discordToken || ''),
    discordWebhook: String(opts.discordWebhook || ''),
    discordChannel: String(opts.discordChannel || ''),
    allowedUsers: Array.isArray(opts.allowedUsers) ? opts.allowedUsers.map(String) : [],
  }
  const file = settingsFile(opts)
  if (!existsSync(file)) return { ...fromConfig, file, fromFile: false }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {}
    return {
      discordToken: typeof parsed.discordToken === 'string' ? parsed.discordToken : fromConfig.discordToken,
      discordWebhook: typeof parsed.discordWebhook === 'string' ? parsed.discordWebhook : fromConfig.discordWebhook,
      discordChannel: typeof parsed.discordChannel === 'string' ? parsed.discordChannel : fromConfig.discordChannel,
      allowedUsers: Array.isArray(parsed.allowedUsers) ? parsed.allowedUsers.map(String) : fromConfig.allowedUsers,
      file,
      fromFile: true,
    }
  } catch {
    return { ...fromConfig, file, fromFile: false, broken: true }
  }
}

function saveSettings(opts, body) {
  const current = loadSettings(opts)
  const next = {
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
  if (!next.discordToken && !next.discordWebhook && !next.discordChannel && next.allowedUsers.length === 0) {
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
    const child = spawn(cmd, args, { cwd: dirname(script), windowsHide: true })
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

function tick(opts) {
  return async () => {
    const store = loadStore(opts)
    const now = new Date()
    let db
    try {
      db = await openLedger(opts, false)
    } catch (err) {
      return { ran: 0, error: String(err && err.message ? err.message : err) }
    }
    const ran = []
    const dropIds = []
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
        const occ = latestOccurrence(cron, now, 60 * 24 * 40)
        if (!occ) continue
        const lateness = (now.getTime() - occ.getTime()) / 1000
        if (lateness > (opts.maxLatenessSec || DEFAULTS.maxLatenessSec)) continue
        const instant = occ.toISOString()
        const exists = db.prepare('SELECT 1 FROM executions WHERE job_id = ? AND scheduled_instant = ?').get(job.id, instant)
        if (exists) continue
        db.prepare('INSERT OR IGNORE INTO executions (job_id, scheduled_instant, status, started_at) VALUES (?, ?, ?, ?)')
          .run(job.id, instant, 'running', new Date().toISOString())
        const out = await runScript(opts, job)
        let delivery = { outcome: 'skipped' }
        const runtime = loadSettings(opts)
        if (out.ok && (job.deliver || runtime.discordWebhook)) {
          delivery = await deliver(opts, job, out.stdout || '')
        }
        const status = out.ok ? 'completed' : 'failed'
        db.prepare('UPDATE executions SET status = ?, delivery_outcome = ?, error = ?, finished_at = ? WHERE job_id = ? AND scheduled_instant = ?')
          .run(status, delivery.outcome, out.ok ? (delivery.error || null) : (out.error || out.stderr || 'exit ' + out.code), new Date().toISOString(), job.id, instant)
        if (!out.ok) {
          const sig = String(out.error || out.stderr || 'unknown').slice(0, 160)
          db.prepare('INSERT INTO incidents (job_id, error_sig, occurrences, last_seen) VALUES (?, ?, 1, ?) ON CONFLICT(job_id, error_sig) DO UPDATE SET occurrences = occurrences + 1, last_seen = ?')
            .run(job.id, sig, new Date().toISOString(), new Date().toISOString())
        }
        ran.push({ id: job.id, instant, status, delivery: delivery.outcome })
      }
    } finally { try { db.close() } catch { /* ignore */ } }
    /* 一次性任务执行成功即自毁：只摘 jobs.json，账本与 names.json 留作记录 */
    if (dropIds.length) {
      const fresh = loadStore(opts)
      const kept = (fresh.jobs || []).filter((j) => !dropIds.includes(j.id))
      if (kept.length !== (fresh.jobs || []).length) saveJobs(opts, fresh, kept)
    }
    return { ran: ran.length, detail: ran }
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

async function stateOf(opts) {
  const store = loadStore(opts)
  const ledger = await readLedger(opts)
  const settingsNow = loadSettings(opts)
  const jobNames = rememberNames(opts, store.jobs)
  return {
    ok: true,
    jobsFile: store.file,
    dataHome: dataHomeOf(opts),
    writable: opts.writable !== false,
    jobs: (store.jobs || []).map(decorate),
    jobNames,
    error: store.missing ? '还没有任务文件，新建一条即可' : undefined,
    ledger,
    delivery: {
      webhook: Boolean(settingsNow.discordWebhook),
      token: Boolean(settingsNow.discordToken || process.env.DISCORD_BOT_TOKEN),
    },
    settings: publicSettings(settingsNow),
    tickMs: opts.tickMs || DEFAULTS.tickMs,
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
        sendJson(res, 200, await runScript(opts, job))
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

export const __internals = { parseCron, nextRuns, matchesCron, latestOccurrence, stateOf, tick, decorate, loadStore, deliver, chunkText, testDeliver, purgeLater, runCleanup, cleanupGuard, runOnceJob, DEFAULTS }
