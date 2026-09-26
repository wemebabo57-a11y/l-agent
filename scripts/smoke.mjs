/**
 * 启动烟雾测试：在无界面环境下启动主进程，验证
 * 1) 主进程能初始化、IPC 注册成功、窗口创建成功
 * 2) preload 加载成功（contextBridge 生效）
 * 3) 渲染进程能完成首帧渲染，无 CSP/JS 错误
 *
 * 用法：node scripts/smoke.mjs
 * 退出码 0 = 通过。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronBin = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')

// 用独立 userData 目录，避免污染开发者真实数据
const userData = mkdtempSync(path.join(tmpdir(), 'lagent-smoke-'))

const probe = path.join(root, 'scripts', 'smoke-probe.cjs')

/**
 * 关键：必须清掉 ELECTRON_RUN_AS_NODE。
 * 若它被设为 1（某些宿主/工具链会全局注入），electron.exe 会退化成纯 Node 运行，
 * 此时 require('electron') 只返回二进制路径字符串、app 为 undefined，
 * 表现为 "Cannot read properties of undefined (reading 'getPath')" 这类让人误判的报错。
 */
const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE
delete cleanEnv.NODE_OPTIONS

const child = spawn(electronBin, [path.join(root, 'out', 'main', 'index.js'), '--lagent-smoke'], {
  cwd: root,
  env: {
    ...cleanEnv,
    LAGENT_SMOKE: '1',
    LAGENT_SMOKE_PROBE: probe,
    LAGENT_USER_DATA: userData
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (d) => {
  stdout += d.toString()
})
child.stderr.on('data', (d) => {
  stderr += d.toString()
})

const timeout = setTimeout(() => {
  console.log('--- TIMEOUT ---')
  child.kill()
}, 60000)

child.on('exit', (code) => {
  clearTimeout(timeout)
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {
    /* 忽略清理失败 */
  }

  const passed = /SMOKE_OK/.test(stdout)
  const failed = /SMOKE_FAIL/.test(stdout)

  console.log('=== stdout ===')
  console.log(stdout.trim() || '(空)')
  if (stderr.trim()) {
    console.log('=== stderr ===')
    console.log(stderr.trim().slice(0, 3000))
  }
  console.log('=== exit code:', code, '===')

  if (passed && !failed) {
    console.log('烟雾测试通过')
    process.exit(0)
  }
  console.log('烟雾测试未通过')
  process.exit(1)
})
