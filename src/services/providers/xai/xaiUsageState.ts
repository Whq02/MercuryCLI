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
export type XaiKeyProbe =
  | { state: 'confirmed'; balance: XaiObservedBalance }
  | { state: 'refused'; status: number }
  | { state: 'unreachable'; message: string }

export function xaiObservedBalance(_env: NodeJS.ProcessEnv = process.env): XaiObservedBalance | null {
  return null
}
export function __resetXaiUsageForTest(): void {}
export function decodeXaiBalance(_body: unknown, _nowMs: number): XaiObservedBalance | undefined {
  return undefined
}
export async function fetchXaiBalance(
  _key: string,
  _io?: { fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number },
): Promise<XaiKeyProbe> {
  return { state: 'unreachable', message: 'credits are not reported by the xAI inference API' }
}
export function refreshXaiBalance(_io?: {
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  now?: () => number
  force?: boolean
}): Promise<XaiObservedBalance | null> {
  return Promise.resolve(null)
}
