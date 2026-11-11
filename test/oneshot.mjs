/**
 * 一次性自毁任务：建 → 未到点不跑 → 到点删路径 → 摘任务 → 账本留记录。
 *   node test/oneshot.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const I = mod.__internals

const dataHome = mkdtempSync(join(tmpdir(), 'cron-once-'))
const opts = { ...I.DEFAULTS, dataHome, writable: true, tickMs: 3600000 }

const file = join(dataHome, 'scratch.txt')
const dir = join(dataHome, 'shots')
mkdirSync(dir, { recursive: true })
writeFileSync(file, 'x'.repeat(2048))
writeFileSync(join(dir, 'a.png'), 'y'.repeat(1024))

const made = I.purgeLater(opts, { paths: [file, dir], afterMinutes: 0.03, note: '测试夹具' })
console.log('P1 建任务:', made.ok, made.job.id, '| at:', made.at, '| paths:', made.paths.length)
if (!made.ok) process.exit(1)

let t = await I.tick(opts)()
console.log('P2 未到点 ran:', t.ran, '(期望 0)')

await new Promise((r) => setTimeout(r, 2600))
t = await I.tick(opts)()
console.log('P3 到点 ran:', t.ran, '|', JSON.stringify(t.detail))
console.log('P4 路径已删:', !existsSync(file), !existsSync(dir))
console.log('P5 jobs.json 已摘:', I.loadStore(opts).jobs.length, '(期望 0)')

const st = await I.stateOf(opts)
const row = (st.ledger.executions || [])[0] || {}
console.log('P6 账本记录:', row.job_id, '|', row.status, '|', String(row.detail || '').slice(0, 60))
console.log('P7 名字仍可查:', st.jobNames[made.job.id])

t = await I.tick(opts)()
console.log('P8 再 tick 不重复:', t.ran, '(期望 0)')

console.log('P9 守卫:', JSON.stringify([
  I.cleanupGuard('C:\\'),
  I.cleanupGuard('relative\\x.txt'),
  I.cleanupGuard(dataHome, opts),
  I.cleanupGuard(join(dataHome, 'ok.txt'), opts),
]))

const bad = I.purgeLater(opts, { paths: ['relative.txt'], afterMinutes: 5 })
console.log('P10 相对路径被拒:', bad.ok === false, bad.error)

const parked = I.purgeLater(opts, { paths: [join(dataHome, 'later.log')], afterMinutes: 60, note: '待执行' })
const st2 = await I.stateOf(opts)
const pending = st2.jobs.filter((j) => j.kind === 'once')
console.log('P11 待执行任务在 state:', pending.length, '|', pending[0] && pending[0].name, '| 倒计时秒:', pending[0] && pending[0].dueInSec)
console.log('P12 记录里能认出一次性任务:', (st2.ledger.executions || []).filter((x) => String(x.job_id).startsWith('purge-')).length)
