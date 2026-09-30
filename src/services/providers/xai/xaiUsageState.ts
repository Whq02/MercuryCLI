export const XAI_SURFACES_LANE_STUB = 'stub for the xai surfaces lane — replaced by the xai wire lane at the fold' as const
export interface XaiBalanceInfo {
  currency: string
  totalBalance: string
  grantedBalance?: string
  toppedUpBalance?: string
}

export interface XaiObservedBalance {
  observedAtMs: number
  isAvailable: boolean
  balances: XaiBalanceInfo[]
}

export function xaiObservedBalance(_env: NodeJS.ProcessEnv = process.env): XaiObservedBalance | null {
  return null
}

export function __resetXaiUsageForTest(): void {}

export function decodeXaiBalance(_body: unknown, _nowMs: number): XaiObservedBalance | undefined {
  return undefined
}

export type XaiKeyProbe =
  | { state: 'confirmed'; balance: XaiObservedBalance }
  | { state: 'refused'; status: number }
  | { state: 'unreachable'; message: string }

export async function fetchXaiBalance(
  _key: string,
  _io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<XaiKeyProbe> {
  return { state: 'unreachable', message: 'xAI key probe is not wired in this tree (stub)' }
}

export function refreshXaiBalance(_io?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
}): Promise<XaiObservedBalance | null> {
  return Promise.resolve(null)
}
