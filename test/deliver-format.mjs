/**
 * 投递格式验证：用真实凭据发一条「脚本原样输出」的样例，确认发出去的是 Markdown 原文
 * （没有整段套代码块），再把消息读回来核对。没配令牌/频道时只验证分片逻辑并跳过发送。
 *
 *   DSH_HOME=~/.dsh  settings.json 里有 discordToken / discordChannel（或 DISCORD_CHANNEL 覆盖）
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)
const { deliver, chunkText } = mod.__internals
const dataHome = process.env.SCHEDULE_DATA_HOME || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'schedule')
const BT = String.fromCharCode(96)
const TICKS = BT + BT + BT

const sample = [
  '🛠 **工具链** · 01-01 12:00 · 上游无新版本',
  '',
  '- ✅ 组件 A ' + BT + 'v1.2.3' + BT + '（本地 ' + BT + '?' + BT + '）',
  '- ✅ 组件 B ' + BT + 'v4.5.6' + BT + '（本地 ' + BT + '4.5.5' + BT + '）',
  '',
  '⚠️ 副本不同步：示例(缺失) · 基准 ' + BT + '1.2.3' + BT,
  '',
  '> ↳ 装前先备份 mods 与配置文件',
].join('\n')

/* 1) 分片逻辑：1800 字上限，超长按行切，且可无损还原 */
const long = Array.from({ length: 120 }, (_, i) => '- 第 ' + (i + 1) + ' 行：' + 'x'.repeat(30)).join('\n')
const parts = chunkText(long, 1800)
console.log('长文本切段:', parts.length, '段，长度', parts.map((p) => p.length).join('/'), '| 每段 <=1800:', parts.every((p) => p.length <= 1800))
console.log('切段可无损还原:', parts.join('\n') === long)

/* 2) 真发一条：有凭据才发 */
const settingsFile = join(dataHome, 'settings.json')
const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {}
const channel = process.env.DISCORD_CHANNEL || settings.discordChannel || ''
const token = process.env.DISCORD_BOT_TOKEN || settings.discordToken || ''
if (!channel || (!token && !settings.discordWebhook)) {
  console.log('跳过实际发送：没有令牌或频道（设置 discordToken + discordChannel，或 DISCORD_BOT_TOKEN / DISCORD_CHANNEL）')
  process.exit(0)
}

const one = await deliver({ dataHome, writable: false }, { id: 'fmt-check', name: '格式验证', deliver: 'discord:' + channel }, sample)
console.log('单条投递:', JSON.stringify(one))

const res = await fetch('https://discord.com/api/v10/channels/' + channel + '/messages?limit=1', {
  headers: { authorization: 'Bot ' + token, 'user-agent': 'DiscordBot (dsh-corn)' },
  signal: AbortSignal.timeout(15000),
})
const list = await res.json()
const content = String((list[0] || {}).content || '')
console.log('--- 频道最后一条（前 160 字）')
console.log(JSON.stringify(content.slice(0, 160)))
console.log('还套着代码块?', content.includes(TICKS), '| 首行是脚本自己的标题?', content.startsWith('🛠 **工具链**'))
process.exit(0)