/**
 * dev 启动包装器。
 *
 * 存在意义：本机 shell 环境里带了 ELECTRON_RUN_AS_NODE=1，
 * electron-vite 启动 electron.exe 时会继承它，于是 Electron 退化成纯 Node：
 *   - process.type 不再是 'browser'
 *   - require('electron') 掉到 npm 垫片，返回 exe 路径字符串
 *   - 报错停在 protocol.registerSchemesAsPrivileged（TypeError: Cannot read properties of undefined）
 *
 * 必须在 spawn 之前**删除整个键**：C++ 侧用 getenv 判断，
 * 空字符串同样算"已设置"，置空无效。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const env = { ...process.env }
if (env.ELECTRON_RUN_AS_NODE !== undefined) {
  delete env.ELECTRON_RUN_AS_NODE
  console.log('[dev] 已清除继承来的 ELECTRON_RUN_AS_NODE（否则 Electron 会退化成纯 Node）')
}

// 直接定位 electron-vite 的入口，避免 shell:true（会触发 DEP0190，且有转义风险）
const bin = path.join(path.dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
if (!existsSync(bin)) {
  console.error('[dev] 找不到 electron-vite 入口:', bin)
  process.exit(2)
}

const args = process.argv.slice(2)
const mode = args.length ? args[0] : 'dev'

const child = spawn(process.execPath, [bin, mode, ...args.slice(1)], {
  env,
  stdio: 'inherit'
})
child.on('exit', (code) => process.exit(code ?? 0))
