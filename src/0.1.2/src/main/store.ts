import { app, safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { AppSettings, ProviderConfig, Workspace } from '@shared/types'

/**
 * 轻量 JSON 存储。
 * - 全部数据放在 app.getPath('userData')/data 下，卸载/清空目录即完全重置。
 * - 写入走"临时文件 + rename"，避免断电/崩溃写出半截 JSON。
 * - 所有写操作串行化，避免并发 IPC 互相覆盖。
 */
class JsonFile<T> {
  private queue: Promise<void> = Promise.resolve()
  private readonly file: string
  private readonly fallback: T

  // 不用 TS 参数属性：Node 的 strip-only 模式不支持它，
  // 而单元测试与集成测试要直接 import 本模块。
  constructor(file: string, fallback: T) {
    this.file = file
    this.fallback = fallback
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
  }

  async read(): Promise<T> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      return JSON.parse(raw) as T
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(this.fallback)
      // 文件损坏：备份后回退，不让应用起不来
      try {
        await this.ensureDir()
        await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        /* 备份失败不阻断 */
      }
      return structuredClone(this.fallback)
    }
  }

  async write(value: T): Promise<void> {
    const run = async (): Promise<void> => {
      await this.ensureDir()
      const tmp = `${this.file}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
      await fs.rename(tmp, this.file)
    }
    // 串行链：前一个失败也要继续后续写入
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** 读-改-写 原子更新 */
  async update(mutate: (current: T) => T): Promise<T> {
    const current = await this.read()
    const nextValue = mutate(current)
    await this.write(nextValue)
    return nextValue
  }
}

export const DEFAULT_SETTINGS: AppSettings = {
  activeProviderId: null,
  activeModel: null,
  theme: 'dark',
  systemPrompt: [
    '你是 lagent，一个能真正操作这台电脑的助手。你会真的读写文件、执行命令、点击屏幕，而不只是给出建议。',
    '',
    '行为准则：',
    '1. 能自己做的就直接做，做完再报告结果。不要问「需要我帮你做吗」这种话。',
    '2. 文件内容以工具读取结果为准，不凭记忆编造。改文件前先读原文件，保持现有风格。',
    '3. 需要多步操作时直接连续执行，不要每一步都停下来征求同意——权限确认由界面处理，你只管往下做。',
    '4. 操作屏幕前先截图看清楚。截图会过期：界面一变就重新截，不要靠记忆里的坐标点击。',
    '5. 命令失败、工具被拒绝时，如实说明发生了什么，然后换个做法。不要假装成功。',
    '6. 用用户的语言回答。不寒暄、不复述用户的话、不写「希望这对你有帮助」这类收尾。',
    '7. 结论先行。解释只在用户需要或结论不直观时给出。'
  ].join('\n'),
  maxToolRounds: 20,
  contextWindow: 40,
  injectWorkspaceTree: true,
  maxReadBytes: 256 * 1024,
  ignore: [
    'node_modules',
    '.git',
    'dist',
    'out',
    'build',
    'release',
    '.next',
    '.nuxt',
    '.venv',
    'venv',
    '__pycache__',
    '.idea',
    '.vscode',
    'target',
    'vendor',
    '.cache',
    'coverage'
  ],
  githubBaseURL: 'https://api.github.com',

  permissionMode: 'smart',

  shellEnabled: false,
  shellCwd: null,
  shellTimeoutMs: 60_000,
  shellAllowlist: [],
  // 这些命令能在几秒内造成不可逆损害，默认拉黑。
  // 用户如需使用必须自己从列表里删掉——刻意制造的摩擦。
  shellDenylist: ['format', 'diskpart', 'mkfs', 'shutdown', 'reboot', 'rm', 'del', 'rd'],

  screenCapture: false,
  screenInput: false,
  screenHumanize: true,
  screenMaxEdge: 1600,
  screenDisplayId: null,
  screenWindowAllowlist: []
}

/**
 * 数据目录。必须是惰性的：模块在 app ready 之前就可能被 import，
 * 此时 electron.app 尚未初始化，提前调用 getPath 会直接抛 TypeError。
 */
export const dataDir = (): string => path.join(app.getPath('userData'), 'data')

// 存储实例也延迟到首次使用时创建，避免模块加载期就访问 dataDir()
let settingsFileInstance: JsonFile<AppSettings> | null = null
let providersFileInstance: JsonFile<ProviderConfig[]> | null = null
let workspacesFileInstance: JsonFile<Workspace[]> | null = null
let secretsFileInstance: JsonFile<Record<string, string>> | null = null

const settingsFile = (): JsonFile<AppSettings> =>
  (settingsFileInstance ??= new JsonFile<AppSettings>(path.join(dataDir(), 'settings.json'), DEFAULT_SETTINGS))

const providersFile = (): JsonFile<ProviderConfig[]> =>
  (providersFileInstance ??= new JsonFile<ProviderConfig[]>(path.join(dataDir(), 'providers.json'), []))

const workspacesFile = (): JsonFile<Workspace[]> =>
  (workspacesFileInstance ??= new JsonFile<Workspace[]>(path.join(dataDir(), 'workspaces.json'), []))

const secretsFile = (): JsonFile<Record<string, string>> =>
  (secretsFileInstance ??= new JsonFile<Record<string, string>>(path.join(dataDir(), 'secrets.json'), {}))

export const settingsStore = {
  /**
   * 读取设置并与默认值合并。
   *
   * 合并而非直接返回：旧版本的 settings.json 不含新增字段，
   * 直接返回会让 code 里 s.shellEnabled 拿到 undefined，
   * 在 if 判断里静默变成 false —— 表现为"设置项失灵"。
   */
  async get(): Promise<AppSettings> {
    const stored = await settingsFile().read()
    return { ...DEFAULT_SETTINGS, ...stored }
  },
  update: (mutate: (s: AppSettings) => AppSettings): Promise<AppSettings> =>
    settingsFile().update((s) => mutate({ ...DEFAULT_SETTINGS, ...s }))
}

export const providerStore = {
  list: (): Promise<ProviderConfig[]> => providersFile().read(),
  async save(provider: ProviderConfig): Promise<ProviderConfig[]> {
    return providersFile().update((list) => {
      const idx = list.findIndex((p) => p.id === provider.id)
      if (idx >= 0) list[idx] = provider
      else list.push(provider)
      return list
    })
  },
  async remove(id: string): Promise<ProviderConfig[]> {
    const next = await providersFile().update((list) => list.filter((p) => p.id !== id))
    await secretsFile().update((s) => {
      delete s[id]
      return s
    })
    return next
  }
}

export const workspaceStore = {
  list: (): Promise<Workspace[]> => workspacesFile().read(),
  async save(ws: Workspace): Promise<Workspace[]> {
    return workspacesFile().update((list) => {
      const idx = list.findIndex((w) => w.id === ws.id)
      if (idx >= 0) list[idx] = ws
      else list.push(ws)
      return list
    })
  },
  async remove(id: string): Promise<Workspace[]> {
    return workspacesFile().update((list) => list.filter((w) => w.id !== id))
  }
}

/* ------------------------------------------------------------------ */
/* 密钥：safeStorage 加密后落盘，绝不明文存储                             */
/* ------------------------------------------------------------------ */

function encrypt(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(plain).toString('base64')}`
  }
  // 无系统密钥环（部分 Linux/无桌面环境）：明确标记为弱保护，UI 会提示
  return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`
}

function decrypt(stored: string): string {
  try {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
    }
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf8')
    }
  } catch {
    return ''
  }
  return ''
}

export const secretStore = {
  async set(id: string, plain: string): Promise<void> {
    await secretsFile().update((s) => {
      s[id] = encrypt(plain)
      return s
    })
  },
  async get(id: string): Promise<string | null> {
    const all = await secretsFile().read()
    const stored = all[id]
    if (!stored) return null
    const value = decrypt(stored)
    return value || null
  },
  async remove(id: string): Promise<void> {
    await secretsFile().update((s) => {
      delete s[id]
      return s
    })
  },
  async isWeaklyProtected(): Promise<boolean> {
    if (safeStorage.isEncryptionAvailable()) return false
    const all = await secretsFile().read()
    return Object.values(all).some((v) => v.startsWith('plain:'))
  }
}

/** 生成掩码：sk-abcdef...9f2a -> sk-••••••9f2a */
export function maskKey(key: string): string {
  if (key.length <= 8) return '••••'
  const head = key.slice(0, 3)
  const tail = key.slice(-4)
  return `${head}${'•'.repeat(6)}${tail}`
}

export function ensureDataDirsSync(): void {
  for (const dir of ['skills', 'sessions', 'logs']) {
    const p = path.join(dataDir(), dir)
    if (!existsSync(p)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('node:fs').mkdirSync(p, { recursive: true })
      } catch {
        /* 由后续写入时报错提示 */
      }
    }
  }
}
