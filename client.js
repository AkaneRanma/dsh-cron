/**
 * dsh-hermes-cron —— 浏览器半侧：侧栏「定时任务」入口 + 整页面板（任务 / 消息平台两页）。
 *
 * 数据来自宿主路由 /hermes-cron/api。任务事实源是 <DSH_HOME>/schedule/jobs.json，
 * 消息平台设置存 <DSH_HOME>/schedule/settings.json（面板保存即生效，不用重启）。
 */

window.__ModuleLoader__.load({
	id: 'dsh-hermes-cron',
	factory(require) {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		const h = React.createElement
		const { useState, useEffect, useCallback, useMemo } = React

		const PANEL_ID = 'hermes-cron'
		const PANEL_LABEL = '定时任务'
		const API = '/hermes-cron/api'

		const CSS = [
			'.hcr_page{padding:18px 22px;overflow:auto;height:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary)}',
			'.hcr_head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:12px}',
			'.hcr_title{font-size:16px;font-weight:600}',
			'.hcr_sub{color:var(--dsw-alias-label-tertiary);font-size:12px;word-break:break-all}',
			'.hcr_tabs{display:flex;gap:4px;margin:0 0 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
			'.hcr_tab{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;padding:6px 12px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}',
			'.hcr_tab:hover{color:var(--dsw-alias-label-primary)}',
			'.hcr_tab_on{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-state-business-primary)}',
			'.hcr_btn{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);padding:3px 9px;font-size:12px;cursor:pointer;white-space:nowrap}',
			'.hcr_btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary)}',
			'.hcr_btn:disabled{opacity:.45;cursor:default}',
			'.hcr_btn_primary{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
			'.hcr_card{border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:11px 13px;margin-bottom:9px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 96%,var(--dsw-alias-label-primary) 4%)}',
			'.hcr_card_off{opacity:.62}',
			'.hcr_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
			'.hcr_name{font-weight:600;font-size:13px}',
			'.hcr_id{color:var(--dsw-alias-label-tertiary);font-size:11px;font-family:ui-monospace,Consolas,monospace}',
			'.hcr_in{font-family:ui-monospace,Consolas,monospace;font-size:12px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 80%,#000 20%);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;color:var(--dsw-alias-label-primary);padding:3px 6px}',
			'.hcr_meta{color:var(--dsw-alias-label-tertiary);font-size:11.5px;margin-top:5px;display:flex;gap:12px;flex-wrap:wrap}',
			'.hcr_chip{font-size:11px;padding:0 6px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}',
			'.hcr_chip_ok{border-color:var(--dsw-alias-state-success-primary,#3fbf7f);color:var(--dsw-alias-state-success-primary,#3fbf7f)}',
			'.hcr_ok{color:var(--dsw-alias-state-success-primary,#3fbf7f)}',
			'.hcr_bad{color:var(--dsw-alias-state-error-primary,#e5534b)}',
			'.hcr_banner{border:1px solid var(--dsw-alias-state-business-primary);border-radius:var(--dsw-radius-md);padding:9px 12px;margin:10px 0;font-size:12.5px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
			'.hcr_tbl{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}',
			'.hcr_tbl th{text-align:left;color:var(--dsw-alias-label-tertiary);font-weight:500;padding:4px 8px 4px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
			'.hcr_tbl td{padding:4px 8px 4px 0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 55%,transparent);vertical-align:top}',
			'.hcr_sec{margin-top:18px}',
			'.hcr_sec_title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);margin-bottom:6px}',
			'.hcr_pre{white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Consolas,monospace;font-size:11.5px;max-height:200px;overflow:auto;background:color-mix(in srgb,var(--dsw-alias-bg-base) 80%,#000 20%);border-radius:4px;padding:7px 9px;margin-top:6px}',
			'.hcr_err{color:var(--dsw-alias-state-error-primary,#e5534b);font-size:12px;margin:6px 0}',
			'.hcr_empty{color:var(--dsw-alias-label-tertiary);font-size:12.5px}',
			'.hcr_form{border:1px dashed var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:10px 12px;margin-bottom:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
			'.hcr_field{margin:14px 0}',
			'.hcr_label{font-size:12.5px;font-weight:600;margin-bottom:2px;display:flex;gap:8px;align-items:center}',
			'.hcr_hint{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.55;margin-bottom:6px}',
			'.hcr_input_row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
			'.hcr_full{flex:1;min-width:260px}',
			'.hcr_tag{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:1px 8px;font-size:11.5px;font-family:ui-monospace,Consolas,monospace}',
			'.hcr_x{cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1}',
			'.hcr_x:hover{color:var(--dsw-alias-state-error-primary,#e5534b)}',
		].join('')

		const PLATFORM_HINT = '保存后立刻生效，不用重启。凭据落在 <DSH_HOME>/schedule/settings.json，明文保存，只有本机能读。'

		const STATUS_LABEL = {
			claimed: '领取中', running: '执行中', completed: '成功', failed: '失败',
			unknown: '未知', cancelled: '已取消', missed: '错过',
		}
		const DELIVERY_LABEL = {
			delivered: '已送达', skipped: '未配置频道', failed: '发送失败', pending: '待发送', ok: '已送达',
		}
		const BAD_STATUS = { failed: true, missed: true }
		const BAD_DELIVERY = { failed: true }

		function zhStatus(v) { return STATUS_LABEL[v] || (v ? String(v) : '—') }
		function zhDelivery(v) { return DELIVERY_LABEL[v] || (v ? String(v) : '—') }

		/** 老记录里 hermes 写的英文错误也翻一下，翻不出来的原样显示。 */
		function zhError(text) {
			const s = String(text || '').trim()
			if (!s) return '—'
			const missed = s.match(/^missed ×(d+) (collapsed into one catch-up run)$/i)
			if (missed) return '错过 ×' + missed[1] + '（已合并为一次补跑）'
			if (/^no delivery target$/i.test(s)) return '没有配置投递频道'
			return s.slice(0, 120)
		}

		function fmtTime(iso) {
			if (!iso) return '—'
			const d = new Date(iso)
			if (Number.isNaN(d.getTime())) return String(iso)
			const pad = (n) => String(n).padStart(2, '0')
			return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
				pad(d.getHours()) + ':' + pad(d.getMinutes())
		}

		async function call(method, body) {
			const res = method === 'GET'
				? await fetch(API + '?op=state', { headers: { accept: 'application/json' } })
				: await fetch(API, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
			return await res.json()
		}

		const ctxRef = { current: null }

		const Icon = React.memo(function CronIcon() {
			return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' }, [
				h('circle', { key: 'c', cx: 8, cy: 8.4, r: 5.6, stroke: 'currentColor', strokeWidth: 1.3 }),
				h('path', { key: 'a', d: 'M8 5.2V8.6l2.4 1.5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
				h('path', { key: 'b', d: 'M3.4 3.6 2 5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
			])
		})

		/* ---------- 任务页 ---------- */

		function JobCard({ job, lastStatus, writable, onChanged, onToast }) {
			const [expr, setExpr] = useState(job.schedule?.expr || '')
			const [name, setName] = useState(job.name || '')
			const [script, setScript] = useState(job.script || '')
			const [busy, setBusy] = useState(false)
			const [output, setOutput] = useState(null)
			const dirty = expr !== (job.schedule?.expr || '') || name !== (job.name || '') || script !== (job.script || '')

			const run = async (kind, payload) => {
				setBusy(true)
				try {
					const out = await call('POST', payload || { op: kind, id: job.id })
					if (!out.ok) onToast((kind === 'runNow' ? '执行失败：' : '操作失败：') + (out.error || 'exit ' + out.code), true)
					else if (kind === 'runNow') { setOutput(out); onToast('执行完成，exit 0，' + out.ms + 'ms') }
					else { onToast('已保存'); onChanged() }
					return out
				} catch (err) {
					onToast('请求失败：' + String(err && err.message ? err.message : err), true)
				} finally { setBusy(false) }
			}

			return h('div', { className: 'hcr_card' + (job.enabled ? '' : ' hcr_card_off') }, [
				h('div', { key: 'row', className: 'hcr_row' }, [
					h('span', { key: 'n', className: 'hcr_name' }, job.name || job.id),
					h('span', { key: 'i', className: 'hcr_id' }, job.id),
					h('input', {
						key: 'e', className: 'hcr_in', style: { width: 118 }, value: expr, spellCheck: false,
						title: 'cron：分 时 日 月 周', onChange: (e) => setExpr(e.target.value),
					}),
					job.no_agent
						? h('input', {
							key: 's', className: 'hcr_in', style: { width: 160 }, value: script, spellCheck: false,
							title: '脚本路径（相对 schedule 目录或绝对路径）', onChange: (e) => setScript(e.target.value),
						})
						: h('span', { key: 's', className: 'hcr_chip' }, 'agent 型（需 gateway）'),
					h('button', { key: 't', className: 'hcr_btn', disabled: busy || !writable, onClick: () => run('setEnabled', { op: 'setEnabled', id: job.id, enabled: !job.enabled }) }, job.enabled ? '停用' : '启用'),
					h('button', { key: 'v', className: 'hcr_btn hcr_btn_primary', disabled: busy || !writable || !dirty, onClick: () => run('saveJob', { op: 'saveJob', id: job.id, name, expr, script }) }, '保存'),
					job.no_agent && job.script
						? h('button', { key: 'r', className: 'hcr_btn', disabled: busy, onClick: () => run('runNow') }, '立即执行')
						: null,
					h('button', { key: 'd', className: 'hcr_btn', disabled: busy || !writable, onClick: () => run('deleteJob') }, '删除'),
				]),
				h('div', { key: 'meta', className: 'hcr_meta' }, [
					h('span', { key: 'x' }, '下次 ' + fmtTime((job.nextRuns || [])[0])),
					h('span', { key: 'y' }, '再下次 ' + fmtTime((job.nextRuns || [])[1])),
					h('span', { key: 'l' }, '上次 ' + fmtTime(job.last_run_at)),
					h('span', { key: 'dl' }, '投递 ' + (job.deliver || '—')),
					h('span', { key: 'st', className: lastStatus === 'failed' ? 'hcr_bad' : lastStatus ? 'hcr_ok' : '' }, '上次执行 ' + (lastStatus ? zhStatus(lastStatus) : '无记录')),
					job.nextRunsError ? h('span', { key: 'e', className: 'hcr_bad' }, job.nextRunsError) : null,
				]),
				output ? h('div', { key: 'out' }, h('div', { className: 'hcr_pre' }, (output.stdout || '') + (output.stderr ? '\n[stderr]\n' + output.stderr : ''))) : null,
			])
		}

		function NewJob({ onCreate, onToast }) {
			const [open, setOpen] = useState(false)
			const [name, setName] = useState('')
			const [expr, setExpr] = useState('0 9 * * *')
			const [script, setScript] = useState('')
			const [deliver, setDeliver] = useState('')
			if (!open) return h('button', { className: 'hcr_btn', onClick: () => setOpen(true) }, '+ 新建任务')
			const submit = async () => {
				const out = await call('POST', { op: 'createJob', name, expr, script, deliver })
				if (!out.ok) onToast('创建失败：' + out.error, true)
				else { onToast(out.note || ('已创建 ' + out.job.id)); setOpen(false); setName(''); setScript(''); onCreate() }
			}
			return h('div', { className: 'hcr_form' }, [
				h('input', { key: 'n', className: 'hcr_in', placeholder: '名称', value: name, onChange: (e) => setName(e.target.value) }),
				h('input', { key: 'e', className: 'hcr_in', placeholder: 'cron', value: expr, onChange: (e) => setExpr(e.target.value) }),
				h('input', { key: 's', className: 'hcr_in', placeholder: '脚本 例 scripts\\hello.py', value: script, onChange: (e) => setScript(e.target.value) }),
				h('input', { key: 'd', className: 'hcr_in', placeholder: '投递 discord:频道ID（可空）', value: deliver, onChange: (e) => setDeliver(e.target.value) }),
				h('button', { key: 'ok', className: 'hcr_btn hcr_btn_primary', onClick: submit }, '创建'),
				h('button', { key: 'no', className: 'hcr_btn', onClick: () => setOpen(false) }, '取消'),
			])
		}

		function TasksPage({ state, onChanged, onToast }) {
			const [native, setNative] = useState(null)
			const lastByJob = useMemo(() => {
				const map = {}
				for (const row of (state.ledger?.executions || [])) if (!map[row.job_id]) map[row.job_id] = row.status
				return map
			}, [state])
			const nameById = useMemo(() => {
				/* 以任务名登记表打底：任务被删掉后，历史记录里仍显示它当初的中文名 */
				const map = Object.assign({}, state.jobNames || {})
				for (const job of (state.jobs || [])) if (job.name) map[job.id] = job.name
				return map
			}, [state])

			useEffect(() => {
				let alive = true
				const go = async () => {
					try {
						const remote = ctxRef.current && ctxRef.current.remote
						const out = remote && remote.schedule && remote.schedule.catalog ? await remote.schedule.catalog() : null
						if (!alive) return
						const value = out && out.ok ? out.value : null
						const list = Array.isArray(value) ? value : (value && Array.isArray(value.tasks) ? value.tasks : null)
						setNative(list ? list.length : null)
					} catch { if (alive) setNative(null) }
				}
				go()
				return () => { alive = false }
			}, [])

			const jobs = state.jobs || []
			const execs = (state.ledger?.executions || []).slice(0, 15)
			const writable = state.writable

			return h('div', null, [
				h('div', { key: 'chips', className: 'hcr_head' }, [
					h('span', { key: 'c', className: 'hcr_chip' }, jobs.filter((j) => j.enabled).length + ' / ' + jobs.length + ' 启用'),
					h('span', { key: 'n', className: 'hcr_chip' }, native === null ? '原生自动化任务：未取到' : '原生自动化任务：' + native + ' 条'),
					h('span', { key: 's', className: 'hcr_chip' }, state.source === 'own' ? '自有调度内核' : '继承 hermes（只读源）'),
					h('span', { key: 'd', className: state.delivery && (state.delivery.token || state.delivery.webhook) ? 'hcr_chip hcr_chip_ok' : 'hcr_chip' },
						state.delivery && (state.delivery.token || state.delivery.webhook) ? 'Discord 已连接' : 'Discord 未配置'),
					h('button', { key: 'k', className: 'hcr_btn', onClick: async () => { const o = await call('POST', { op: 'tickNow' }); onToast('检查完成：跑了 ' + (o.ran || 0) + ' 条'); onChanged() } }, '立刻检查一次'),
				]),
				h('div', { key: 'sub', className: 'hcr_sub' }, '任务文件 ' + state.jobsFile),
				state.source === 'hermes'
					? h('div', { key: 'banner', className: 'hcr_banner' }, [
						h('span', { key: 't' }, '当前展示的是 hermes 的旧任务文件，本面板只读它、不执行它。卸载 hermes 后这里就空了。'),
						h('button', {
							key: 'i', className: 'hcr_btn hcr_btn_primary', disabled: !writable,
							onClick: async () => {
								const out = await call('POST', { op: 'importHermes' })
								if (!out.ok) onToast('接管失败：' + out.error, true)
								else { onToast(out.note || ('已接管 ' + out.imported + ' 条任务')); onChanged() }
							},
						}, '接管为我的任务'),
					])
					: null,
				h('div', { key: 'jobs', className: 'hcr_sec' }, [
					h('div', { key: 'title', className: 'hcr_sec_title' }, '任务（ticker 每 ' + Math.round((state.tickMs || 20000) / 1000) + 's 扫一次）'),
					writable ? h(NewJob, { key: 'new', onCreate: onChanged, onToast }) : null,
					jobs.length === 0
						? h('div', { key: 'empty', className: 'hcr_empty' }, '还没有任务，点上面新建一条')
						: jobs.map((job) => h(JobCard, { key: job.id, job, lastStatus: lastByJob[job.id], writable, onChanged, onToast })),
				]),
				h('div', { key: 'execs', className: 'hcr_sec' }, [
					h('div', { key: 'title', className: 'hcr_sec_title' }, '最近执行'),
					execs.length === 0
						? h('div', { key: 'empty', className: 'hcr_empty' }, state.ledger?.error || '无记录')
						: h('table', { key: 'tbl', className: 'hcr_tbl' }, [
							h('thead', { key: 'h' }, h('tr', null, [
								h('th', { key: 'a' }, '到点时间'), h('th', { key: 'b' }, '任务'),
								h('th', { key: 'c' }, '状态'), h('th', { key: 'd' }, '投递'), h('th', { key: 'e' }, '错误'),
							])),
							h('tbody', { key: 'b' }, execs.map((row, i) => h('tr', { key: i }, [
								h('td', { key: 'a' }, fmtTime(row.scheduled_instant)),
								h('td', { key: 'b' }, nameById[row.job_id] || h('span', { className: 'hcr_id', title: row.job_id }, '已删除的任务')),
								h('td', { key: 'c', className: BAD_STATUS[row.status] ? 'hcr_bad' : '' }, zhStatus(row.status)),
								h('td', { key: 'd', className: BAD_DELIVERY[row.delivery_outcome] ? 'hcr_bad' : '' }, zhDelivery(row.delivery_outcome)),
								h('td', { key: 'e' }, zhError(row.error)),
							]))),
						]),
				]),
			])
		}

		/* ---------- 消息平台页 ---------- */

		function PlatformPage({ state, onChanged, onToast }) {
			const settings = state.settings || {}
			const [token, setToken] = useState('')
			const [editingToken, setEditingToken] = useState(false)
			const [webhook, setWebhook] = useState(settings.webhook || '')
			const [channel, setChannel] = useState(settings.channel || '')
			const [userInput, setUserInput] = useState('')
			const [users, setUsers] = useState(settings.allowedUsers || [])
			const [busy, setBusy] = useState(false)

			useEffect(() => {
				setWebhook(settings.webhook || '')
				setChannel(settings.channel || '')
				setUsers(settings.allowedUsers || [])
			}, [settings.webhook, settings.channel, JSON.stringify(settings.allowedUsers || [])])

			const save = async (patch) => {
				setBusy(true)
				try {
					const out = await call('POST', Object.assign({ op: 'saveSettings' }, patch))
					if (!out.ok) onToast('保存失败：' + out.error, true)
					else { onToast('已保存，立即生效'); setEditingToken(false); setToken(''); onChanged() }
				} catch (err) { onToast('请求失败：' + String(err && err.message ? err.message : err), true) } finally { setBusy(false) }
			}

			const saveToken = () => {
				if (!token.trim()) { onToast('令牌是空的', true); return }
				save({ discordToken: token.trim() })
			}
			const clearToken = () => save({ discordToken: null })
			const saveWebhook = () => save({ discordWebhook: webhook.trim() })
			const addUser = () => {
				const v = userInput.trim()
				if (!v) return
				const next = users.includes(v) ? users : users.concat([v])
				setUsers(next); setUserInput('')
				save({ allowedUsers: next })
			}
			const removeUser = (v) => {
				const next = users.filter((x) => x !== v)
				setUsers(next)
				save({ allowedUsers: next })
			}

			const test = async () => {
				setBusy(true)
				try {
					const out = await call('POST', { op: 'testDeliver' })
					if (out.ok) onToast('测试消息已发出 → 频道 ' + out.channel + '（HTTP ' + out.status + '）')
					else onToast('发送失败：' + out.error, true)
				} finally { setBusy(false) }
			}

			return h('div', null, [
				h('div', { key: 'hint', className: 'hcr_hint' }, PLATFORM_HINT),
				h('div', { key: 'discord', className: 'hcr_card' }, [
					h('div', { key: 't', className: 'hcr_row' }, [
						h('span', { key: 'n', className: 'hcr_name' }, 'Discord'),
						h('span', { key: 's', className: 'hcr_chip' + (settings.tokenSaved || settings.webhook ? ' hcr_chip_ok' : '') },
							settings.tokenSaved ? 'Bot 令牌已保存' : settings.webhook ? '仅 Webhook' : '未配置'),
					]),
					h('div', { key: 'h2', className: 'hcr_hint' }, '任务执行完把 stdout 发到任务里填的频道（deliver = discord:频道ID）；也可以只配 Webhook，直连频道。'),

					h('div', { key: 'tok', className: 'hcr_field' }, [
						h('div', { key: 'l', className: 'hcr_label' }, [
							h('span', { key: 'a' }, 'Bot 令牌'),
							settings.tokenSaved ? h('span', { key: 'b', className: 'hcr_chip hcr_chip_ok' }, '已保存') : null,
						]),
						h('div', { key: 'g', className: 'hcr_hint' }, '在 Discord 开发者门户创建应用、添加 Bot，复制其令牌。'),
						settings.tokenSaved && !editingToken
							? h('div', { key: 'row', className: 'hcr_input_row' }, [
								h('span', { key: 'm', className: 'hcr_id' }, settings.tokenMask || '••••'),
								h('button', { key: 'e', className: 'hcr_btn', onClick: () => setEditingToken(true) }, '更换'),
								h('button', { key: 'c', className: 'hcr_btn', disabled: busy, onClick: clearToken }, '清除'),
							])
							: h('div', { key: 'row', className: 'hcr_input_row' }, [
								h('input', {
									key: 'i', className: 'hcr_in hcr_full', type: 'password', value: token, spellCheck: false,
									placeholder: '粘贴 Bot 令牌', onChange: (e) => setToken(e.target.value),
								}),
								h('button', { key: 's', className: 'hcr_btn hcr_btn_primary', disabled: busy, onClick: saveToken }, '保存'),
								settings.tokenSaved ? h('button', { key: 'x', className: 'hcr_btn', onClick: () => { setEditingToken(false); setToken('') } }, '取消') : null,
							]),
					]),

					h('div', { key: 'wh', className: 'hcr_field' }, [
						h('div', { key: 'l', className: 'hcr_label' }, 'Webhook（可选，优先于 Bot 令牌）'),
						h('div', { key: 'g', className: 'hcr_hint' }, '频道设置 → 整合 → Webhook → 复制 URL。配了它就不用令牌。'),
						h('div', { key: 'row', className: 'hcr_input_row' }, [
							h('input', {
								key: 'i', className: 'hcr_in hcr_full', value: webhook, spellCheck: false,
								placeholder: 'https://discord.com/api/webhooks/…', onChange: (e) => setWebhook(e.target.value),
							}),
							h('button', { key: 's', className: 'hcr_btn hcr_btn_primary', disabled: busy, onClick: saveWebhook }, '保存'),
							webhook ? h('button', { key: 'c', className: 'hcr_btn', disabled: busy, onClick: () => { setWebhook(''); save({ discordWebhook: null }) } }, '清除') : null,
						]),
					]),

					h('div', { key: 'ch', className: 'hcr_field' }, [
						h('div', { key: 'l', className: 'hcr_label' }, '默认频道 ID'),
						h('div', { key: 'g', className: 'hcr_hint' }, '任务没填 deliver 时发到这里；「发送测试消息」也用它。取法：Discord 设置里开开发者模式，右键频道 → 复制频道 ID。'),
						h('div', { key: 'row', className: 'hcr_input_row' }, [
							h('input', {
								key: 'i', className: 'hcr_in', style: { width: 220 }, value: channel, spellCheck: false,
								placeholder: '123456789012345678', onChange: (e) => setChannel(e.target.value),
							}),
							h('button', { key: 's', className: 'hcr_btn hcr_btn_primary', disabled: busy, onClick: () => save({ discordChannel: channel.trim() }) }, '保存'),
							settings.channel ? h('button', { key: 'c', className: 'hcr_btn', disabled: busy, onClick: () => { setChannel(''); save({ discordChannel: null }) } }, '清除') : null,
						]),
					]),

					h('div', { key: 'usr', className: 'hcr_field' }, [
						h('div', { key: 'l', className: 'hcr_label' }, '允许的用户 ID（可选）'),
						h('div', { key: 'g', className: 'hcr_hint' }, '只记下这份白名单，供以后接双向消息时用；投递不受它影响。'),
						h('div', { key: 'row', className: 'hcr_input_row' }, users.map((u) => h('span', { key: u, className: 'hcr_tag' }, [
							u, h('span', { key: 'x', className: 'hcr_x', onClick: () => removeUser(u) }, '×'),
						]))),
						h('div', { key: 'add', className: 'hcr_input_row', style: { marginTop: 6 } }, [
							h('input', {
								key: 'i', className: 'hcr_in', style: { width: 200 }, value: userInput, spellCheck: false,
								placeholder: '123456789012345678', onChange: (e) => setUserInput(e.target.value),
							}),
							h('button', { key: 'a', className: 'hcr_btn', onClick: addUser }, '+ 添加'),
						]),
					]),

					h('div', { key: 'act', className: 'hcr_row', style: { marginTop: 12 } }, [
						h('button', { key: 't', className: 'hcr_btn hcr_btn_primary', disabled: busy, onClick: test }, '发送测试消息'),
						h('span', { key: 'f', className: 'hcr_id' }, settings.file || ''),
					]),
				]),
				h('div', { key: 'other', className: 'hcr_card' }, [
					h('div', { key: 't', className: 'hcr_name' }, '其它平台'),
					h('div', { key: 'h', className: 'hcr_hint' }, '目前只接了 Discord。加别的平台（飞书、Telegram、企业微信）就是再写一个投递分支，投递层只有 postJson 一处。'),
				]),
			])
		}

		function CronPage() {
			const [state, setState] = useState(null)
			const [error, setError] = useState(null)
			const [tab, setTab] = useState('tasks')
			const [toast, setToast] = useState(null)

			const load = useCallback(async () => {
				try {
					const out = await call('GET')
					if (!out.ok) { setError(out.error || '读取失败'); return }
					setError(null); setState(out)
				} catch (err) { setError(String(err && err.message ? err.message : err)) }
			}, [])

			useEffect(() => { load() }, [load])

			const onToast = useCallback((message, bad) => {
				setToast({ message, bad })
				setTimeout(() => setToast(null), 4000)
			}, [])

			if (error) return h('div', { className: 'hcr_page' }, h('div', { className: 'hcr_err' }, error))
			if (!state) return h('div', { className: 'hcr_page' }, h('div', { className: 'hcr_empty' }, '读取中…'))

			return h('div', { className: 'hcr_page' }, [
				h('div', { key: 'h', className: 'hcr_head' }, [
					h('span', { key: 't', className: 'hcr_title' }, PANEL_LABEL),
					h('button', { key: 'r', className: 'hcr_btn', onClick: load }, '刷新'),
					toast ? h('span', { key: 'toast', className: toast.bad ? 'hcr_err' : 'hcr_meta' }, toast.message) : null,
				]),
				h('div', { key: 'tabs', className: 'hcr_tabs' }, [
					h('button', { key: 't1', className: 'hcr_tab' + (tab === 'tasks' ? ' hcr_tab_on' : ''), onClick: () => setTab('tasks') }, '任务'),
					h('button', { key: 't2', className: 'hcr_tab' + (tab === 'platform' ? ' hcr_tab_on' : ''), onClick: () => setTab('platform') }, '消息平台'),
				]),
				tab === 'tasks'
					? h(TasksPage, { key: 'tasks', state, onChanged: load, onToast })
					: h(PlatformPage, { key: 'platform', state, onChanged: load, onToast }),
			])
		}

		const inject = ['slots']

		function apply(ctx) {
			ctxRef.current = ctx
			ctx.effect(() => {
				if (typeof document === 'undefined') return () => {}
				const tagId = 'dsh-hermes-cron/panel.css'
				if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return () => {}
				const tag = document.createElement('style')
				tag.dataset.plugin = 'dsh-hermes-cron'
				tag.dataset.pluginCss = tagId
				tag.textContent = CSS
				document.head.appendChild(tag)
				return () => tag.remove()
			})
			ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, CronPage))
			ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
				name: 'sidebar.panellist',
				id: PANEL_ID,
				order: 11,
				label: () => PANEL_LABEL,
			}, Icon))
		}

		exports.name = 'dsh-hermes-cron'
		exports.inject = inject
		exports.apply = apply
		return module.exports
	},
})