/**
 * electron 的最小替身，仅供 Node 下的集成测试使用。
 *
 * 为什么要它：PluginManager / store 通过 app.getPath('userData') 定位数据目录，
 * 纯 Node 下没有 electron 模块。测试里把它 redirect 到这个替身即可，
 * 生产构建完全不受影响（只在 alias-hooks-stub 注册时才生效）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.LAGENT_TEST_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'lagent-stub-'))

export const app = {
  getPath: (name) => {
    if (name === 'userData') return home
    return path.join(home, name)
  },
  getVersion: () => '0.0.0-test',
  quit: () => undefined,
  whenReady: () => Promise.resolve(),
  on: () => undefined,
  requestSingleInstanceLock: () => true,
  setPath: () => undefined
}

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(s, 'utf8'),
  decryptString: (b) => b.toString('utf8')
}

export const shell = { openExternal: async () => undefined, showItemInFolder: () => undefined }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export const ipcMain = { handle: () => undefined, on: () => undefined }
export const protocol = { handle: () => undefined, registerSchemesAsPrivileged: () => undefined }
export const BrowserWindow = class {}
export default { app, safeStorage, shell, dialog, ipcMain, protocol, BrowserWindow }
