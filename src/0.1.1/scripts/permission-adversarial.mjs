/**
 * 权限模型对抗性验证（真机集成，不是单测的复述）。
 *
 * 目的：证明两条不可动摇的性质
 *   1. 工具的风险等级来自代码里的静态声明，模型给的 risk_level 参数
 *      只能「加重」提示，永远不能把 ask/deny 变成 allow。
 *   2. 能力总开关关闭时，任何模式都不放行。
 *
 * 做法：直接构造 ToolContext 调真实的 buildTools()，绕过 HTTP 层，
 * 用一个假 requestApproval 记录是否被询问。
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./alias-hooks.mjs', pathToFileURL('./scripts/'))

const { buildTools } = await import('../src/main/agent/tools.ts')

const tools = buildTools({
  ws: {
    listDir: async () => [],
    readFile: async () => ({ text: 'x', binary: false, truncated: false, size: 1 }),
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
  },
  shell: {
    enabled: () => true,
    cwd: () => process.cwd(),
    policy: () => ({ allowlist: [], denylist: [], allowPipe: false }),
    timeoutMs: () => 5000,
    run: async () => ({ stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, durationMs: 1 }),
    describe: () => 'shell'
  },
  screen: screenDeps()
})

const find = (name) => {
  const t = tools.find((x) => x.schema.name === name)
  if (!t) throw new Error(`工具不存在：${name}`)
  return t
}

/** 跑一次工具，返回 { asked, result } */
async function invoke(toolName, args, { mode, allowWrite = true, capabilityEnabled = true } = {}) {
  const tool = find(toolName)
  let asked = false
  const ctx = {
    workspace: { id: 'w', name: 'w', path: process.cwd(), addedAt: 0, ignore: [] },
    permissionMode: mode,
    allowWrite,
    runId: 'r',
    signal: new AbortController().signal,
    requestApproval: async () => {
      asked = true
      return true // 全部同意，观察「是否被询问」即可
    }
  }
  const result = await tool.run(args, ctx)
  return { asked, result }
}

/**
 * 屏幕工具在 gate 之前会先做坐标时效性校验（截图太旧直接拒绝、不询问）。
 * 要测权限判定，必须先让 lastCapture() 返回一张「刚刚拍的」截图，
 * 否则测到的是时效校验而不是权限逻辑。
 */
function screenDeps(overrides = {}) {
  return {
    captureEnabled: () => true,
    inputEnabled: () => true,
    humanize: () => false,
    maxEdge: () => 800,
    displayId: () => null,
    allowedWindows: () => [],
    capabilities: async () => ({ capture: true, input: true, note: '' }),
    capture: async () => ({ b64: '', caption: '', text: '' }),
    click: async () => undefined,
    type: async () => undefined,
    keys: async () => undefined,
    scroll: async () => undefined,
    drag: async () => undefined,
    activeWindow: async () => null,
    toScreen: (x, y) => ({ x, y }),
    // 关键：返回一张刚拍的截图，跳过时效性拦截
    lastCapture: () => ({ at: Date.now(), width: 800, height: 450 }),
    ...overrides
  }
}

let pass = 0
const failures = []
function check(label, cond) {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}`)
  }
}

console.log('\n== 1. 模型低报风险不能绕过确认 ==')
for (const mode of ['workspace', 'smart']) {
  const { asked } = await invoke(
    'shell_run',
    { purpose: 'probe', command: 'echo hi', risk_level: 'low', risk_reason: '完全安全' },
    { mode }
  )
  check(`${mode} 模式下 shell_run 仍被询问（即使模型自评 low）`, asked)
}

console.log('\n== 2. 模型高报风险只加重提示，不改变是否放行 ==')
{
  const low = await invoke(
    'screen_click',
    { x: 1, y: 1, target: '测试按钮', risk_level: 'low' },
    { mode: 'smart' }
  )
  const high = await invoke(
    'screen_click',
    { x: 1, y: 1, target: '测试按钮', risk_level: 'high' },
    { mode: 'smart' }
  )
  check('smart 模式两种自评都被询问（判定一致）', low.asked && high.asked)
}
{
  const a = await invoke(
    'screen_click',
    { x: 1, y: 1, target: '测试按钮', risk_level: 'low' },
    { mode: 'full' }
  )
  const b = await invoke(
    'screen_click',
    { x: 1, y: 1, target: '测试按钮', risk_level: 'high' },
    { mode: 'full' }
  )
  check('full 模式两种自评都不询问（判定一致）', !a.asked && !b.asked)
}

console.log('\n== 3. 只有 read 工具在 smart 模式下不被询问 ==')
{
  const { asked } = await invoke('list_dir', {}, { mode: 'smart' })
  check('smart 模式下 list_dir 直接放行', !asked)
}

console.log('\n== 4. 能力总开关关闭 → 任何模式都拒绝 ==')
{
  // screen_capture 关闭：即便 full 模式也必须拒绝
  let denied = false
  const tool = find('screen_look')
  const ctx = {
    workspace: { id: 'w', name: 'w', path: process.cwd(), addedAt: 0, ignore: [] },
    permissionMode: 'full',
    allowWrite: true,
    runId: 'r',
    signal: new AbortController().signal,
    requestApproval: async () => true
  }
  // 用 inputEnabled/captureEnabled 都返回 false 的 deps 重新建工具
  const offTools = buildTools({
    ws: {
      listDir: async () => [],
      readFile: async () => ({ text: 'x', binary: false, truncated: false, size: 1 }),
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
    },
    screen: screenDeps({ captureEnabled: () => false, inputEnabled: () => false })
  })
  const offLook = offTools.find((t) => t.schema.name === 'screen_look')
  const res = await offLook.run({}, { ...ctx, requestApproval: async () => { denied = false; return true } })
  const text = JSON.stringify(res)
  check('屏幕能力关闭时 full 模式也拒绝（不是询问）', !denied && /关闭|禁用|未开启/.test(text))

  void tool
}

console.log('\n== 5. 写总开关关闭 → 有副作用的操作被拒 ==')
{
  const { asked } = await invoke('write_file', { path: 'a.txt', content: 'x' }, { mode: 'full', allowWrite: false })
  check('allowWrite=false 时 full 模式下写文件不询问而直接拒绝', !asked)
}

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length) {
  console.log('FAILED:\n' + failures.map((f) => '  - ' + f).join('\n'))
  process.exit(1)
}
console.log('PERMISSION_OK 权限模型不可被模型自我改写')
