/**
 * 打包脚本：先编译，再用 electron-builder 产出**免安装目录**（带依赖）。
 * 安装包由 Inno Setup 单独制作（见 installer/lagent.iss）。
 *
 * 两个必须显式处理的点：
 * 1) ELECTRON_RUN_AS_NODE 在本机 shell 里是被设上的。它会让 Electron 退化成
 *    纯 Node，所以 spawn 前必须 delete 掉（置空字符串不算删除）。
 * 2) electron-builder 在本机解压官方 Electron 分发包时会卡死：无 CPU、
 *    无磁盘增长，两次都停在 "unpacking default Electron distribution"。
 *    因此 electron-builder.yml 里用 electronDist 直接指向已解压好的
 *    node_modules/electron/dist，跳过下载与解压。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const target = process.argv[2] || 'win'

/**
 * Windows 上 spawn 一个 .cmd 会 EINVAL（Node 的安全校验），
 * 所以跟 dev.mjs 一样：直接用 node 跑它的 JS 入口。
 */
function jsEntry(pkg, relative) {
  const p = path.join(ROOT, 'node_modules', pkg, ...relative.split('/'))
  if (!existsSync(p)) throw new Error(`找不到 ${pkg} 的入口: ${p}`)
  return p
}

function run(entry, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    // 关键：必须 delete，置空字符串在 C++ 侧仍算已设置
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    const child = spawn(process.execPath, [entry, ...args], { cwd: ROOT, env, stdio: 'inherit' })
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(entry)} 退出码 ${code}`))
    )
    child.on('error', reject)
  })
}

console.log('[dist] 1/2 编译（electron-vite build）')
await run(jsEntry('electron-vite', 'bin/electron-vite.js'), ['build'])

console.log(`[dist] 2/2 打包（electron-builder --${target} --dir）`)
// dir 目标 = 免安装目录，安装包由 Inno Setup 单独制作
await run(jsEntry('electron-builder', 'cli.js'), ['--' + target, '--dir'])

console.log('[dist] 完成，产物在 dist/')
