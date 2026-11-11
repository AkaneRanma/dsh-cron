#!/usr/bin/env node
/**
 * 一次性自毁任务的快捷通道：一条命令建好，不必开面板。
 *
 *   node bin/purge-later.mjs --after 120 --note "临时测试夹具" "E:\workplace\tmp\x.ps1"
 *   node bin/purge-later.mjs --after-hours 8 "E:\workplace\_archive\2026-11-12-shots"
 *   node bin/purge-later.mjs --list            # 还有哪些等着销毁、最近销毁过什么
 *
 * 省略 --after 时用配置里的 purgeDefaultMinutes（默认 120）。
 * 只接受绝对路径；盘符根、用户主目录、DSH_HOME、schedule 目录本身一律拒绝。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const I = mod.__internals

function parseArgs(argv) {
  const out = { paths: [], after: null, note: '', dataHome: '', list: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--after') { out.after = Number(argv[++i]); continue }
    if (a === '--after-hours') { out.after = Number(argv[++i]) * 60; continue }
    if (a === '--note') { out.note = String(argv[++i] || ''); continue }
    if (a === '--data-home') { out.dataHome = String(argv[++i] || ''); continue }
    if (a === '--list') { out.list = true; continue }
    if (a === '--json') { out.json = true; continue }
    if (a === '-h' || a === '--help') { out.help = true; continue }
    out.paths.push(a)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(readFileSync(new URL('./purge-later.help.txt', import.meta.url), 'utf8'))
  process.exit(0)
}

const opts = { ...I.DEFAULTS, dataHome: args.dataHome || '' }

if (args.list) {
  const store = I.loadStore(opts)
  const view = await I.stateOf(opts)
  const pending = (store.jobs || []).filter((j) => j.schedule && j.schedule.kind === 'once')
  const records = ((view.ledger && view.ledger.executions) || []).filter((r) => String(r.job_id || '').startsWith('purge-')).slice(0, 10)
  if (args.json) { console.log(JSON.stringify({ pending, records }, null, 2)); process.exit(0) }
  console.log('== 待销毁 ' + pending.length + ' 条 ==')
  for (const job of pending) {
    const at = new Date(job.schedule.at)
    const left = Math.round((at.getTime() - Date.now()) / 60000)
    console.log('  ' + job.id + '  ' + (job.name || '') + '\n     到点 ' + at.toLocaleString('zh-CN') + '（' + (left >= 0 ? left + ' 分钟后' : '已到点待执行') + '）\n     路径 ' + ((job.cleanup && job.cleanup.paths) || []).join(' · '))
  }
  console.log('\n== 最近销毁 ' + records.length + ' 条 ==')
  for (const row of records) {
    console.log('  ' + row.scheduled_instant + '  ' + row.status + '  ' + String(row.detail || '').slice(0, 80))
  }
  process.exit(0)
}

if (!args.paths.length) {
  console.error('用法：node bin/purge-later.mjs --after 120 --note "说明" <绝对路径> [更多路径...] ｜ --list 查待销毁')
  process.exit(2)
}

const input = { paths: args.paths, note: args.note, afterMinutes: args.after === null ? undefined : args.after }
const made = I.purgeLater(opts, input)
if (args.json) { console.log(JSON.stringify(made, null, 2)); process.exit(made.ok ? 0 : 1) }
if (!made.ok) { console.error('建任务失败：' + made.error); process.exit(1) }
console.log('已建一次性销毁任务 ' + made.job.id)
console.log('  到点 ' + new Date(made.at).toLocaleString('zh-CN') + '（' + made.afterMinutes + ' 分钟后）')
console.log('  路径 ' + made.paths.join(' · '))
console.log('  任务文件 ' + made.file)
console.log('面板「一次性清理」页可以看待销毁与执行记录；取消：删掉该任务或面板点取消。')
