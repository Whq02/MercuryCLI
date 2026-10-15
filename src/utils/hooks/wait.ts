import type { HookProgress } from '../../types/hooks.js'
import type { ProgressMessage } from '../../types/message.js'
import type { HookEvent } from './contract.js'

type HookWait = { event: HookEvent; names: string[]; sinceMs: number; timeoutS: number }

export function hookWaitWords(wait: HookWait, nowMs: number): string {
  const elapsedS = Math.max(0, Math.floor((nowMs - wait.sinceMs) / 1000))
  const clock = wait.timeoutS > 0 ? `${elapsedS} s of ${Math.round(wait.timeoutS)}` : `${elapsedS} s`
  if (wait.names.length === 1) return `waiting on hook ${wait.names[0]} · ${clock}`
  return `waiting on ${wait.names.length} ${wait.event} hooks (${wait.names.join(', ')}) · ${clock}`
}

export function hookWaitLineOf(frames: ReadonlyArray<ProgressMessage | undefined>): string | null {
  for (let index = frames.length - 1; index >= 0; index--) {
    const data = frames[index]?.data as Partial<HookProgress> | undefined
    if (data?.type === 'hook_progress' && data.state === 'waiting' && typeof data.line === 'string' && data.line !== '') return data.line
  }
  return null
}
