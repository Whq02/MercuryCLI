
export const ROAD_BUDGET_MS = 400
export const KEEP_ALIVE_EVERY_MS = 40
export const KEEP_ALIVES = 30

export interface RoadFixture {
  fetchImpl: typeof fetch
  sent: () => number
  cancelled: () => boolean
}

const encoder = new TextEncoder()

export function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export function roadFixture(args: { head: string[]; tail: string[]; silence: boolean; status?: number }): RoadFixture {
  let sent = 0
  let cancelled = false
  let interval: ReturnType<typeof setInterval> | undefined
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    let opened: ReadableStreamDefaultController<Uint8Array> | null = null
    const body = new ReadableStream<Uint8Array>({
      start(sink) {
        opened = sink
        const push = (text: string): void => {
          try {
            sink.enqueue(encoder.encode(text))
          } catch {
          }
        }
        for (const chunk of args.head) push(chunk)
        if (args.silence) return
        interval = setInterval(() => {
          if (init?.signal?.aborted) {
            clearInterval(interval)
            return
          }
          sent++
          push(': keep-alive\n\n')
          if (sent === KEEP_ALIVES) {
            clearInterval(interval)
            for (const chunk of args.tail) push(chunk)
            try {
              sink.close()
            } catch {
            }
          }
        }, KEEP_ALIVE_EVERY_MS)
      },
      cancel() {
        cancelled = true
        clearInterval(interval)
      },
    })
    init?.signal?.addEventListener(
      'abort',
      () => {
        clearInterval(interval)
        try {
          opened?.error(new DOMException('fixture abort', 'AbortError'))
        } catch {
        }
      },
      { once: true },
    )
    return new Response(body, { status: args.status ?? 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return { fetchImpl, sent: () => sent, cancelled: () => cancelled }
}

export const idleFaultWords = (budgetMs: number): string => `no bytes for ${budgetMs}ms`
