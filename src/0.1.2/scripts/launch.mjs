/**
 * 启动应用并把供应商配置好，然后把窗口留给你看。
 *
 * 为什么需要这个脚本：当前 shell 环境里带 ELECTRON_RUN_AS_NODE=1，
 * 它会让 electron.exe 退化成纯 Node（app/protocol 全 undefined，直接崩）。
 * 必须整键删除——置空字符串没用，C++ 的 getenv 对空值同样返回非 NULL。
 *
 * 用真实 userData，所以在这里配的供应商会留在应用里，下次直接能用。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const PORT = Number(process.env.LAUNCH_PORT || 9335)
const BASE_URL = process.env.E2E_BASE_URL || 'https://ai.furry.vg/v1'
const API_KEY = process.env.E2E_API_KEY
const MODELS = (
  process.env.E2E_MODELS || 'openai/gpt-5.6-luna,muse-spark-1.3-contributor,openai/gpt-5.6-sol'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(EXE)) {
  console.error('找不到 electron.exe')
  process.exit(2)
}
if (!existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
  console.error('缺少构建产物，先 npm run build')
  process.exit(2)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1'
// 不设 LAGENT_USER_DATA -> 用真实 userData，配置会保留

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(EXE, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', (d) => process.stdout.write(`[app] ${d}`))
child.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`))
child.on('exit', (code) => {
  console.log(`\n[launch] 应用已退出 code=${code}`)
  process.exit(code ?? 0)
})

let ws
try {
  let target
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (target) break
    } catch {
      /* 等启动 */
    }
    await sleep(500)
  }
  if (!target) throw new Error('CDP 目标未出现')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')))
  })

  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id != null && pending.has(m.id)) {
      const { resolve } = pending.get(m.id)
      pending.delete(m.id)
      resolve(m.result)
    }
  })
  const evaluate = (expression) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, { resolve })
      ws.send(
        JSON.stringify({
          id: i,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true }
        })
      )
    }).then((r) => (r.exceptionDetails ? { __err: r.exceptionDetails.text } : r.result.value))

  await evaluate('1')
  for (let i = 0; i < 60; i++) {
    if (await evaluate('typeof window.lagent === "object"')) break
    await sleep(500)
  }
  console.log('[launch] 界面已就绪')

  if (API_KEY) {
    const r = await evaluate(`(async () => {
      const api = window.lagent
      const list = (await api.providers.list()).value || []
      let target = list.find(p => p.baseURL === ${JSON.stringify(BASE_URL)})
      if (!target) {
        const saved = await api.providers.save({
          name: 'furry-vg',
          kind: 'openai',
          baseURL: ${JSON.stringify(BASE_URL)},
          apiKey: ${JSON.stringify(API_KEY)},
          models: ${JSON.stringify(MODELS)},
          enabled: true,
          temperature: 0.2,
          maxTokens: null
        })
        if (!saved.ok) return { ok: false, error: saved.error }
        target = saved.value
      }
      await api.settings.update({
        activeProviderId: target.id,
        activeModel: ${JSON.stringify(MODELS[0])},
        permissionMode: 'workspace',
        shellEnabled: true,
        shellAllowlist: ['node', 'npm']
      })
      // 注意：settings 相关的 IPC 返回形状不统一——
      // settings.get() 直接返回设置对象本身，而其它通道返回 { ok, value }。
      const after = (await api.settings.get()) || {}
      return {
        ok: true,
        provider: { id: target.id, name: target.name, hasKey: target.hasKey, mask: target.keyMask, models: target.models },
        settings: { mode: after.permissionMode, shell: after.shellEnabled, activeModel: after.activeModel }
      }
    })()`)
    if (r?.ok) {
      console.log(`[launch] 供应商就绪: ${r.provider.name} ${r.provider.mask} 模型 ${r.provider.models.length} 个`)
      console.log(`[launch] 权限档位=${r.settings.mode} 命令执行=${r.settings.shell} 当前模型=${r.settings.activeModel}`)
    } else {
      console.log('[launch] 配置供应商失败:', JSON.stringify(r))
    }
  } else {
    console.log('[launch] 未提供 E2E_API_KEY，跳过供应商配置（应用仍可用，请在设置页手动填）')
  }

  console.log('\n[launch] 窗口已打开，直接在界面上操作即可。按 Ctrl+C 关闭。\n')
  ws.close()
} catch (e) {
  console.error('[launch] 配置阶段失败:', e.message)
  console.error('[launch] 应用仍在运行，可手动操作。按 Ctrl+C 关闭。')
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
}

// 保持前台，直到用户 Ctrl+C
await new Promise(() => {})
