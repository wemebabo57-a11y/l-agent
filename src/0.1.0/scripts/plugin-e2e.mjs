/**
 * 插件系统端到端验证（真实子进程 + 真实 worker.mjs + 真实 manifest 校验）。
 *
 * 覆盖：
 *  1. 安装、清单校验、默认停用
 *  2. 权限 → 工具风险等级推导
 *  3. manifest.tools 并入 runner 工具集，命名空间为 plugin_<id>_<tool>
 *  4. onTool 在子进程里执行并返回结果
 *  5. 宿主桥（api.readFile）双向通信
 *  6. 未声明 ui 权限时面板调用被拒
 *  7. 停用 / 启用后工具集随之变化
 *  8. 未声明 network 权限时 api.fetch 明确报错（不是静默联网）
 *
 * 契约（来自 worker.mjs）：处理函数收到单个对象 { input, api, workspacePath }。
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(tmpdir(), 'lagent-plugin-e2e-'))
process.env.LAGENT_STUB_ELECTRON = '1'
process.env.LAGENT_TEST_USER_DATA = home

register('./alias-hooks.mjs', pathToFileURL('./scripts/'))

const { PluginManager } = await import('../src/main/plugins/index.ts')

let pass = 0
const failures = []
function check(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label + (extra ? `（${extra}）` : ''))
    console.log(`  FAIL ${label} ${extra}`)
  }
}

/**
 * 插件入口：按 worker 契约导出 onTool / onPanel。
 *
 * 两个注意点：
 *  - 工具调用时 input 是 { name, args }（见 plugins/index.ts 的 callPlugin）。
 *  - 面板调用永远走 onPanel 这一个入口，方法名在 input.method 里，
 *    插件需要自己分发——所以这里按 method 分派。
 */
const PLUGIN_SOURCE = `
export function onTool({ input, api }) {
  return {
    calledName: input.name ?? null,
    echoed: (input.args && input.args.text) ?? null,
    pid: process.pid,
    hasRead: api.has('workspace.read')
  }
}

export async function onPanel({ input, api }) {
  const method = input.method
  if (method === 'readProbe') {
    const file = await api.readFile('probe.txt')
    return { text: file.text }
  }
  if (method === 'fetchProbe') {
    try {
      await api.fetch('https://example.com')
      return { fetchAllowed: true }
    } catch (e) {
      return { fetchAllowed: false, error: e.message }
    }
  }
  throw new Error('未知面板方法: ' + method)
}
`

function makePlugin(dir, { name, permissions, description, tools }) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ name, version: '1.0.0', description, main: 'index.mjs', permissions, tools }, null, 2),
    'utf8'
  )
  writeFileSync(path.join(dir, 'index.mjs'), PLUGIN_SOURCE, 'utf8')
}

const wsPath = path.join(home, 'ws')
mkdirSync(wsPath, { recursive: true })
writeFileSync(path.join(wsPath, 'probe.txt'), 'probe-ok', 'utf8')
const ws = { id: 'w', name: 'w', path: wsPath, addedAt: 0, ignore: [] }

const deps = {
  ws: {
    listDir: async () => [],
    readFile: async (_w, rel) => ({
      text: rel === 'probe.txt' ? 'probe-ok' : '',
      binary: false,
      truncated: false,
      size: 8
    }),
    writeFile: async () => ({ size: 1, created: true }),
    search: async () => [],
    collectFiles: async () => []
  },
  maxReadBytes: 1000,
  github: {
    enabled: () => true,
    listDir: async () => [],
    readFile: async () => ({ text: '', binary: false, size: 0, sha: '' }),
    writeFiles: async () => ({ commitSha: 'a', commitUrl: null, branch: 'b' })
  }
}

const mgr = new PluginManager()

console.log('\n== 1. 安装、清单与默认状态 ==')
const src = path.join(home, 'src-demo')
makePlugin(src, {
  name: 'demo',
  description: '演示插件',
  permissions: ['ui', 'workspace.read'],
  tools: [{ name: 'echo', description: '回显输入', parameters: { type: 'object', properties: { text: { type: 'string' } } } }]
})
const installed = await mgr.importFolder(src)
check('安装成功且 id 取自 manifest.name', installed && installed.id === 'demo', JSON.stringify(installed && installed.id))
check('安装后默认停用（需用户显式启用）', installed && installed.enabled === false)
check('权限被记录', Boolean(installed && installed.permissions.includes('workspace.read')))

console.log('\n== 2. 权限 → 风险等级推导 ==')
const meta = (await mgr.list()).find((p) => p.id === 'demo')
check('工具风险由权限推导为 read', meta && meta.toolRisks.echo === 'read', meta ? JSON.stringify(meta.toolRisks) : '')

console.log('\n== 3. 启用后工具并入工具集 ==')
let defs = await mgr.toolDefinitions(deps)
check('停用状态下不注册工具', !defs.some((t) => t.schema.name.includes('demo')))
await mgr.toggle('demo', true)
defs = await mgr.toolDefinitions(deps)
const toolName = 'plugin_demo_echo'
const demoTool = defs.find((t) => t.schema.name === toolName)
check(`工具以 ${toolName} 命名空间注册`, Boolean(demoTool))
check('带静态风险声明', Boolean(demoTool && demoTool.risk === 'read'), demoTool ? demoTool.risk : '')
check('不遮蔽内置工具名', defs.every((t) => !['read_file', 'write_file', 'shell_run', 'list_dir'].includes(t.schema.name)))

console.log('\n== 4. onTool 在子进程里执行 ==')
const ctx = {
  workspace: ws,
  permissionMode: 'full',
  allowWrite: true,
  runId: 'r',
  signal: new AbortController().signal,
  requestApproval: async () => true
}
const toolResult = await demoTool.run({ text: 'hello' }, ctx)
// ToolResult.content 是插件返回值的 JSON 字符串（给人/模型看的），
// 断言前先解析，别把字符串当对象匹配。
check('工具调用成功', toolResult && toolResult.ok === true, JSON.stringify(toolResult).slice(0, 200))
let parsed = null
try {
  parsed = JSON.parse(toolResult.content)
} catch {
  parsed = null
}
check('插件收到 name 与 args', parsed && parsed.calledName === 'echo' && parsed.echoed === 'hello', JSON.stringify(parsed))
check('确为独立子进程', Boolean(parsed && parsed.pid && parsed.pid !== process.pid), parsed ? `plugin pid=${parsed.pid} host pid=${process.pid}` : '')
check('插件拿到的 api 反映了权限', Boolean(parsed && parsed.hasRead === true), JSON.stringify(parsed))

console.log('\n== 5. 宿主桥双向通信 ==')
try {
  const panelRes = await mgr.invoke('demo', 'readProbe', {}, ws, { allowWrite: true, deps })
  check('api.readFile 往返成功', Boolean(panelRes && panelRes.text === 'probe-ok'), JSON.stringify(panelRes))
} catch (e) {
  check('api.readFile 往返成功', false, e.message)
}

console.log('\n== 6. 未声明 network → fetch 明确报错 ==')
try {
  const res = await mgr.invoke('demo', 'fetchProbe', {}, ws, { allowWrite: true, deps })
  check(
    '未声明 network 时 fetch 被拒且原因明确',
    Boolean(res && res.fetchAllowed === false && /network/.test(res.error)),
    JSON.stringify(res)
  )
} catch (e) {
  check('未声明 network 时 fetch 被拒且原因明确', false, e.message)
}

console.log('\n== 7. 未声明 ui 权限 → 面板调用被拒 ==')
const noUiDir = path.join(home, 'src-noui')
makePlugin(noUiDir, {
  name: 'noui',
  description: '无界面插件',
  permissions: ['workspace.read'],
  tools: [{ name: 'echo', description: '回显' }]
})
await mgr.importFolder(noUiDir)
await mgr.toggle('noui', true)
let rejected = false
try {
  await mgr.invoke('noui', 'readProbe', {}, ws, { allowWrite: true, deps })
} catch (e) {
  rejected = /ui/.test(e.message)
}
check('没有 ui 权限时面板调用被拒', rejected)

console.log('\n== 8. 停用后工具消失 ==')
await mgr.toggle('demo', false)
defs = await mgr.toolDefinitions(deps)
check('停用后工具不再注册', !defs.some((t) => t.schema.name === toolName))
await mgr.toggle('demo', true)
defs = await mgr.toolDefinitions(deps)
check('重新启用后工具恢复', defs.some((t) => t.schema.name === toolName))

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length) {
  console.log('FAILED:\n' + failures.map((f) => '  - ' + f).join('\n'))
} else {
  console.log('PLUGIN_OK 插件系统端到端可用')
}
try {
  rmSync(home, { recursive: true, force: true })
} catch {
  /* 忽略 */
}
process.exit(failures.length ? 1 : 0)
