import type { CompactMetadata, Message } from '../../types/message.js'
import { compactWorkOf } from './turnReceipt.js'
import { isMercurySubstrateProfileOn } from '../config.js'
import { isEnvTruthy } from '../envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isOperatorTurn } from '../messages/operatorTurns.js'
import { notBuilt } from '../../pi/holes.js'


export function isAwaySummaryEnabled(): boolean {
  
  const flag = flagEnv('MERCURY_AWAY_SUMMARY')
  if (flag === '0' || flag?.toLowerCase() === 'false') return false
  if (isEnvTruthy(flag)) return true
  return isMercurySubstrateProfileOn()
}

export function humanGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  return `${d}d ago`
}

type Block = { type?: string; id?: string; name?: string; input?: unknown; text?: string }

function isSyntheticResumeAssistant(m: Message): boolean {
  if (m.type !== 'assistant') return false
  const content = (m as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content === 'No response requested.'
  if (Array.isArray(content) && content.length === 1) {
    const b = content[0] as Block
    return b?.type === 'text' && b.text === 'No response requested.'
  }
  return false
}

function isSyntheticOrMeta(m: Message): boolean {
  if (isSyntheticResumeAssistant(m)) return true
  const um = m as { isMeta?: boolean }
  return um.isMeta === true
}

function filesOf(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const o = input as Record<string, unknown>
  const out: string[] = []
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = o[k]
    if (typeof v === 'string' && v.length > 0) {
      out.push(v)
      break
    }
  }
  if (Array.isArray(o.changes)) {
    for (const change of o.changes as Array<{ file_path?: unknown }>) {
      if (typeof change?.file_path === 'string' && change.file_path.length > 0) out.push(change.file_path)
    }
  }
  return out
}

type AwayRecap = {
  line: string
  endedOnError: boolean
  turns: number
  filesTouched: number
  topTools: string
  toolFailures: number
  lastActiveGapMs?: number
  gitDelta?: { files: number; added: number; removed: number } | null
}

export function buildAwayRecap(
  messages: Message[],
  nowMs: number,
  gitDelta?: { files: number; added: number; removed: number } | null,
): AwayRecap | null {
  return notBuilt('src/utils/cockpit/awaySummary.ts:77')
}

export function buildAwaySummary(
  messages: Message[],
  nowMs: number,
  gitDelta?: { files: number; added: number; removed: number } | null,
): string | null {
  return buildAwayRecap(messages, nowMs, gitDelta)?.line ?? null
}

export function collectAwayWork(
  messages: Message[],
  excludedUuids?: ReadonlySet<string>,
): NonNullable<CompactMetadata['work']>['recap'] {
  return notBuilt('src/utils/cockpit/awaySummary.ts:150')
}
