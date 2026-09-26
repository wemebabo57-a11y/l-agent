import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const shared = resolve(__dirname, 'src/shared')

/**
 * 递归删除目录。
 *
 * 为什么不用 fs.rmSync(..., { recursive: true })：
 * 本机（Windows / Node 24）实测它**静默不生效**——不抛错，目录原封不动。
 * 同一个进程里 unlinkSync（单文件）与 rmdirSync（空目录）都正常，
 * cmd /c rmdir /s /q 也正常，只能手写递归。
 * 静默失败比抛错更危险：构建会"成功"，但把旧文件一起打进安装包。
 */
function rmrf(target: string): void {
  if (!existsSync(target)) return
  if (!statSync(target).isDirectory()) {
    unlinkSync(target)
    return
  }
  for (const name of readdirSync(target)) rmrf(resolve(target, name))
  rmdirSync(target)
}

/**
 * 插件 worker 是独立进程的入口，不参与打包（它由 spawn 直接以文件路径启动），
 * 因此必须原样复制到 out/main 下。插件宿主用 __dirname 定位它。
 */
function copyPluginWorker(): Plugin {
  return {
    name: 'copy-plugin-worker',
    closeBundle() {
      const outDir = resolve(__dirname, 'out/main')
      mkdirSync(outDir, { recursive: true })
      copyFileSync(resolve(__dirname, 'src/main/plugins/worker.mjs'), resolve(outDir, 'worker.mjs'))
    }
  }
}

/**
 * Vite 只清空 root 内部的 outDir。renderer 的 root 是 src/renderer，
 * 而产物落在 out/renderer（在 root 之外），所以它每次都跳过清理，
 * 带 hash 的旧 bundle 会一直堆积——实测积了 12 份约 9MB 死文件，
 * 这些都会被塞进安装包。这里在构建开始前显式清掉。
 */
function cleanOut(): Plugin {
  return {
    name: 'clean-out',
    buildStart() {
      rmrf(resolve(__dirname, 'out'))
    }
  }
}

export default defineConfig({
  main: {
    plugins: [cleanOut(), externalizeDepsPlugin(), copyPluginWorker()],
    resolve: { alias: { '@shared': shared } },
    build: {
      outDir: 'out/main',
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      outDir: 'out/preload',
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': shared,
        '@': resolve(__dirname, 'src/renderer/src')
      }
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
