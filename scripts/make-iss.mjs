/**
 * 用 Inno Setup 编译安装包。
 *
 * 前置条件：先跑 `npm run dist` 产出 dist/win-unpacked（带全部依赖）。
 * 本脚本只负责找到 ISCC.exe 并编译 installer/lagent.iss。
 *
 * 说明：Inno Setup 不一定是装在 Program Files 的（本机装在 D:\inno），
 * 所以按"命令行 → 环境变量 → 常见路径 → 注册表"的顺序找。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const issFile = path.join(ROOT, 'installer', 'lagent.iss')
const unpacked = path.join(ROOT, 'dist', 'win-unpacked')

if (!existsSync(issFile)) {
  console.error(`[iss] 找不到脚本: ${issFile}`)
  process.exit(2)
}
if (!existsSync(path.join(unpacked, 'lagent.exe'))) {
  console.error(`[iss] 找不到打包产物: ${unpacked}\\lagent.exe\n先执行 npm run dist`)
  process.exit(2)
}

function findIscc() {
  const candidates = []
  if (process.env.ISCC) candidates.push(process.env.ISCC)
  if (process.env.INNO_SETUP_HOME) {
    candidates.push(path.join(process.env.INNO_SETUP_HOME, 'ISCC.exe'))
  }
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (base) candidates.push(path.join(base, 'Inno Setup 6', 'ISCC.exe'))
  }
  // 注册表返回的是目录，要自己拼上 ISCC.exe
  for (const dir of regDirs()) candidates.push(path.join(dir, 'ISCC.exe'))
  return candidates.find((p) => p && existsSync(p)) || null
}

/**
 * 从注册表找 Inno Setup 的安装目录。
 *
 * 不能用固定的子键名——本机那条是 GUID 命名的
 * （{899904F6-...}_is1），写死 "Inno Setup 6_is1" 会查不到。
 * 所以整个 Uninstall 树递归列出，凡 InstallLocation 里带 "Inno Setup" 的都认。
 */
function regDirs() {
  const out = []
  const parents = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  ]
  for (const parent of parents) {
    let text
    try {
      // stderr 必须吞掉：键不存在时 reg 会往 stderr 写字，污染输出
      text = execFileSync('reg', ['query', parent, '/s', '/v', 'InstallLocation'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/InstallLocation\s+REG_\w+\s+(.+)/)
      if (m && /inno\s*setup/i.test(m[1])) out.push(m[1].trim())
    }
  }
  return out
}

const iscc = findIscc()
if (!iscc) {
  console.error(
    '[iss] 没找到 ISCC.exe。请安装 Inno Setup 6（https://jrsoftware.org/isdl.php），\n' +
      '      或用环境变量 ISCC 指定它的完整路径。'
  )
  process.exit(2)
}

console.log(`[iss] 使用编译器: ${iscc}`)
const child = spawn(iscc, [issFile], { cwd: ROOT, stdio: 'inherit' })
child.on('exit', (code) => {
  if (code === 0) {
    console.log('[iss] 完成，安装包在 dist/')
  } else {
    console.error(`[iss] 编译失败，退出码 ${code}`)
  }
  process.exit(code ?? 1)
})
