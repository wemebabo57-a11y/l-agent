/**
 * 为 Node 注册 @shared/* 别名解析。
 *
 * vite/electron-vite 通过 tsconfig paths 解析别名，但 Node 原生不认识，
 * 而单元测试要直接 import 源码。这里用 module.register 挂一个 resolve 钩子补上映射。
 * 只影响测试运行，不改变构建产物。
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const sharedDir = path.join(here, '..', 'src', 'shared')

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@shared/')) {
    const rel = specifier.slice('@shared/'.length)
    const target = pathToFileURL(path.join(sharedDir, `${rel}.ts`)).href
    return nextResolve(target, context)
  }
  return nextResolve(specifier, context)
}

register(pathToFileURL(path.join(here, 'alias-hooks.mjs')).href, import.meta.url)
