/**
 * 真实端到端联调：启动打包后的应用，通过 CDP 驱动真实 IPC 让模型建一个项目。
 *
 * 为什么走 CDP 而不是直接调主进程函数：
 *  - 这样跑的是**真实的 preload + IPC + runner + 工具**整条链路，不是 mock。
 *  - Node 24 自带 WebSocket，不需要装 puppeteer/ws。
 *
 * 关键坑：ELECTRON_RUN_AS_NODE 必须整键删除。C++ 侧用 getenv 判断，
 * 空字符串也算"已设置"，此时 electron.exe 退化成纯 Node，
 * require('electron') 掉到 npm 垫片（返回 exe 路径字符串），app/protocol 全 undefined。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const TARGET_DIR = process.env.E2E_TARGET || 'E:\\000开发\\ai-build\\cs'
// 密钥只从环境变量读取，不写进仓库文件
const BASE_URL = process.env.E2E_BASE_URL || 'https://ai.furry.vg/v1'
const API_KEY = process.env.E2E_API_KEY
const MODEL = process.env.E2E_MODEL || 'openai/gpt-5.6-luna'
const PORT = Number(process.env.E2E_PORT || 9333)
const BUILD_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS || 12 * 60 * 1000)

if (!API_KEY) {
  console.error('缺少 E2E_API_KEY 环境变量（不要把密钥写进脚本）')
  process.exit(2)
}

const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const USER_DATA = mkdtempSync(path.join(tmpdir(), 'lagent-e2e-'))

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ */
/* 启动应用                                                            */
/* ------------------------------------------------------------------ */

if (!existsSync(EXE)) {
  console.error('找不到 electron.exe，先 npm install')
  process.exit(2)
}
if (!existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
  console.error('缺少 out/main/index.js，先 npm run build')
  process.exit(2)
}
if (!existsSync(TARGET_DIR)) {
  console.error('目标目录不存在:', TARGET_DIR)
  process.exit(2)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
env.LAGENT_USER_DATA = USER_DATA
env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1'

log(`[e2e] userData = ${USER_DATA}`)
log(`[e2e] 目标目录 = ${TARGET_DIR}`)
log(`[e2e] 模型 = ${MODEL}`)
if (process.env.ELECTRON_RUN_AS_NODE) log('[e2e] 已从子进程环境删除 ELECTRON_RUN_AS_NODE')

const child = spawn(EXE, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
let appLog = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (d) => (appLog += d))
child.stderr.on('data', (d) => (appLog += d))
child.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`\n[e2e] 应用提前退出 code=${code}`)
    console.error(appLog.slice(-4000))
  }
})

/* ------------------------------------------------------------------ */
/* CDP 客户端                                                          */
/* ------------------------------------------------------------------ */

async function findPageTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await r.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  throw new Error('CDP 目标未出现，应用可能没启动成功\n' + appLog.slice(-3000))
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  /** 在渲染进程里求值；返回 JS 值 */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (res.exceptionDetails) {
      throw new Error(
        '求值异常: ' +
          (res.exceptionDetails.exception?.description || res.exceptionDetails.text)
      )
    }
    return res.result.value
  }
}

/* ------------------------------------------------------------------ */

let cdp
let approvals = 0
let toolsUsed = []
let streamedText = ''

try {
  const target = await findPageTarget()
  log(`[e2e] 已连接渲染进程: ${target.url}`)

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')))
  })
  cdp = new Cdp(ws)
  await cdp.send('Runtime.enable')

  // 等 React 挂载 + preload 暴露完成
  for (let i = 0; i < 60; i++) {
    const ready = await cdp.eval('typeof window.lagent === "object" && !!window.lagent.chat')
    if (ready) break
    await sleep(500)
  }
  log('[e2e] preload API 就绪')

  /* ---- 1. 配置供应商（走真实 IPC，密钥由 safeStorage 加密）---- */
  const saved = await cdp.eval(`(async () => {
    const api = window.lagent
    const existing = (await api.providers.list()).value || []
    for (const p of existing) { await api.providers.remove(p.id) }
    const r = await api.providers.save({
      name: 'furry-vg',
      kind: 'openai',
      baseURL: ${JSON.stringify(BASE_URL)},
      apiKey: ${JSON.stringify(API_KEY)},
      models: [${JSON.stringify(MODEL)}],
      enabled: true,
      temperature: 0.2,
      maxTokens: null
    })
    return r
  })()`)
  if (!saved.ok) throw new Error('保存供应商失败: ' + JSON.stringify(saved))
  const providerId = saved.value.id
  log(`[e2e] 供应商已保存 id=${providerId} hasKey=${saved.value.hasKey} mask=${saved.value.keyMask}`)

  /* ---- 2. 设置：开启命令执行 + 权限档位 ---- */
  const permMode = process.env.E2E_PERMISSION_MODE || 'workspace'
  const shellOn = process.env.E2E_SHELL === '1'
  const patched = await cdp.eval(`window.lagent.settings.update({
    activeProviderId: ${JSON.stringify(providerId)},
    activeModel: ${JSON.stringify(MODEL)},
    permissionMode: ${JSON.stringify(permMode)},
    shellEnabled: ${shellOn},
    shellAllowlist: ['node', 'npm']
  })`)
  log(
    `[e2e] 设置已更新 permissionMode=${permMode} shellEnabled=${shellOn} ok=${patched.ok}` +
      (patched.ok ? '' : ` 错误=${JSON.stringify(patched.error)}`)
  )

  /* ---- 3. 连通性自检 ---- */
  const tested = await cdp.eval(`window.lagent.providers.test(${JSON.stringify(providerId)})`)
  log(
    `[e2e] 供应商自检 ok=${tested.ok} ${tested.ok ? `延迟 ${tested.value.latencyMs}ms 模型 ${tested.value.models.length} 个` : JSON.stringify(tested.error)}`
  )

  /* ---- 4. 加入工作区 ---- */
  const wsAdded = await cdp.eval(`window.lagent.workspace.add(${JSON.stringify(TARGET_DIR)})`)
  if (!wsAdded.ok) throw new Error('添加工作区失败: ' + JSON.stringify(wsAdded.error))
  const workspaceId = wsAdded.value.id
  log(`[e2e] 工作区已加入 id=${workspaceId}`)

  /* ---- 5. 建会话 ---- */
  const session = await cdp.eval(
    `window.lagent.sessions.create({ workspaceId: ${JSON.stringify(workspaceId)} })`
  )
  if (!session.ok) throw new Error('建会话失败: ' + JSON.stringify(session.error))
  const sessionId = session.value.id
  log(`[e2e] 会话已创建 id=${sessionId}`)

  /* ---- 6. 订阅事件流 + 自动批准审批 ---- */
  const before = readdirSync(TARGET_DIR)
  log(`[e2e] 任务前目录内容: ${before.length ? before.join(', ') : '(空)'}`)

  const prompt =
    process.env.E2E_PROMPT ||
    [
      `请在当前工作区里用 Node.js 写一个命令行待办清单工具（todo-cli），要求：`,
      `1. todo.mjs：支持 add / list / done / remove 四个子命令，数据存同目录的 todos.json`,
      `2. package.json：声明 name/version/type 为 module，并加一个 start 脚本`,
      `3. README.md：用中文写清楚每个子命令的用法和一条示例`,
      `写完后把 todos.json 初始化成空数组，并实际运行一次 add 验证能跑通。`
    ].join('\n')

  await cdp.eval(`(() => {
    const api = window.lagent
    window.__e2eEvents = []
    window.__e2eDone = null
    const off = api.chat.onEvent((e) => {
      window.__e2eEvents.push(e)
      if (e.type === 'approval') {
        api.chat.respondApproval(e.requestId, true)
      }
      if (e.type === 'done' || e.type === 'error') {
        window.__e2eDone = e
        off()
      }
    })
    return true
  })()`)

  log('\n[e2e] 开始对话，等待模型执行…\n')
  const started = Date.now()
  const sendPromise = cdp.eval(`window.lagent.chat.send({
    sessionId: ${JSON.stringify(sessionId)},
    providerId: ${JSON.stringify(providerId)},
    model: ${JSON.stringify(MODEL)},
    text: ${JSON.stringify(prompt)},
    workspaceId: ${JSON.stringify(workspaceId)},
    allowWrite: true
  })`)

  // 轮询事件，实时打印进度
  let lastCount = 0
  let finished = false
  while (Date.now() - started < BUILD_TIMEOUT_MS) {
    const state = await cdp.eval(`(() => {
      const evs = window.__e2eEvents || []
      return { events: evs.slice(${lastCount}), done: !!window.__e2eDone }
    })()`)
    for (const e of state.events) {
      lastCount++
      if (e.type === 'tool_call') {
        toolsUsed.push(e.name)
        log(`  · 调用工具 ${e.name}`)
      } else if (e.type === 'tool_result') {
        log(`    ${e.ok ? '✓' : '✗'} ${e.name}: ${String(e.summary).slice(0, 110)}`)
      } else if (e.type === 'approval') {
        approvals++
        log(`  ⚠ 审批 ${e.tool} [${e.risk}] → 自动同意`)
      } else if (e.type === 'error') {
        log(`  ✗ 错误: ${e.message}`)
      }
    }
    if (state.done) {
      finished = true
      break
    }
    await sleep(1200)
  }

  if (!finished) log('\n[e2e] 超时，未收到 done')

  // 汇总
  const summary = await cdp.eval(`(() => {
    const evs = window.__e2eEvents || []
    const d = window.__e2eDone
    return {
      totals: evs.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {}),
      delta: evs.filter(e => e.type === 'delta').map(e => e.text).join(''),
      done: d ? { type: d.type, message: d.type === 'done' ? d.message.content : d.message, usage: d.usage } : null
    }
  })()`)

  const sendRes = await sendPromise.catch((e) => ({ ok: false, error: e.message }))

  log('\n================ 事件统计 ================')
  log(JSON.stringify(summary.totals))
  if (summary.done) {
    log(`\n结束状态: ${summary.done.type}`)
    if (summary.done.usage) {
      log(
        `用量: 输入 ${summary.done.usage.inputTokens} 输出 ${summary.done.usage.outputTokens}`
      )
    }
    log('\n--- 模型最终回复 ---')
    log(String(summary.done.message || '').slice(0, 2500))
  }
  log(`\n工具调用 ${toolsUsed.length} 次: ${[...new Set(toolsUsed)].join(', ') || '(无)'}`)
  log(`审批触发 ${approvals} 次`)
  log(`chat.send ok=${sendRes.ok}` + (sendRes.ok ? '' : ` 错误=${JSON.stringify(sendRes.error)}`))

  log('\n================ 产出文件 ================')
  const walk = (d, base = '') => {
    const out = []
    for (const n of readdirSync(d)) {
      const full = path.join(d, n)
      const rel = base ? `${base}/${n}` : n
      if (statSync(full).isDirectory()) out.push(...walk(full, rel))
      else out.push({ rel, size: statSync(full).size })
    }
    return out
  }
  const files = walk(TARGET_DIR)
  if (!files.length) log('(目录为空——模型没写出任何文件)')
  for (const f of files) log(`  ${f.rel}  ${f.size} B`)

  // 抽查关键文件内容
  for (const name of ['todo.mjs', 'package.json', 'README.md', 'todos.json']) {
    const p = path.join(TARGET_DIR, name)
    if (existsSync(p)) {
      log(`\n--- ${name} ---`)
      log(readFileSync(p, 'utf8').slice(0, 900))
    }
  }

  log(`\n[e2e] 结束，userData 保留在 ${USER_DATA}`)
  process.exitCode = files.length && summary.done?.type === 'done' ? 0 : 1
} catch (e) {
  console.error('\n[e2e] 失败:', e.message)
  if (appLog) console.error('\n--- 应用日志尾部 ---\n' + appLog.slice(-3000))
  process.exitCode = 1
} finally {
  try {
    cdp?.ws.close()
  } catch {
    /* 忽略 */
  }
  // 留时间让窗口可见；Ctrl+C 可提前退出
  await sleep(1500)
  child.kill()
}
