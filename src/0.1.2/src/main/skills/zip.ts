/**
 * 极简 ZIP 读取器（只依赖 node:zlib），用于导入 skill 压缩包。
 *
 * 为什么自己写：skill 导入是低频操作，为此引入 zip 依赖会扩大供应链面。
 * 支持范围：Store(0) 与 Deflate(8) 两种压缩方式，即 99% 的 zip 包。
 * 不支持：Zip64（超大文件）、加密包、多卷 —— 遇到时明确报错，不静默产出坏数据。
 */
import { inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  isDir: boolean
  size: number
  data: Buffer
}

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LFH_SIG = 0x04034b50

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

export function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new ZipError('文件太小，不是有效的 zip')

  // 从尾部向前找 EOCD（尾部可能有最长 64KB 的注释）
  const maxBack = Math.min(buf.length, 22 + 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= buf.length - maxBack; i--) {
    if (i < 0) break
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('找不到 zip 结束记录，文件可能已损坏或不是 zip')

  const entryCount = buf.readUInt16LE(eocd + 10)
  let cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === 0xffffffff || entryCount === 0xffff) {
    throw new ZipError('暂不支持 Zip64 格式的压缩包')
  }

  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      throw new ZipError('zip 中央目录结构异常')
    }
    const method = buf.readUInt16LE(p + 10)
    let compSize = buf.readUInt32LE(p + 20)
    let uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('暂不支持 Zip64 格式的压缩包')
    }

    const isDir = name.endsWith('/')
    if (!isDir) {
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LFH_SIG) {
        throw new ZipError(`条目局部头损坏：${name}`)
      }
      const lNameLen = buf.readUInt16LE(localOffset + 26)
      const lExtraLen = buf.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(dataStart, dataStart + compSize)

      let data: Buffer
      if (method === 0) {
        data = Buffer.from(raw)
      } else if (method === 8) {
        try {
          data = inflateRawSync(raw)
        } catch (e) {
          throw new ZipError(`解压失败 ${name}: ${(e as Error).message}`)
        }
      } else {
        throw new ZipError(`不支持的压缩方式 ${method}（文件：${name}）`)
      }
      entries.push({ name, isDir: false, size: data.length, data })
    } else {
      entries.push({ name, isDir: true, size: 0, data: Buffer.alloc(0) })
    }

    p += 46 + nameLen + extraLen + commentLen
  }

  return entries
}

export interface ExtractLimits {
  maxFiles: number
  maxTotalBytes: number
  maxFileBytes: number
}

export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxFiles: 2000,
  maxTotalBytes: 64 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024
}

/**
 * 解压到目标目录，做 zip-slip 防护。
 * 返回实际写入的相对路径列表与总字节数。
 */
export function extractZip(
  entries: ZipEntry[],
  targetDir: string,
  fsx: {
    mkdirSync: (p: string, o: { recursive: boolean }) => void
    writeFileSync: (p: string, d: Buffer) => void
  },
  pathx: {
    join: (...p: string[]) => string
    resolve: (...p: string[]) => string
    relative: (a: string, b: string) => string
  },
  limits: ExtractLimits = DEFAULT_EXTRACT_LIMITS
): { files: string[]; totalBytes: number } {
  const files: string[] = []
  let totalBytes = 0
  const root = pathx.resolve(targetDir)

  for (const entry of entries) {
    if (files.length >= limits.maxFiles) {
      throw new ZipError(`压缩包内文件数超过上限 ${limits.maxFiles}`)
    }
    // 规范化条目名，剥掉绝对路径与 drive 前缀
    const cleaned = entry.name.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '').replace(/^\/+/, '')
    if (!cleaned) continue

    const dest = pathx.resolve(root, cleaned)
    const rel = pathx.relative(root, dest)
    if (rel.startsWith('..') || rel === '' || /^[a-zA-Z]:/.test(rel)) {
      throw new ZipError(`压缩包内含越界路径，已拒绝导入：${entry.name}`)
    }

    if (entry.isDir) {
      fsx.mkdirSync(dest, { recursive: true })
      continue
    }
    if (entry.size > limits.maxFileBytes) {
      throw new ZipError(`文件过大（${entry.name}，${entry.size} 字节）`)
    }
    totalBytes += entry.size
    if (totalBytes > limits.maxTotalBytes) {
      throw new ZipError('压缩包解压后总体积超过上限')
    }
    const dir = pathx.resolve(dest, '..')
    fsx.mkdirSync(dir, { recursive: true })
    fsx.writeFileSync(dest, entry.data)
    files.push(rel.replace(/\\/g, '/'))
  }

  return { files, totalBytes }
}

/** 判断 buffer 是否为 zip（PK\x03\x04） */
export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && [0x03, 0x05, 0x07].includes(buf[2])
}
