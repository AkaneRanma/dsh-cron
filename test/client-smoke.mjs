/**
 * 客户端半侧冒烟：用假的 window.__ModuleLoader__ 载入 client.js，
 * 以 profile 的 node_modules 解析 react，然后跑 apply()，检查两条 slot 是否注册成功。
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

/* react 由宿主浏览器 bundle 提供，node 侧解析不到：这里用桩替代，只验证模块形状与 apply()。 */
const stubReact = {
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (v) => [v, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	memo: (c) => c,
}
const requireStub = (id) => {
	if (id === 'react') return stubReact
	throw new Error('unexpected require: ' + id)
}

const registrations = []
const effects = []
let loaded = null

const sandbox = {
	window: {
		__ModuleLoader__: {
			load(entry) {
				loaded = entry
				const module = { exports: {} }
				const exportsObj = entry.factory(requireStub)
				sandbox.__plugin = exportsObj
			},
		},
	},
	console,
	document: {
		head: { appendChild() {} },
		createElement: () => ({ dataset: {}, remove() {} }),
		querySelector: () => null,
	},
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
vm.runInContext(code, sandbox, { filename: 'client.js' })

const plugin = sandbox.__plugin
console.log('load called:', Boolean(loaded), '| id:', loaded && loaded.id)
console.log('exports:', Object.keys(plugin).join(','))
console.log('name/inject/apply:', plugin.name, JSON.stringify(plugin.inject), typeof plugin.apply)

const ctx = {
	effect(fn) { const d = fn(); effects.push(typeof d); return () => {} },
	slots: {
		register(meta, component) { registrations.push({ meta, component }); return meta },
		inject(name, fn) { fn() },
	},
	remote: { schedule: { async catalog() { return { ok: true, value: [] } } } },
}
plugin.apply(ctx)
console.log('registered slots:', registrations.map((r) => r.meta.name + (r.meta.key ? ':' + r.meta.key : ':' + r.meta.id)).join(' | '))
console.log('label:', typeof registrations.find((r) => r.meta.name === 'sidebar.panellist').meta.label === 'function'
	? registrations.find((r) => r.meta.name === 'sidebar.panellist').meta.label()
	: '(none)')
console.log('order:', registrations.find((r) => r.meta.name === 'sidebar.panellist').meta.order)
console.log('components are functions:', registrations.every((r) => typeof r.component === 'function' || typeof r.component === 'object'))
console.log('effect disposers:', effects.join(','))

/* 门禁：载入失败、slot 没注册、组件不是函数，都算失败，让 CI 非零退出 */
const ok = Boolean(loaded) && registrations.length === 2 && registrations.every((r) => r.component)
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)