
import { mock } from 'bun:test'

type PublishFn = (
  path: string,
  contents: string | Uint8Array,
  opts?: unknown,
) => Promise<void>

const realNamespace = await import('../../src/substrate/durablePublish.ts')
const realExports = { ...realNamespace }
const realPublish = realNamespace.durableAtomicPublish as PublishFn

export interface PublishHold {
  readonly entered: Promise<string>
  readonly settled: Promise<void>
  release(): void
}

interface Hold {
  match: (path: string) => boolean
  claimed: boolean
  enter: (path: string) => void
  gate: Promise<void>
  open: () => void
  settle: () => void
}

const holds: Hold[] = []
const completed: string[] = []

const gatedPublish: PublishFn = async (path, contents, opts) => {
  const hold = holds.find(h => !h.claimed && h.match(path))
  if (hold) {
    hold.claimed = true
    hold.enter(path)
    await hold.gate
  }
  try {
    await realPublish(path, contents, opts)
  } finally {
    completed.push(path)
    hold?.settle()
  }
}

export function holdNextPublish(match: (path: string) => boolean): PublishHold {
  let enter!: (path: string) => void
  let open!: () => void
  let settle!: () => void
  const entered = new Promise<string>(res => {
    enter = res
  })
  const gate = new Promise<void>(res => {
    open = res
  })
  const settled = new Promise<void>(res => {
    settle = res
  })
  const hold: Hold = { match, claimed: false, enter, gate, open, settle }
  holds.push(hold)
  return {
    entered,
    settled,
    release: () => hold.open(),
  }
}

export function completionOrder(): string[] {
  return [...completed]
}

export function clearHolds(): void {
  for (const h of holds) h.open()
  holds.length = 0
}

export async function microturns(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>(res => setImmediate(res))
}

mock.module('../../src/substrate/durablePublish.ts', () => ({
  ...realExports,
  durableAtomicPublish: gatedPublish,
}))
