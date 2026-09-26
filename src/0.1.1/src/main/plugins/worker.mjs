/**
 * 插件执行 worker。
 *
 * 由 plugins/index.ts 以独立 Node 子进程启动，通过 stdin 收一条 JSON 请求、
 * 通过 stdout 回一条 JSON 结果。插件入口在子进程里被动态 import，
 * 因此插件崩溃或死循环不会影响主进程——超时由父进程强杀兜底。
 *
 * 协议：
 *   stdin  ← { input, workspacePath, canRequest }
 *   stdout → { ok: true, value } | { ok: false, error }
 *   stdout ← { type: 'request', id, op, ... }  插件向宿主发起的请求
 *   stdin  ← { type: 'response', id, value | error }
 */
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'

const entry = process.env.LAGENT_PLUGIN_ENTRY
const kind = process.env.LAGENT_PLUGIN_KIND ?? 'tool'
const permissions = (process.env.LAGENT_PLUGIN_PERMISSIONS ?? '').split(',').filter(Boolean)

if (!entry) {
  exitAfterEmit({ ok: false, error: '缺少 LAGENT_PLUGIN_ENTRY' }, 1)
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/**
 * 写完后安全退出。
 *
 * 直接 process.exit() 会丢掉尚未 flush 的 stdout——stdout 是管道时，写入是异步的。
 * 表现是"插件偶尔没返回结果"，复现困难且看起来像插件自己的问题。
 * 这里显式等回调，再加一个兜底定时器（对端不读时不能永远挂着）。
 */
function exitAfterEmit(payload, code) {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    process.exit(code)
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`, finish)
  setTimeout(finish, 500).unref()
}

/* ------------------------------------------------------------------ */
/* 宿主请求桥：让插件能通过宿主访问工作区，而不是自己拿 fs              */
/* ------------------------------------------------------------------ */

const pending = new Map()
let nextRequestId = 1
let canRequest = false

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg?.type === 'response' && msg.id != null) {
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.error) entry.reject(new Error(String(msg.error)))
    else entry.resolve(msg.value)
  }
})

/**
 * 向宿主发起请求；宿主未开启桥接时直接拒绝，避免插件静默拿到 undefined。
 *
 * 注意载荷形状：宿主读的是 message.op 上的各个字段（见 plugins/index.ts 的
 * 子进程 stdout 处理），所以操作对象必须**展开**到消息顶层，不能再套一层 op。
 * 以前写成 { type:'request', id, op } 会把字段藏进 op.op，宿主的
 * `parsed.op === 'workspace.read'` 判定永远不成立，插件读文件会静默挂住。
 */
function hostRequest(operation) {
  if (!canRequest) return Promise.reject(new Error('当前上下文不支持与宿主通信'))
  const id = nextRequestId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    emit({ type: 'request', id, ...operation })
  })
}

function buildLagentApi(workspacePath) {
  const api = {
    kind,
    workspacePath,
    permissions,
    has: (p) => permissions.includes(p)
  }

  if (permissions.includes('workspace.read') || permissions.includes('workspace.write')) {
    api.readFile = (p) => hostRequest({ op: 'workspace.read', path: String(p ?? '') })
    api.search = (query) => hostRequest({ op: 'workspace.search', query: String(query ?? '') })
  }
  if (permissions.includes('workspace.write')) {
    api.writeFile = (p, content) =>
      hostRequest({ op: 'workspace.write', path: String(p ?? ''), content: String(content ?? '') })
  }
  // 未声明 network 权限时，把 fetch 换成明确报错的版本。
  // 沙箱本身不拦网络（那需要系统级防火墙），但让越权调用立刻可见，
  // 而不是插件偷偷联网却没人知道。
  if (!permissions.includes('network')) {
    api.fetch = () => Promise.reject(new Error('插件未声明 network 权限，无法联网'))
  }
  return api
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/**
 * 入口路径 → 可 import 的 URL。
 *
 * 宿主传进来的已经是 file:// URL（见 plugins/index.ts 的 pathToFileURL(entry)），
 * 但本文件历史上也接受裸路径（测试与手工构造的请求）。
 * 关键：**不能**无条件再 pathToFileURL 一次——对已经是 file: 的字符串再编码，
 * 会得到 file:\C:\... 这种畸形 URL，import 直接报 "Cannot find module"。
 */
function entryToUrl(value) {
  if (value.startsWith('file://')) return value
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/')) return pathToFileURL(value).href
  return value
}

async function main() {
  const request = await readFirstMessage()
  const input = request?.input ?? {}
  canRequest = Boolean(request?.canRequest)

  const mod = await import(entryToUrl(entry))
  const api = buildLagentApi(request?.workspacePath ?? null)
  const handler = resolveHandler(mod, kind)

  const value = await handler({ input, api, workspacePath: request?.workspacePath ?? null })
  exitAfterEmit({ ok: true, value: value === undefined ? null : value }, 0)
}

function resolveHandler(mod, kind) {
  const candidates =
    kind === 'panel'
      ? ['onPanel', 'panel', 'invoke', 'onInvoke']
      : ['onTool', 'onCall', 'tool', 'invoke', 'onInvoke', 'run']

  for (const name of candidates) {
    if (typeof mod[name] === 'function') return mod[name]
  }
  if (typeof mod.default === 'function') return mod.default
  if (mod.default && typeof mod.default[kind === 'panel' ? 'onPanel' : 'onTool'] === 'function') {
    return mod.default[kind === 'panel' ? 'onPanel' : 'onTool']
  }
  throw new Error(
    `插件入口没有导出可调用的处理函数。需要导出 ${kind === 'panel' ? 'onPanel' : 'onTool'}（或 default 函数）`
  )
}

/** 首条 stdin 消息即启动请求 */
function readFirstMessage() {
  return new Promise((resolve) => {
    const onLine = (line) => {
      rl.off('line', onLine)
      try {
        resolve(JSON.parse(line))
      } catch {
        resolve(null)
      }
    }
    rl.on('line', onLine)
    // stdin 已关闭且没有任何输入：按空请求处理，让插件自己决定行为
    rl.on('close', () => resolve(null))
  })
}

process.on('uncaughtException', (e) => {
  exitAfterEmit({ ok: false, error: `插件未捕获异常：${e?.message ?? String(e)}` }, 1)
})

process.on('unhandledRejection', (e) => {
  exitAfterEmit({ ok: false, error: `插件未处理的 Promise 拒绝：${e?.message ?? String(e)}` }, 1)
})

main().catch((e) => {
  exitAfterEmit({ ok: false, error: e?.message ?? String(e) }, 1)
})
