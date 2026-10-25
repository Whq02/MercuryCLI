export interface ToolCallAccumulator {
  index: number
  id?: string
  name?: string
  argumentsRaw: string
}

export function toolCallId(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
}

function isJsonArgumentsClosed(raw: string): boolean {
  const stack: string[] = []
  let quoted = false
  let escaped = false
  let started = false
  let closed = false
  for (const char of raw) {
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (/\s/.test(char)) continue
    if (closed) return false
    if (char === '{' || char === '[') {
      started = true
      stack.push(char === '{' ? '}' : ']')
    } else if (!started) return false
    else if (char === '"') quoted = true
    else if (char === '}' || char === ']') {
      if (stack.pop() !== char) return false
      closed = stack.length === 0
    }
  }
  return closed && !quoted
}

export function toolCallSlot(
  acc: Map<number, ToolCallAccumulator>,
  activeSlotByRawIndex: Map<number, number>,
  index: number | undefined,
  id: string | undefined,
  name: string | undefined,
): number {
  const slots = [...acc.values()]
  const fresh = (): number => (slots.length === 0 ? 0 : Math.max(...slots.map(s => s.index)) + 1)
  if (index !== undefined) {
    const active = activeSlotByRawIndex.get(index)
    if (active === undefined) {
      const slot = acc.has(index) ? fresh() : index
      activeSlotByRawIndex.set(index, slot)
      return slot
    }
    const existing = acc.get(active)
    const owner = id === undefined ? undefined : slots.find(s => s.id === id)
    if (owner !== undefined) {
      activeSlotByRawIndex.set(index, owner.index)
      return owner.index
    }
    if (existing?.id && existing.name && id !== undefined && id !== existing.id && name !== undefined &&
        (name !== existing.name || isJsonArgumentsClosed(existing.argumentsRaw))) {
      const slot = fresh()
      activeSlotByRawIndex.set(index, slot)
      return slot
    }
    return active
  }
  const last = slots.at(-1)
  if (id !== undefined) {
    const owner = slots.find(s => s.id === id)
    if (owner) return owner.index
    if (name === undefined && last && !isJsonArgumentsClosed(last.argumentsRaw)) return last.index
    return fresh()
  }
  if (!last) return 0
  if (name !== undefined && last.name !== undefined && last.name !== name) return fresh()
  return last.index
}
