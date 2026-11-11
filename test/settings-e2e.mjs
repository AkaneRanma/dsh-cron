/**
 * 设置端到端：令牌/Webhook/默认频道/白名单 -> 回读（打码）-> 清除 -> names.json 登记。
 * 全部在临时 dataHome 里跑，不碰真实配置，也不真的发 Discord。
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

let handler = null
const dataHome = mkdtempSync(join(tmpdir(), 'cron-settings-'))
mod.apply({
	effect(fn) { return fn() },
	webServer: { register(route) { handler = route.handler; return () => {} } },
}, { enabled: true, writable: true, dataHome, tickMs: 3600000 })

function req(method, body) {
	const r = new EventEmitter()
	r.method = method
	r.url = '/hermes-cron/api'
	r.headers = { host: '127.0.0.1:51023', 'content-type': 'application/json' }
	r.socket = { remoteAddress: '127.0.0.1' }
	if (body !== undefined) {
		const s = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')])
		s.on('data', (x) => r.emit('data', x))
		s.on('end', () => r.emit('end', undefined))
	}
	return r
}
async function hit(method, body) {
	const res = { statusCode: 0, headers: {}, body: '', setHeader() {}, end(b) { this.body = b } }
	await handler(req(method, body), res)
	try { return JSON.parse(res.body) } catch { return { raw: res.body } }
}

let s = await hit('GET')
console.log('S1 初始:', JSON.stringify(s.settings))

const saved = await hit('POST', { op: 'saveSettings', discordToken: 'MTU1MDAwMDAwMDAwMDAwMDAw.GaBbCc.fake-token-value' })
console.log('S2 保存令牌:', saved.ok, '| mask:', saved.settings.tokenMask, '| 文件存在:', existsSync(saved.settings.file))

const withCh = await hit('POST', { op: 'saveSettings', discordChannel: ' 123456789012345678 ' })
console.log('S3 默认频道:', JSON.stringify(withCh.settings.channel))

const withUsers = await hit('POST', { op: 'saveSettings', allowedUsers: ['123456789012345678', ' 42 '] })
console.log('S4 白名单:', JSON.stringify(withUsers.settings.allowedUsers))

const wh = await hit('POST', { op: 'saveSettings', discordWebhook: 'https://discord.com/api/webhooks/1/abc' })
console.log('S5 Webhook:', wh.settings.webhook)

s = await hit('GET')
console.log('S6 状态同步:', 'token=' + s.delivery.token, 'webhook=' + s.delivery.webhook)

const test = await hit('POST', { op: 'testDeliver' })
console.log('S7 假 webhook 测试投递（预期失败但不崩）:', JSON.stringify(test))

/* 建一条任务 + 一条历史记录，验证 names.json 与账本中文名回填 */
await hit('POST', { op: 'createJob', id: 'job-keep', name: '保留的任务', expr: '0 9 * * *', script: 'hello.py' })
const created = await hit('POST', { op: 'createJob', id: 'job-gone', name: '会被删掉的任务', expr: '0 10 * * *', script: 'hello.py' })
console.log('S8 新建:', created.ok)
await hit('POST', { op: 'deleteJob', id: 'job-gone' })
s = await hit('GET')
console.log('S9 删除后 jobNames 仍记住:', JSON.stringify(s.jobNames))

const cleared = await hit('POST', { op: 'saveSettings', discordToken: null })
console.log('S10 清令牌:', 'tokenSaved=' + cleared.settings.tokenSaved, '| 频道保留:', Boolean(cleared.settings.channel))

const allClear = await hit('POST', { op: 'saveSettings', discordToken: null, discordWebhook: null, discordChannel: null, allowedUsers: [] })
console.log('S11 全清:', JSON.stringify(allClear), '| settings.json 已删:', !existsSync(join(dataHome, 'settings.json')))
console.log('    names.json 仍在:', existsSync(join(dataHome, 'names.json')), JSON.stringify(JSON.parse(readFileSync(join(dataHome, 'names.json'), 'utf8'))))

console.log('DONE')
process.exit(0)
