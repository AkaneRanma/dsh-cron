/**
 * 端到端验证（不依赖 DSH）：
 *   A. 自己的事实源：新建任务 -> tick 执行 -> 账本落库 -> 再 tick 不重复执行
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

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
  r.url = '/dsh-corn/api' + (query || '')
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

/* ---------- A. 自己的事实源 ---------- */
const dataHome = mkdtempSync(join(tmpdir(), 'cron-own-'))
mkdirSync(join(dataHome, 'scripts'), { recursive: true })
writeFileSync(join(dataHome, 'scripts', 'hello.py'), 'import sys\nprint("cron fixture ok", sys.version.split()[0])\n')
boot({ enabled: true, writable: true, dataHome, tickMs: 3600000, pythonCommand: 'python', maxLatenessSec: 600 })
console.log('A1 route:', typeof handler === 'function')

let st = await hit('GET')
console.log('A2 初始:', 'jobs:', st.jobs.length, '| dataHome:', st.dataHome)

const created = await hit('POST', '', { op: 'createJob', name: '夹具任务', expr: '* * * * *', script: 'scripts/hello.py', deliver: 'discord:0' })
console.log('A3 新建:', created.ok, created.job && created.job.id, '| next:', created.job && (created.job.nextRuns || [])[0])
console.log('   落盘:', JSON.parse(readFileSync(join(dataHome, 'jobs.json'), 'utf8')).jobs.length, '条')

const badCron = await hit('POST', '', { op: 'createJob', name: 'x', expr: '61 * * * *', script: 'scripts/hello.py' })
console.log('A4 非法 cron 被拒:', badCron.ok === false, badCron.error)

const t1 = await hit('POST', '', { op: 'tickNow' })
console.log('A5 tick#1 ran:', t1.ran, JSON.stringify(t1.detail))
const t2 = await hit('POST', '', { op: 'tickNow' })
console.log('A6 tick#2 ran:', t2.ran, '(应为 0，同一分钟不重复执行)')

st = await hit('GET')
const row = (st.ledger.executions || [])[0]
console.log('A7 账本:', JSON.stringify(row), '| 投递配置:', JSON.stringify(st.delivery))

const run = await hit('POST', '', { op: 'runNow', id: created.job.id })
console.log('A8 手动执行:', JSON.stringify({ ok: run.ok, code: run.code, stdout: (run.stdout || '').trim() }))

const off = await hit('POST', '', { op: 'setEnabled', id: created.job.id, enabled: false })
const t3 = await hit('POST', '', { op: 'tickNow' })
console.log('A9 停用后 tick ran:', t3.ran, '| enabled=', off.job.enabled)

/* apply 里挂了 setInterval，测试进程要主动退出，否则永远不会结束。 */
console.log('DONE')
process.exit(0)
