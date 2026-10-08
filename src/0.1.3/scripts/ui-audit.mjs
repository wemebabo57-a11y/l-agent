/**
 * UI 审计：启动真实应用，灌入有代表性的内容，逐页截图并做 DOM 检查。
 *
 * 目的不是"看起来对不对"，而是把可量化的问题揪出来：
 * 溢出、被裁切、对比度不足、点击区过小、间距不一致、层级混乱。
 *
 * 用法：node --no-warnings scripts/ui-audit.mjs
 * 截图落在 shots/ 下，可直接打开看。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const PORT = Number(process.env.AUDIT_PORT || 9336)
const SHOTS = path.join(ROOT, 'shots')
const USER_DATA = path.join(tmpdir(), `lagent-ui-audit-${Date.now()}`)
const VIEWPORT = { width: 1440, height: 900 }

const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(path.join(ROOT, 'out', 'main', 'index.js'))) {
  console.error('缺少构建产物，先 npm run build')
  process.exit(2)
}
rmSync(SHOTS, { recursive: true, force: true })
mkdirSync(SHOTS, { recursive: true })

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
let appLog = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (d) => (appLog += d))
child.stderr.on('data', (d) => (appLog += d))

let ws
const problems = []
const note = (page, kind, detail) => problems.push({ page, kind, detail })

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
  if (!target) throw new Error('CDP 目标未出现\n' + appLog.slice(-2000))

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
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description }
    return r.result.value
  }

  await send('Runtime.enable')
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: 1,
    mobile: false
  })

  for (let i = 0; i < 80; i++) {
    if (await evaluate('typeof window.lagent === "object"')) break
    await sleep(500)
  }
  console.log('[audit] 应用就绪')

  /* ---- 灌入有代表性的内容，避免审计空白页面 ---- */
  const seeded = await evaluate(`(async () => {
    const api = window.lagent
    const out = {}

    // 供应商（带足够长的名字和模型名，测试省略号/换行）
    const list = (await api.providers.list()).value || []
    for (const p of list) await api.providers.remove(p.id)
    const p1 = await api.providers.save({
      name: 'furry-vg 网关',
      kind: 'openai',
      baseURL: 'https://ai.furry.vg/v1',
      apiKey: 'sk-demo-key-for-ui-audit-only-000000',
      models: ['openai/gpt-5.6-luna', 'muse-spark-1.3-contributor', 'openai/gpt-5.6-sol'],
      enabled: true, temperature: 0.2, maxTokens: null
    })
    const p2 = await api.providers.save({
      name: '本地 Ollama',
      kind: 'openai',
      baseURL: 'http://127.0.0.1:11434/v1',
      models: ['qwen2.5-coder:32b'],
      enabled: true, temperature: 0.7, maxTokens: null
    })
    out.providers = [p1.value?.name, p2.value?.name]

    if (p1.value) {
      await api.settings.update({
        activeProviderId: p1.value.id,
        activeModel: 'openai/gpt-5.6-luna',
        permissionMode: 'workspace',
        shellEnabled: true
      })
    }

    // 工作区
    const ws = await api.workspace.add(${JSON.stringify(ROOT)})
    out.workspace = ws.ok ? ws.value.name : ('失败: ' + ws.error)
    return out
  })()`)
  console.log('[audit] 灌入内容:', JSON.stringify(seeded))

  /* ---- 直接往会话文件里塞一条内容丰富的对话 ---- */
  // 通过 IPC 拿不到"注入历史"，所以走 sessionStore 的真实落盘路径
  const sessionId = await evaluate(`(async () => {
    const r = await window.lagent.sessions.create({ workspaceId: null })
    return r.value?.id || null
  })()`)

  if (sessionId) {
    const now = Date.now()
    const msgs = [
      { id: 'm1', role: 'user', content: '帮我在工作区里建一个待办清单 CLI，数据存 JSON。', createdAt: now - 60000 },
      {
        id: 'm2', role: 'assistant', content: '先看一下工作区现状。',
        toolCalls: [{ id: 'tc1', name: 'list_dir', argsJson: '{"dir":"."}' }],
        createdAt: now - 58000,
        usage: { inputTokens: 1240, outputTokens: 38, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimated: false }
      },
      { id: 'm3', role: 'tool', content: '空目录 .', toolCallId: 'tc1', toolName: 'list_dir', createdAt: now - 57000 },
      {
        id: 'm4', role: 'assistant', content: '写三个文件。',
        toolCalls: [
          { id: 'tc2', name: 'write_file', argsJson: '{"path":"todo.mjs","content":"..."}' },
          { id: 'tc3', name: 'write_file', argsJson: '{"path":"README.md","content":"..."}' }
        ],
        createdAt: now - 50000,
        usage: { inputTokens: 2100, outputTokens: 640, cachedInputTokens: 1024, cacheWriteTokens: 0, reasoningTokens: 0, estimated: false }
      },
      { id: 'm5', role: 'tool', content: '新建 todo.mjs', toolCallId: 'tc2', toolName: 'write_file', createdAt: now - 49000 },
      { id: 'm6', role: 'tool', content: '新建 README.md', toolCallId: 'tc3', toolName: 'write_file', createdAt: now - 48000 },
      {
        id: 'm7', role: 'assistant',
        content: '已完成 todo-cli，实际运行验证：\\n\\n```bash\\nnode todo.mjs add "买牛奶"\\n已添加 #1: 买牛奶\\n```\\n\\n验证后已把 todos.json 恢复为 []。',
        createdAt: now - 40000,
        usage: { inputTokens: 15600, outputTokens: 1820, cachedInputTokens: 8192, cacheWriteTokens: 0, reasoningTokens: 0, estimated: false }
      }
    ]
    const saved = await evaluate(`window.lagent.sessions.save({
      id: ${JSON.stringify(sessionId)},
      title: '建一个待办清单 CLI',
      workspaceId: null,
      messages: ${JSON.stringify(msgs)},
      createdAt: ${now - 60000},
      updatedAt: ${now}
    })`)
    console.log('[audit] 会话注入 ok=' + saved.ok + (saved.ok ? '' : ' ' + JSON.stringify(saved.error)))
  }

  /* ---- 逐页截图 + 审计 ---- */
  const pages = [
    ['chat', '对话'],
    ['group', '群聊'],
    ['workspace', '工作区'],
    ['skills', 'Skill'],
    ['plugins', '插件'],
    ['github', 'GitHub'],
    ['usage', '用量'],
    ['settings', '设置']
  ]

  const auditScript = (pageName) => `(() => {
    const out = { page: ${JSON.stringify(pageName)}, issues: [] }
    const px = (v) => parseFloat(v) || 0

    // 1. 横向溢出 / 元素被裁切
    const de = document.documentElement
    if (de.scrollWidth > de.clientWidth + 1) {
      out.issues.push({ kind: '横向溢出', detail: 'scrollWidth ' + de.scrollWidth + ' > clientWidth ' + de.clientWidth })
    }
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue
      // 内容被裁切
      if (cs.overflow === 'hidden' && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)) {
        const sel = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : el.tagName
        out.issues.push({ kind: '内容被裁切', detail: sel + ' (' + el.scrollWidth + 'x' + el.scrollHeight + ' > ' + el.clientWidth + 'x' + el.clientHeight + ')' })
      }
      // 超出视口右/下边界
      if (r.right > de.clientWidth + 2) {
        const sel = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/)[0] : el.tagName
        out.issues.push({ kind: '超出右边界', detail: sel + ' right=' + Math.round(r.right) })
      }
    }

    // 2. 点击目标过小（可交互元素 < 24px 高度）
    // 注意：原生表单控件（复选框/单选）通常被 <label> 包着，真正的点击热区是那个 label。
    // 只量控件本身会把正常 UI 误报成问题，所以先向上找可点击的祖先。
    for (const el of document.querySelectorAll('button, a, select, input[type=checkbox], input[type=radio], [role=button]')) {
      let target = el
      // 表单控件若在 label 内，实际热区是 label
      if (el.matches('input[type=checkbox], input[type=radio]')) {
        const label = el.closest('label')
        if (label) target = label
      }
      const r = target.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      // 按钮/链接若自身够高就不报；表单控件按最终热区判定
      if (r.height < 22) {
        const label = (target.textContent || target.getAttribute('title') || target.tagName).trim().slice(0, 24)
        out.issues.push({
          kind: '点击区偏小',
          detail: label + ' 高 ' + Math.round(r.height) + 'px' + (target === el ? '' : '（热区取外层 label）')
        })
      }
    }

    // 3. 字号统计（检查层级是否够用）
    const fontSizes = {}
    for (const el of document.querySelectorAll('*')) {
      if (!el.textContent || !el.textContent.trim()) continue
      if (el.children.length > 0 && !Array.from(el.childNodes).some(n => n.nodeType === 3 && n.textContent.trim())) continue
      const f = getComputedStyle(el).fontSize
      fontSizes[f] = (fontSizes[f] || 0) + 1
    }
    out.fontSizes = fontSizes

    // 4. 重复的圆角值（视觉一致性）
    const radii = {}
    for (const el of document.querySelectorAll('*')) {
      const r = getComputedStyle(el).borderRadius
      if (r && r !== '0px') radii[r] = (radii[r] || 0) + 1
    }
    out.radii = radii

    // 5. 关键结构是否存在
    out.structure = {
      topbar: !!document.querySelector('.topbar'),
      sidebar: !!document.querySelector('.sidebar'),
      navItems: document.querySelectorAll('.nav-item').length,
      page: !!document.querySelector('.page'),
      chat: !!document.querySelector('.chat'),
      scrollArea: !!document.querySelector('.chat-scroll, .page')
    }

    // 6. emoji 残留
    const EMOJI = /[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{26FF}\\u{2700}-\\u{27BF}\\u{2B00}-\\u{2BFF}\\u{FE0F}]/u
    const emoji = new Set()
    for (const el of document.querySelectorAll('*')) {
      for (const n of el.childNodes) {
        if (n.nodeType === 3 && EMOJI.test(n.textContent)) emoji.add(n.textContent.trim().slice(0, 20))
      }
    }
    out.emoji = [...emoji]

    // 7. 对比度（正文与背景）
    const bg = getComputedStyle(document.body).backgroundColor
    const fg = getComputedStyle(document.body).color
    out.contrast = { bg, fg }
    const lum = (c) => {
      const m = c.match(/\\d+/g)
      if (!m) return 0
      const [r, g, b] = m.slice(0, 3).map(Number).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const L1 = lum(fg), L2 = lum(bg)
    out.contrastRatio = Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100

    // 8. 对比度逐元素抽查：正文类小字是否达到 4.5:1
    // 关键：必须做 alpha 合成。半透明背景（如 rgba(76,141,255,0.13)）不能直接拿来算，
    // 否则同色系文字会算出 1:1 的假阳性。
    const parseColor = (c) => {
      const m = String(c).match(/rgba?\\(([^)]+)\\)/)
      if (!m) return null
      const p = m[1].split(',').map((v) => parseFloat(v.trim()))
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
    }
    const blend = (fg, bg) => {
      if (!bg) return fg
      const a = fg.a + bg.a * (1 - fg.a)
      if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
      const mix = (f, b) => (f * fg.a + b * bg.a * (1 - fg.a)) / a
      return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a }
    }
    // 逐层向上合成到不透明为止
    const effectiveBg = (el) => {
      const stack = []
      let node = el
      while (node) {
        const c = parseColor(getComputedStyle(node).backgroundColor)
        if (c && c.a > 0) stack.push(c)
        if (c && c.a === 1) break
        node = node.parentElement
      }
      let acc = { r: 13, g: 16, b: 23, a: 1 } // 兜底：应用底色
      for (let i = stack.length - 1; i >= 0; i--) acc = blend(stack[i], acc)
      return acc
    }
    const relLum = (c) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
    }

    out.lowContrast = []
    const seenText = new Set()
    for (const el of document.querySelectorAll('span, p, div, button, label, td, th, a, li')) {
      const t = (el.textContent || '').trim()
      if (!t || t.length > 60 || el.children.length) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.99) continue
      const size = px(cs.fontSize)
      if (size > 15) continue
      const fg0 = parseColor(cs.color)
      if (!fg0) continue
      const bgc = effectiveBg(el)
      const fg = blend(fg0, bgc)
      const r1 = relLum(fg), r2 = relLum(bgc)
      const ratio = Math.round(((Math.max(r1, r2) + 0.05) / (Math.min(r1, r2) + 0.05)) * 100) / 100
      const key = cs.color + '|' + size
      // 4.5:1 是 WCAG AA 对小字的要求
      if (ratio < 4.5 && !seenText.has(key)) {
        seenText.add(key)
        out.lowContrast.push({
          text: t.slice(0, 26),
          size,
          color: cs.color,
          bg: 'rgb(' + Math.round(bgc.r) + ', ' + Math.round(bgc.g) + ', ' + Math.round(bgc.b) + ')',
          ratio
        })
      }
    }
    out.lowContrast.sort((a, b) => a.ratio - b.ratio)
    out.lowContrast = out.lowContrast.slice(0, 10)

    // 9. 间距一致性：同级元素的 gap / margin 取值种类
    out.spacing = {}
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (cs.display === 'flex' || cs.display === 'grid') {
        const g = cs.gap
        if (g && g !== 'normal' && g !== '0px') out.spacing['gap:' + g] = (out.spacing['gap:' + g] || 0) + 1
      }
    }

    // 10. 内边距取值（同一角色的卡片是否一致）
    // 注意：SVG 元素的 className 是 SVGAnimatedString，不是字符串，直接 .split 会抛异常
    const cls = (el) => (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '')
    out.paddings = {}
    for (const el of document.querySelectorAll('.card, .page-header, .nav-item, .btn, .pill, .field, .mode-card')) {
      const cs = getComputedStyle(el)
      const k = cls(el).split(/\\s+/).filter((c) => c && !c.startsWith('tone-')).join('.') + ' → ' + cs.padding
      out.paddings[k] = (out.paddings[k] || 0) + 1
    }

    // 11. 文本截断：出现省略号的地方，是否真的过长
    out.truncated = []
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1) {
        out.truncated.push((el.textContent || '').trim().slice(0, 30) + ' (' + el.scrollWidth + '>' + el.clientWidth + ')')
      }
    }
    out.truncated = out.truncated.slice(0, 8)

    // 12. 垂直节奏：页面主要块之间的间距
    const blocks = [...document.querySelectorAll('.page > *, .card')].map(el => el.getBoundingClientRect())
    const gaps = []
    for (let i = 1; i < blocks.length; i++) {
      const d = Math.round(blocks[i].top - blocks[i - 1].bottom)
      if (d > 0 && d < 200) gaps.push(d)
    }
    out.blockGaps = [...new Set(gaps)].sort((a, b) => a - b)

    return out
  })()`

  const results = []
  for (const [page, label] of pages) {
    // 点击对应导航
    const clicked = await evaluate(`(() => {
      const items = [...document.querySelectorAll('.nav-item')]
      const hit = items.find(b => (b.textContent || '').includes(${JSON.stringify(label)}))
      if (hit) { hit.click(); return true }
      return false
    })()`)
    if (!clicked) {
      note(page, '导航缺失', `找不到导航项「${label}」`)
      continue
    }
    await sleep(900)

    const audit = await evaluate(auditScript(page))
    if (audit && !audit.__err) {
      results.push(audit)
      for (const iss of audit.issues) note(page, iss.kind, iss.detail)
      if (audit.emoji.length) note(page, 'emoji 残留', audit.emoji.join(' | '))
      for (const lc of audit.lowContrast || []) {
        note(page, '小字对比度不足', `「${lc.text}」${lc.size}px ${lc.ratio}:1 (${lc.color} on ${lc.bg})`)
      }
      if ((audit.truncated || []).length) note(page, '文本被截断', audit.truncated.join(' | '))
    } else {
      note(page, '审计脚本异常', JSON.stringify(audit))
    }

    // 截图
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = path.join(SHOTS, `${String(pages.findIndex((p) => p[0] === page) + 1).padStart(2, '0')}-${page}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log(`[audit] ${page.padEnd(10)} 截图 ${path.basename(file)}  问题 ${audit?.issues?.length ?? '?'} 处`)
  }

  /* ---- 汇总 ---- */
  console.log('\n================ 字体层级 ================')
  for (const r of results) console.log(`${r.page.padEnd(10)} ${JSON.stringify(r.fontSizes)}`)

  console.log('\n================ 圆角取值 ================')
  for (const r of results) console.log(`${r.page.padEnd(10)} ${JSON.stringify(r.radii)}`)

  console.log('\n================ 对比度 ================')
  for (const r of results) {
    console.log(`${r.page.padEnd(10)} 正文/背景 ${r.contrastRatio}:1  (${r.contrast.fg} on ${r.contrast.bg})`)
  }

  console.log('\n================ 页面结构 ================')
  for (const r of results) console.log(`${r.page.padEnd(10)} ${JSON.stringify(r.structure)}`)

  console.log('\n================ 小字对比度不足 ================')
  for (const r of results) {
    if (!(r.lowContrast || []).length) console.log(`${r.page.padEnd(10)} (无)`)
    else for (const lc of r.lowContrast) console.log(`${r.page.padEnd(10)} ${lc.ratio}:1  ${lc.size}px  ${lc.color} on ${lc.bg}  「${lc.text}」`)
  }

  console.log('\n================ 间距取值分布 ================')
  for (const r of results) console.log(`${r.page.padEnd(10)} ${JSON.stringify(r.spacing)}`)

  console.log('\n================ 同类元素内边距 ================')
  for (const r of results) {
    if (!Object.keys(r.paddings || {}).length) continue
    console.log(`${r.page}:`)
    for (const [k, v] of Object.entries(r.paddings)) console.log(`  ${k}  ×${v}`)
  }

  console.log('\n================ 块间距 / 截断 ================')
  for (const r of results) {
    console.log(`${r.page.padEnd(10)} gaps=${JSON.stringify(r.blockGaps)}${(r.truncated || []).length ? '  截断: ' + r.truncated.join(' | ') : ''}`)
  }

  console.log('\n================ 问题清单 ================')
  if (!problems.length) {
    console.log('(无)')
  } else {
    const byKind = {}
    for (const p of problems) {
      byKind[p.kind] = byKind[p.kind] || []
      byKind[p.kind].push(`[${p.page}] ${p.detail}`)
    }
    for (const [kind, list] of Object.entries(byKind)) {
      console.log(`\n${kind} (${list.length})`)
      for (const l of list.slice(0, 12)) console.log('  - ' + l)
      if (list.length > 12) console.log(`  … 另有 ${list.length - 12} 处`)
    }
  }

  console.log(`\n[audit] 截图目录: ${SHOTS}`)
  console.log(`[audit] 合计问题 ${problems.length} 处`)
} catch (e) {
  console.error('[audit] 失败:', e.message)
  process.exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  await sleep(300)
  child.kill()
  try {
    rmSync(USER_DATA, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
