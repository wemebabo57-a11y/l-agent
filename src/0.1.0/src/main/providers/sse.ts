/**
 * Server-Sent Events 解析器。
 * 两家协议都是 SSE（Anthropic 用 event: 行 + data: 行，OpenAI 只用 data: 行），
 * 所以统一在这里做分帧，适配器只关心 payload。
 */
export interface SseFrame {
  event: string | null
  data: string
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE 事件以空行分隔；\r\n\r\n 与 \n\n 都要兼容
      for (;;) {
        const sep = findSeparator(buffer)
        if (!sep) break
        const rawFrame = buffer.slice(0, sep.index)
        buffer = buffer.slice(sep.index + sep.length)
        const frame = parseFrame(rawFrame)
        if (frame) yield frame
      }
    }
    // 收尾：流结束时缓冲区可能还有最后一帧（无空行结尾）
    buffer += decoder.decode()
    if (buffer.trim()) {
      const frame = parseFrame(buffer)
      if (frame) yield frame
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

function findSeparator(buffer: string): { index: number; length: number } | null {
  const a = buffer.indexOf('\n\n')
  const b = buffer.indexOf('\r\n\r\n')
  if (a < 0 && b < 0) return null
  if (a >= 0 && (b < 0 || a < b)) return { index: a, length: 2 }
  return { index: b, length: 4 }
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | null = null
  const dataLines: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue // 注释/心跳
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      // 规范：data: 后可选一个空格
      const v = line.slice(5)
      dataLines.push(v.startsWith(' ') ? v.slice(1) : v)
    }
  }
  if (!dataLines.length && !event) return null
  return { event, data: dataLines.join('\n') }
}
