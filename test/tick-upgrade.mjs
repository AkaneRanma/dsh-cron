/**
 * ticker 升级 + runNow 投递开关的离线验收（不碰真实 Discord、不碰真实 dataHome）。
 * 用本地 HTTP 捕获服务器冒充 Discord webhook。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

let handler = null
function boot(opts) {
  mod.apply({
    effect(fn) { return fn() },
    webServer: { register(route) { handler = route.handler; return () => {} } },
  }, opts)
  return handler
}

function req(method, query, body) {
  const r = new EventEmitter()
  r.method = method
  r.url = '/dsh-cron/api' + (query || '')
  r.headers = { host: '127.0.0.1:52391', 'content-type': 'application/json' }
  r.socket = { remoteAddress: '127.0.0.1' }
  if (body !== undefined) {
    const s = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')])
    s.on('data', (c) => r.emit('data', c))
    s.on('end', () => r.emit('end', undefined))
  }
  return r
}

async function hit(method, query, body) {
  const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b } }
  await handler(req(method, query, body), res)
  try { return JSON.parse(res.body) } catch { return { raw: res.body } }
}

/* ---------- 冒充 Discord 的捕获服务器 ---------- */
const posts = []
const hooks = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    posts.push({ path: req.url, auth: req.headers.authorization || null, body })
    res.statusCode = 204
    res.end()
  })
})
await new Promise((r) => hooks.listen(0, '127.0.0.1', r))
const hookUrl = 'http://127.0.0.1:' + hooks.address().port + '/hook'

let fails = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra === undefined ? '' : '  ' + (typeof extra === 'string' ? extra : JSON.stringify(extra))))
  if (!cond) fails += 1
}

/* ---------- 夹具 ---------- */
const dataHome = mkdtempSync(join(tmpdir(), 'cron-tick-'))
mkdirSync(join(dataHome, 'scripts'), { recursive: true })
const counter = join(dataHome, 'runs.log')
writeFileSync(join(dataHome, 'scripts', 'hello.py'), [
  'import sys, time, os',
  'with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runs.log"), "a", encoding="utf-8") as f:',
  '    f.write("run\\n")',
  'print("**夹具输出** fixture ok " + time.strftime("%H:%M:%S"))',
].join('\n'))
writeFileSync(join(dataHome, 'scripts', 'slow.py'), [
  'import sys, time, os',
  'time.sleep(3)',
  'with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runs.log"), "a", encoding="utf-8") as f:',
  '    f.write("slow\\n")',
  'print("slow done")',
].join('\n'))
writeFileSync(join(dataHome, 'settings.json'), JSON.stringify({
  discordWebhook: hookUrl,
  catchUpSec: 300,
  missedNotify: true,
  missedNotifyCooldownSec: 600,
}), 'utf8')

boot({ enabled: true, writable: true, dataHome, tickMs: 3600000, pythonCommand: 'python' })

const lines = () => existsSync(counter) ? readFileSync(counter, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean) : []
const runs = () => lines().length
const ledger = async (jobId) => {
  const st = await hit('GET')
  return (st.ledger.executions || []).filter((r) => r.job_id === jobId)
}
const jobsFile = () => join(dataHome, 'jobs.json')
/* 生效中的任务文件是事实源：直接改它来模拟「这任务几天前就建好了」 */
function patchStoredJob(jobId, patch) {
  const raw = JSON.parse(readFileSync(jobsFile(), 'utf8').replace(/^\uFEFF/, ''))
  const list = Array.isArray(raw) ? raw : raw.jobs
  const j = list.find((x) => x.id === jobId)
  Object.assign(j, patch)
  writeFileSync(jobsFile(), JSON.stringify(raw, null, 2))
}
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()

/* ---------- 1. runNow 不投递（兼容旧行为） ---------- */
const c1 = await hit('POST', '', { op: 'createJob', name: '手动任务', expr: '0 4 1 1 *', script: 'scripts/hello.py', deliver: 'discord:0' })
const job1 = c1.job.id
const before1 = posts.length
const r1 = await hit('POST', '', { op: 'runNow', id: job1 })
ok('1a runNow 不传 deliver 不投递', posts.length === before1, 'posts +' + (posts.length - before1))
ok('1b runNow 仍返回 stdout', r1.ok === true && r1.code === 0 && String(r1.stdout || '').includes('夹具输出'))
ok('1c runNow 不传 deliver 时 delivery=null', r1.delivery === null)
await new Promise((r) => setTimeout(r, 120))
const rows1 = await ledger(job1)
ok('1d 手动执行也进账本', rows1.length === 1 && rows1[0].status === 'completed', rows1[0] && rows1[0].status)
ok('1e 手动记录不占「到点」位（带毫秒）', rows1.length === 1 && Date.parse(rows1[0].scheduled_instant) % 60000 !== 0)

/* ---------- 2. runNow + deliver:true 真投递 ---------- */
const before2 = posts.length
const r2 = await hit('POST', '', { op: 'runNow', id: job1, deliver: true })
await new Promise((r) => setTimeout(r, 150))
ok('2a deliver:true 触发投递', posts.length === before2 + 1, 'posts +' + (posts.length - before2))
ok('2b 投递内容是脚本 stdout', posts.length > before2 && JSON.parse(posts[posts.length - 1].body).content.includes('夹具输出'))
ok('2c 返回 delivery.outcome=delivered', r2.delivery && r2.delivery.outcome === 'delivered', r2.delivery)
const rows2 = await ledger(job1)
ok('2d 账本记录投递结果', rows2.some((r) => r.delivery_outcome === 'delivered'))

/* ---------- 3. tick 到点执行一次 + 不重复 ---------- */
const c3 = await hit('POST', '', { op: 'createJob', name: '每分钟', expr: '* * * * *', script: 'scripts/hello.py', deliver: 'discord:0' })
const job3 = c3.job.id
const before3 = posts.length
const t1 = await hit('POST', '', { op: 'tickNow' })
const t2 = await hit('POST', '', { op: 'tickNow' })
await new Promise((r) => setTimeout(r, 150))
ok('3a 首次 tick 执行了该任务', (t1.detail || []).some((d) => d.id === job3 && d.status === 'completed'), JSON.stringify(t1.detail))
ok('3b 同一分钟第二次 tick 不重复执行', (t2.detail || []).every((d) => d.id !== job3), t2.ran)
ok('3c 到点执行有投递', posts.length === before3 + 1, 'posts +' + (posts.length - before3))

/* ---------- 4. 超出容差 -> 记 missed + 只通知一次，且不跑脚本 ---------- */
const missHour = pad((now.getHours() + 21) % 24) // 3 小时前的那个钟点
const c4 = await hit('POST', '', { op: 'createJob', name: '漏跑任务', expr: pad(now.getMinutes()) + ' ' + missHour + ' * * *', script: 'scripts/hello.py', deliver: 'discord:0' })
const job4 = c4.job.id
/* 这个任务「4 小时前就建好了」，所以 3 小时前那次到点确实算错过 */
patchStoredJob(job4, { created_at: new Date(Date.now() - 4 * 3600 * 1000).toISOString() })
const runsBefore4 = runs()
const postsBefore4 = posts.length
const t4 = await hit('POST', '', { op: 'tickNow' })
await new Promise((r) => setTimeout(r, 200))
const rows4 = await ledger(job4)
ok('4a 越界时刻记成 missed', rows4.length > 0 && rows4.every((r) => r.status === 'missed'), rows4.map((r) => r.status).join(','))
ok('4b 漏跑不执行脚本', runs() === runsBefore4)
ok('4c 漏跑发了通知', posts.length === postsBefore4 + 1, 'posts +' + (posts.length - postsBefore4))
ok('4d 通知正文说明错过', posts.length > postsBefore4 && JSON.parse(posts[posts.length - 1].body).content.includes('错过到点执行'))
ok('4e tick 汇总带 missed 计数', (t4.missed || 0) > 0, t4.missed)
const t5 = await hit('POST', '', { op: 'tickNow' })
ok('4f 重复 tick 不会重复记漏跑/通知', (t5.missed || 0) === 0 && posts.length === postsBefore4 + 1, 'missed=' + t5.missed + ' posts+' + (posts.length - postsBefore4))

/* ---------- 5. 容差内 -> 补跑一次，并把更早的合并 ---------- */
const c5 = await hit('POST', '', { op: 'createJob', name: '补跑任务', expr: '0 0 1 1 *', script: 'scripts/hello.py', deliver: 'discord:0' })
const job5 = c5.job.id
await toolsPatch(job5)
patchStoredJob(job5, { created_at: new Date(Date.now() - 10 * 60000).toISOString() })
const t6 = await hit('POST', '', { op: 'tickNow' })
const rows5 = await ledger(job5)
ok('5a 容差内补跑 completed', rows5.some((r) => r.status === 'completed'), rows5.map((r) => r.status + '/' + (r.detail || '')).join(' | '))
ok('5b 补跑记录标了晚到', rows5.some((r) => r.status === 'completed' && String(r.detail || '').includes('晚到')))

/* 把 job5 的 expr 改成「2 分钟前的同一钟点」，让 tick 能匹配到并补跑 */
async function toolsPatch(jobId) {
  const at = new Date(Date.now() - 2 * 60000)
  const out = await hit('POST', '', { op: 'saveJob', id: jobId, expr: pad(at.getMinutes()) + ' ' + pad(at.getHours()) + ' * * *' })
  if (!out.ok) throw new Error('saveJob failed: ' + JSON.stringify(out))
}

/* ---------- 6. 并发 tick 不重复执行 ---------- */
const c6 = await hit('POST', '', { op: 'createJob', name: '慢脚本', expr: '* * * * *', script: 'scripts/slow.py', deliver: 'discord:0' })
const job6 = c6.job.id
const slowBefore = lines().filter((x) => x === 'slow').length
const [p1, p2] = await Promise.all([mod.__internals.tick({ enabled: true, writable: true, dataHome, tickMs: 3600000, pythonCommand: 'python' })(), mod.__internals.tick({ enabled: true, writable: true, dataHome, tickMs: 3600000, pythonCommand: 'python' })()])
const slowAfter = lines().filter((x) => x === 'slow').length
ok('6a 并发 tick 有一次被挡下', Boolean(p1.busy) !== Boolean(p2.busy), JSON.stringify([p1.busy || false, p2.busy || false]))
ok('6b 慢脚本只跑了一次', slowAfter - slowBefore === 1, 'delta=' + (slowAfter - slowBefore))

/* ---------- 7. state 暴露调度参数与运行态 ---------- */
const st = await hit('GET')
ok('7a state.tick.catchUpSec 来自 settings.json', st.tick && st.tick.catchUpSec === 300, st.tick)
ok('7b state.jobs 带 last_status', st.jobs.every((j) => !j.last_status || typeof j.last_status === 'string'))
ok('7c publicSettings 透出容差', st.settings && st.settings.catchUpSec === 300)
const j3 = st.jobs.find((j) => j.id === job3)
ok('7d 任务带 last_run_at/last_status', Boolean(j3 && j3.last_run_at && j3.last_status === 'completed'), j3 && { at: j3.last_run_at, s: j3.last_status })

/* ---------- 8. saveSettings 不洗掉未知键 ---------- */
writeFileSync(join(dataHome, 'settings.json'), JSON.stringify({ discordWebhook: hookUrl, catchUpSec: 60, someFutureKey: 'keep-me' }), 'utf8')
const saved = await hit('POST', '', { op: 'saveSettings', discordChannel: '123' })
const after = JSON.parse(readFileSync(join(dataHome, 'settings.json'), 'utf8'))
ok('8a 保存设置保留未知键', after.someFutureKey === 'keep-me', Object.keys(after).join(','))
ok('8b 保存设置写入频道', after.discordChannel === '123')

hooks.close()
console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED')
process.exit(fails === 0 ? 0 : 1)