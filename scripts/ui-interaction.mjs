/**
 * UI 交互测试：启动隔离实例，用 CDP 在真实渲染进程里点按钮、敲键盘，断言行为。
 *
 * 覆盖（对应近期改动）：
 * 1. 切页常驻：输入框草稿在 对话→群聊→对话 后保留（page-keep，不卸载）
 * 2. 斜杠菜单：输入 /mode 出现菜单，回车选中后切到 PTC
 * 3. 快捷键总览：点 ? 钮打开，Esc 关闭
 * 4. 模式按钮：点 极简 切换 active 态
 * 5. 无待确认时不出现 approval-pill
 *
 * 用法：node --no-warnings scripts/ui-interaction.mjs
 * 任一断言失败即非零退出。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const PORT = Number(process.env.INTERACT_PORT || 9337)
const USER_DATA = path.join(tmpdir(), `lagent-ui-interact-${Date.now()}`)
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
  console.error('缺少构建产物，先 npm run build')
  process.exit(2)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
env.LAGENT_USER_DATA = USER_DATA
env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1'

const child = spawn(EXE, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', () => undefined)
child.stderr.on('data', () => undefined)

let failures = 0
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${extra ? ' —— ' + extra : ''}`)
  }
}

let ws
try {
  let target
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (target) break
    } catch {
      /* retry */
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
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      if (m.error) reject(new Error(JSON.stringify(m.error)))
      else resolve(m.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id
      pending.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await new Promise((resolve, reject) => {
      const i = ++id
      pending.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text }
    return r.result.value
  }

  for (let i = 0; i < 80; i++) {
    if (await evaluate('typeof window.lagent === "object"')) break
    await sleep(500)
  }
  // lagent 就绪不等于聊天页就绪：等输入框与模式按钮挂载，否则首个 set 会扑空
  let composerReady = false
  for (let i = 0; i < 40; i++) {
    composerReady = await evaluate(`!!document.querySelector('.composer-input') && !!document.querySelector('.target-mode')`)
    if (composerReady) break
    await sleep(500)
  }
  if (!composerReady) throw new Error('输入框未挂载')
  console.log('[interact] 应用就绪，开始断言')

  // 真实按键流（CDP Input 域）：合成 input 事件 React 19 不认，必须走可信输入
  const focusComposer = `(() => { const el = document.querySelector('.composer-input'); if (el) el.focus(); return !!el })()`
  const typeText = async (text) => {
    await evaluate(focusComposer)
    await send('Input.insertText', { text })
  }
  const keyPress = async (key, code, windowsVirtualKeyCode, modifiers) => {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers: modifiers ?? 0 })
    }
  }
  const clearComposer = async () => {
    await evaluate(focusComposer)
    // Ctrl+A 全选再退格
    await keyPress('a', 'KeyA', 65, 2)
    await keyPress('Backspace', 'Backspace', 8)
  }
  const composerValue = () => evaluate(`(document.querySelector('.composer-input') || {}).value || ''`)
  const clickNav = (label) =>
    `((__label__) => {
      const items = [...document.querySelectorAll('.nav-item')]
      const hit = items.find((b) => (b.textContent || '').includes(__label__))
      if (!hit) return false
      hit.click()
      return true
    })(${JSON.stringify(label)})`

  /* 1. 切页常驻：草稿保留 */
  await typeText('草稿保留测试')
  await evaluate(clickNav('群聊'))
  await sleep(800)
  await evaluate(clickNav('对话'))
  await sleep(800)
  const draft = await composerValue()
  check('切页后输入框草稿保留', draft === '草稿保留测试', `实际=${JSON.stringify(draft)}`)

  /* 2. 斜杠菜单出现：先裸 / 看全量，再收窄 */
  await clearComposer()
  await typeText('/')
  await sleep(400)
  const menuCount = await evaluate(`document.querySelectorAll('.slash-menu .palette-item').length`)
  check('输入 / 出现斜杠菜单', menuCount >= 2, `菜单项=${menuCount}`)
  const menuNames = await evaluate(
    `[...document.querySelectorAll('.slash-menu .palette-item-title')].map((e) => e.textContent).join(',')`
  )
  check('菜单含 /mode 与 /help', /\/mode/.test(menuNames) && /\/help/.test(menuNames), menuNames)
  await typeText('mode')
  await sleep(400)
  const narrowed = await evaluate(`document.querySelectorAll('.slash-menu .palette-item').length`)
  check('输入 /mode 收窄到 1 项', narrowed === 1, `菜单项=${narrowed}`)

  /* 3. 回车选中 /mode（空参轮换 标准→PTC），模式按钮跟随 */
  await evaluate(focusComposer)
  await keyPress('Enter', 'Enter', 13)
  await sleep(1200)
  const activeMode = await evaluate(
    `(() => { const a = document.querySelector('.target-mode.active'); return a ? a.textContent.trim() : ''; })()`
  )
  check('回车选中后切到 PTC', activeMode === 'PTC', `active=${JSON.stringify(activeMode)}`)
  const afterPick = await composerValue()
  check('选中后斜杠 token 被吃掉', !afterPick.includes('/mode'), `实际=${JSON.stringify(afterPick)}`)

  /* 4. 快捷键总览开合 */
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')]
    const hit = btns.find((b) => (b.getAttribute('title') || '').includes('快捷键一览'))
    if (hit) hit.click()
    return !!hit
  })()`)
  await sleep(500)
  const modalOpen = await evaluate(`document.body.textContent.includes('快捷键一览') && !!document.querySelector('.modal')`)
  check('点 ? 打开快捷键总览', !!modalOpen)
  await evaluate(focusComposer)
  await keyPress('Escape', 'Escape', 27)
  await sleep(500)
  const modalClosed = await evaluate(`!document.body.textContent.includes('发送当前输入')`)
  check('Esc 关闭快捷键总览', !!modalClosed)

  /* 5. 模式按钮直切极简 */
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.target-mode')]
    const hit = btns.find((b) => b.textContent.trim() === '极简')
    if (hit) hit.click()
    return !!hit
  })()`)
  await sleep(1200)
  const miniActive = await evaluate(
    `(() => { const a = document.querySelector('.target-mode.active'); return a ? a.textContent.trim() : ''; })()`
  )
  check('点按钮切到极简', miniActive === '极简', `active=${JSON.stringify(miniActive)}`)

  /* 6. 无待确认时不出现 pill */
  const pills = await evaluate(`document.querySelectorAll('.approval-pill').length`)
  check('无待确认时不出现 pill', pills === 0, `pills=${pills}`)

  console.log(failures ? `\n[interact] 失败 ${failures} 项` : '\n[interact] INTERACT_OK 全部通过')
  process.exitCode = failures ? 1 : 0
} catch (e) {
  console.error('[interact] 失败:', e.message)
  process.exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  await sleep(300)
  child.kill()
}
