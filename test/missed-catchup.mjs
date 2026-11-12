/**
 * missedCatchUpOnce 验收：超出容差的到点不整批作废，每轮只补跑最近一次。
 * 全程离线：本地 HTTP 捕获服务器冒充 Discord，dataHome 用临时目录。
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
const hooks = createServer((rq, rs) => {
  let b = ''
  rq.on('data', (c) => { b += c })
  rq.on('end', () => { posts.push(b); rs.statusCode = 204; rs.end() })
})
await new Promise((r) => hooks.listen(0, '127.0.0.1', r))
const hookUrl = 'http://127.0.0.1:' + hooks.address().port + '/hook'

let fails = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra)))
  if (!cond) fails += 1
}

/* ---------- 夹具 ---------- */
const dataHome = mkdtempSync(join(tmpdir(), 'cron-catchup-'))
mkdirSync(join(dataHome, 'scripts'), { recursive: true })
const counter = join(dataHome, 'runs.log')
writeFileSync(join(dataHome, 'scripts', 'hello.py'), [
  'import os',
  'p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runs.log")',
  'open(p, "a", encoding="utf-8").write("run\\n")',
  'print("**catchup fixture** ok")',
].join('\n'))
writeFileSync(join(dataHome, 'settings.json'), JSON.stringify({
  discordWebhook: hookUrl,
  catchUpSec: 1,                 /* 1 秒容差：几分钟前的到点必然超容差 */
  missedNotify: true,
  missedNotifyCooldownSec: 0,
}), 'utf8')

boot({ enabled: true, writable: true, dataHome, tickMs: 3600000, pythonCommand: 'python' })

const runs = () => existsSync(counter) ? readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0
const jobsFile = () => join(dataHome, 'jobs.json')
function patchStoredJob(id, patch) {
  const raw = JSON.parse(readFileSync(jobsFile(), 'utf8'))
  const list = Array.isArray(raw) ? raw : raw.jobs
  Object.assign(list.find((x) => x.id === id), patch)
  writeFileSync(jobsFile(), JSON.stringify(raw, null, 2))
}
const rowsOf = async (id) => (await hit('GET')).ledger.executions.filter((r) => r.job_id === id)

/* ---------- 1. 开启：超容差只补跑最近一次 ---------- */
const s1 = await hit('POST', '', { op: 'saveSettings', missedCatchUpOnce: true })
ok('1a 开关写入 settings', s1.ok === true && s1.settings.missedCatchUpOnce === true, s1.settings && s1.settings.missedCatchUpOnce)

const c1 = await hit('POST', '', { op: 'createJob', name: '补跑夹具', expr: '* * * * *', script: 'scripts/hello.py', deliver: 'discord:0' })
const job1 = c1.job.id
patchStoredJob(job1, { created_at: new Date(Date.now() - 5 * 60000).toISOString() })
await hit('POST', '', { op: 'tickNow' })
await new Promise((r) => setTimeout(r, 300))

const rows1 = await rowsOf(job1)
const done1 = rows1.filter((r) => r.status === 'completed' || r.status === 'failed')
const miss1 = rows1.filter((r) => r.status === 'missed')
ok('1b 只真跑一次', runs() === 1, 'runs=' + runs())
ok('1c 一条执行 + 其余记错过', done1.length === 1 && miss1.length >= 3, { done: done1.length, missed: miss1.length })
ok('1d 执行记录标明漏跑补跑', String(done1[0] && done1[0].detail || '').includes('漏跑补跑一次'), done1[0] && done1[0].detail)
ok('1e 脚本输出只投递一次', posts.filter((p) => String(p).includes('catchup fixture')).length === 1, posts.length)
ok('1f 补跑不发「错过到点执行」通知', posts.filter((p) => String(p).includes('错过到点执行')).length === 0, posts.length)

/* ---------- 2. 再扫一次不会重复补跑 ---------- */
await hit('POST', '', { op: 'tickNow' })
await new Promise((r) => setTimeout(r, 300))
ok('2a 第二轮不再补跑', runs() === 1, 'runs=' + runs())

/* ---------- 3. 关闭：回到「超过容差一律只记账」 ---------- */
const s3 = await hit('POST', '', { op: 'saveSettings', missedCatchUpOnce: false })
ok('3a 关闭生效', s3.settings.missedCatchUpOnce === false)

const c3 = await hit('POST', '', { op: 'createJob', name: '不补跑夹具', expr: '* * * * *', script: 'scripts/hello.py', deliver: 'discord:0' })
const job3 = c3.job.id
patchStoredJob(job3, { created_at: new Date(Date.now() - 5 * 60000).toISOString() })
const before3 = runs()
await hit('POST', '', { op: 'tickNow' })
await new Promise((r) => setTimeout(r, 300))
const rows3 = await rowsOf(job3)
ok('3b 关闭时一次都不跑', runs() === before3, 'runs=' + runs())
ok('3c 全部记错过', rows3.length > 0 && rows3.every((r) => r.status === 'missed'), rows3.map((r) => r.status))
ok('3d 没补跑时才发「错过到点执行」通知', posts.filter((p) => String(p).includes('错过到点执行')).length === 1, posts.filter((p) => String(p).includes('错过到点执行')).length)

console.log(fails === 0 ? 'ALL PASS' : 'FAILS=' + fails)
hooks.close()
process.exit(fails === 0 ? 0 : 1)
