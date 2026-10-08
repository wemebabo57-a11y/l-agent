/**
 * 打包产物实测：直接启动 dist/win-unpacked/lagent.exe，用 CDP 检查真实界面。
 *
 * 这一步不能省。打包跟 `npm run smoke` 走的路径不同：
 * - 入口从 out/main/index.js 换成 resources/app/out/main/index.js
 * - 插件 worker 的 __dirname 解析、renderer 的 file:// 加载路径都变了
 * - 一旦 asar 或 files 配置有误，只有真跑起来才会暴露
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
// 默认测免安装目录；用 LAGENT_PKG_EXE 可以指向真实安装后的位置
// （Inno Setup 装出来的目录结构相同，但确认一次才算真的验过安装包）
const EXE =
  process.env.LAGENT_PKG_EXE ||
  path.join(ROOT, 'dist', 'win-unpacked', process.platform === 'win32' ? 'lagent.exe' : 'lagent')
const PORT = Number(process.env.LAGENT_PKG_PORT || 9341)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(EXE)) {
  console.error(`[pkg-smoke] 找不到打包产物: ${EXE}\n先跑 npm run dist`)
  process.exit(2)
}

// 应用根目录：<安装目录>/resources/app —— 由 exe 位置反推，两种布局都适用
const APP_DIR = path.join(path.dirname(EXE), 'resources', 'app')

const USER_DATA = mkdtempSync(path.join(tmpdir(), 'lagent-pkg-'))
console.log('[pkg-smoke] 被测程序:', EXE)

/**
 * 预置一个插件，用来验证**打包后**插件宿主进程能否被真的 spawn 起来。
 * 这是打包路径上最脆弱的一环：宿主用 __dirname 拼 worker.mjs 的绝对路径，
 * asar 一开就会 ENOENT，而"插件列表为空"是看不出这个问题的。
 * 插件目录布局与 src/main/plugins/index.ts 保持一致：
 *   <userData>/data/plugins.json  +  <userData>/data/plugins/<dirName>/
 */
function seedPlugin() {
  const dataDir = path.join(USER_DATA, 'data')
  const dirName = 'smoke-aaaaaaaa'
  const pluginDir = path.join(dataDir, 'plugins', dirName)
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    path.join(pluginDir, 'manifest.json'),
    JSON.stringify(
      {
        name: 'smoke',
        version: '1.0.0',
        description: '打包自检插件',
        main: 'index.mjs',
        // ui 权限是走 plugins.invoke() 的前提（见 plugins/index.ts:360）
        permissions: ['ui'],
        tools: [{ name: 'ping', description: '返回 pid，证明子进程真的起来了' }]
      },
      null,
      2
    ),
    'utf8'
  )
  // 返回 process.pid，用于确认这是独立子进程而不是宿主自己算出来的
  writeFileSync(
    path.join(pluginDir, 'index.mjs'),
    'export function onTool({ input }) {\n' +
      "  return { pong: true, pid: process.pid, echoed: (input.args && input.args.text) ?? null }\n" +
      '}\n\n' +
      'export function onPanel({ input }) {\n' +
      "  if (input.method === 'ping') return { pong: true, pid: process.pid };\n" +
      "  throw new Error('未知面板方法: ' + input.method)\n" +
      '}\n',
    'utf8'
  )
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    path.join(dataDir, 'plugins.json'),
    JSON.stringify(
      [
        {
          id: 'smoke',
          name: 'smoke',
          version: '1.0.0',
          description: '打包自检插件',
          enabled: true,
          permissions: ['ui'],
          tools: ['ping'],
          toolRisks: { ping: 'read' },
          hasPanel: true,
          installedAt: Date.now(),
          sizeBytes: 0,
          source: 'folder',
          error: null,
          dirName,
          main: 'index.mjs',
          panel: null,
          toolSchemas: [
            {
              name: 'plugin_smoke_ping',
              description: '返回 pid',
              parameters: { type: 'object', properties: { text: { type: 'string' } } }
            }
          ]
        }
      ],
      null,
      2
    ),
    'utf8'
  )
}
seedPlugin()
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
env.LAGENT_USER_DATA = USER_DATA

console.log('[pkg-smoke] 启动', EXE)
const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
const logs = []
child.stdout.on('data', (d) => logs.push(String(d)))
child.stderr.on('data', (d) => logs.push(String(d)))

let ws
let failed = false
const fail = (msg) => {
  failed = true
  console.error('[pkg-smoke] ✗', msg)
}
const ok = (msg) => console.log('[pkg-smoke] ✓', msg)

try {
  let target
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`进程提前退出，exit=${child.exitCode}`)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (target) break
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  if (!target) throw new Error('60 次轮询后仍没有可调试的页面')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')))
  })

  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id != null && pending.has(m.id)) {
      pending.get(m.id)(m.result)
      pending.delete(m.id)
    }
  })
  const ev = (expression) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, (r) =>
        resolve(r.exceptionDetails ? { __err: r.exceptionDetails.text } : r.result.value)
      )
      ws.send(
        JSON.stringify({
          id: i,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    })

  // 等 preload 桥接就绪
  let bridged = false
  for (let i = 0; i < 40; i++) {
    if (await ev('typeof window.lagent === "object"')) {
      bridged = true
      break
    }
    await sleep(500)
  }
  if (!bridged) fail('window.lagent 未就绪：preload 没加载成功')
  else ok('preload contextBridge 就绪')

  // 页面真实渲染
  const info = await ev(`(() => ({
    title: document.title,
    url: location.href,
    navItems: document.querySelectorAll('.nav-item').length,
    hasTopbar: !!document.querySelector('.topbar'),
    hasSidebar: !!document.querySelector('.sidebar'),
    reactMounted: !!document.querySelector('#root')?.children.length,
    bodyText: (document.body.innerText || '').slice(0, 120)
  }))()`)
  console.log('[pkg-smoke] 页面信息:', JSON.stringify(info))
  if (!info || info.__err) fail('页面求值失败: ' + JSON.stringify(info))
  else {
    if (!info.reactMounted) fail('React 没有挂载（#root 为空）')
    else ok('React 已挂载')
    if (info.navItems !== 7) fail(`导航项数量异常: ${info.navItems}（期望 7）`)
    else ok('侧栏 7 个导航项齐全')
    if (!info.hasTopbar || !info.hasSidebar) fail('顶栏或侧栏缺失')
    else ok('布局结构完整')
    if (!info.url.startsWith('file://')) fail('renderer 不是从 file:// 加载: ' + info.url)
    else ok('renderer 通过 file:// 正常加载')
  }

  // 主进程 IPC 真的通：读一次设置。
  // settings.get() 跟其它 IPC 一样返回 {ok, value}，取 .value。
  const settingsRes = await ev('window.lagent.settings.get()')
  if (!settingsRes || settingsRes.__err || !settingsRes.ok) {
    fail('settings.get() 失败: ' + JSON.stringify(settingsRes).slice(0, 200))
  } else if (typeof settingsRes.value?.permissionMode !== 'string') {
    fail('settings.value 里没有 permissionMode: ' + JSON.stringify(settingsRes.value).slice(0, 160))
  } else if (typeof settingsRes.value.screenCapture !== 'boolean') {
    // 再抽查一个字段，确认拿到的是完整设置对象而不是残缺的
    fail('设置对象字段不全: ' + Object.keys(settingsRes.value).slice(0, 20).join(','))
  } else {
    ok(`IPC 双向可用（permissionMode=${settingsRes.value.permissionMode}）`)
  }

  // 屏幕能力探测：验证主进程的平台模块在打包后能正常加载
  // 注意真实 API 是 screen.list()，它同时返回显示器、平台能力与前台窗口
  const caps = await ev('window.lagent.screen.list()')
  if (!caps || caps.__err || !caps.ok) {
    fail('screen.list() 失败: ' + JSON.stringify(caps).slice(0, 300))
  } else {
    const v = caps.value
    const c = v.capabilities
    ok(
      `屏幕能力探测可用（显示器 ${v.displays.length} 个，截图=${
        c ? c.capture === true || c.capture === 'ok' || !!c.capture : '?'
      }）`
    )
  }

  // 插件系统：预置了一个启用的插件，list() 能看到它
  const plugins = await ev('window.lagent.plugins.list()')
  if (!plugins || plugins.__err || !plugins.ok) {
    fail('plugins.list() 失败: ' + JSON.stringify(plugins).slice(0, 300))
  } else {
    const found = plugins.value.find((p) => p.id === 'smoke')
    if (!found) fail('预置插件没有被读取到: ' + JSON.stringify(plugins.value))
    else if (!found.enabled) fail('预置插件应为启用状态')
    else ok(`插件索引可读（${plugins.value.length} 个，smoke.enabled=${found.enabled}）`)
  }

  // 真正跑一次插件面板调用：这一步才会 spawn worker.mjs 子进程。
  // 打包后 __dirname 解析到 resources/app/out/main，asar 若开启就会 ENOENT。
  // 权限为 ui → 风险 read，因此不会触发审批弹窗。
  const invoked = await ev("window.lagent.plugins.invoke('smoke', 'ping', {})")
  if (!invoked || invoked.__err || !invoked.ok) {
    fail('插件子进程调用失败: ' + JSON.stringify(invoked).slice(0, 300))
  } else {
    const v = invoked.value
    if (!v || v.pong !== true) fail('插件没有返回预期结果: ' + JSON.stringify(v).slice(0, 200))
    else if (v.pid === process.pid) fail('插件返回的 pid 与父进程相同，可能没真的起子进程')
    else ok(`插件宿主子进程真实运行（pid=${v.pid}）`)
  }

  // 打包目录必须自带插件 worker 实体文件（asar 关闭的验证）
  const worker = path.join(APP_DIR, 'out', 'main', 'worker.mjs')
  if (!existsSync(worker)) fail('out/main/worker.mjs 不在打包产物里: ' + worker)
  else ok('worker.mjs 以实体文件存在（asar 已关闭）')

  if (existsSync(path.join(APP_DIR, 'out', 'renderer', 'assets'))) {
    const n = readdirSync(path.join(APP_DIR, 'out', 'renderer', 'assets')).length
    if (n !== 2) fail(`renderer/assets 下有 ${n} 个文件（期望 2：1 js + 1 css）`)
    else ok('renderer 产物无冗余旧文件')
  }

  // 源码不该被发出去
  if (existsSync(path.join(APP_DIR, 'src'))) fail('安装包里混进了 src/ 源码目录')
  else ok('产物不含源码目录')
} catch (e) {
  fail(e.message)
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  await sleep(400)
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  if (logs.length) {
    const text = logs.join('')
    const errs = text
      .split('\n')
      .filter((l) => /error|Error|ENOENT|Cannot find/.test(l) && !/DevTools|Autofill/.test(l))
    if (errs.length) {
      console.log('[pkg-smoke] 进程日志中的可疑行:')
      for (const l of errs.slice(0, 12)) console.log('   ', l)
    }
  }
}

console.log(failed ? '[pkg-smoke] 结果：失败' : '[pkg-smoke] 结果：通过')
process.exit(failed ? 1 : 0)
