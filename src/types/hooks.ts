import type { HookEvent } from '../utils/hooks/contract.js'

export type HookProgress = {
  type: 'hook_progress'
  event: HookEvent
  name: string
  state: 'running' | 'ran' | 'waiting'
  count: number
  timeoutS?: number
  elapsedS?: number
  line?: string
}
