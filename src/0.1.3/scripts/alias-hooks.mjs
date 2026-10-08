/**
 * 由 alias-register.mjs 注册的 resolve 钩子，供单元测试直接 import TS 源码：
 * 1) 把 @shared/* 映射到 src/shared/*.ts
 * 2) 为无扩展名的相对导入补 .ts（TS 源码里写的是 './sse'，Node 需要 './sse.ts'）
 * 只影响测试运行，不改变构建产物。
 */
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const sharedDir = path.join(here, '..', 'src', 'shared')

export function resolve(specifier, context, nextResolve) {
  // 别名：@shared/pricing -> src/shared/pricing.ts
  if (specifier.startsWith('@shared/')) {
    const rel = specifier.slice('@shared/'.length)
    return nextResolve(pathToFileURL(path.join(sharedDir, `${rel}.ts`)).href, context)
  }

  // 集成测试里把 electron 换成最小替身：
  // 只有 LAGENT_STUB_ELECTRON=1 时生效，生产与构建不受影响。
  if (specifier === 'electron' && process.env.LAGENT_STUB_ELECTRON === '1') {
    return nextResolve(pathToFileURL(path.join(here, 'electron-stub.mjs')).href, context)
  }

  // 相对导入补扩展名：./sse -> ./sse.ts（也支持 /index.ts）
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd()
    const base = path.resolve(path.dirname(parentPath), specifier)
    for (const cand of [`${base}.ts`, path.join(base, 'index.ts')]) {
      if (existsSync(cand)) {
        return nextResolve(pathToFileURL(cand).href, context)
      }
    }
  }

  return nextResolve(specifier, context)
}
