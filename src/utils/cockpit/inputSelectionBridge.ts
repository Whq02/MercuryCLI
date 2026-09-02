
type RangeFn = () => { start: number; end: number } | null

let consumer: RangeFn | null = null

export function registerInputSelectionConsumer(fn: RangeFn): () => void {
  consumer = fn
  return () => {
    if (consumer === fn) consumer = null
  }
}

export function peekInputSelectionRange(): { start: number; end: number } | null {
  try {
    return consumer?.() ?? null
  } catch {
    return null
  }
}
