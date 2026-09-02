
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import type { Attachment } from './types.js'
import type { Message } from 'src/types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { cacheKeys } from '../fileStateCache.js'
import { getOriginalCwd } from '../../bootstrap/state.js'

interface PriorCapsule {
  digest: string
  refs: string[]
  semDigest?: string
}

const lastAttached = new Map<string, { digest: string; refs: string[] }>()

export function getLastAttachedCapsule(ownerKey: string): { digest: string; refs: string[] } | null {
  return lastAttached.get(ownerKey) ?? null
}

export function capsuleContinuationLine(ownerKey: string, maxRefs = 8): string | null {
  const last = lastAttached.get(ownerKey)
  if (!last) return null
  const paths = last.refs.map(r => r.replace('mercury://file/', '')).slice(0, maxRefs)
  const more = last.refs.length > paths.length ? ` …+${last.refs.length - paths.length}` : ''
  return `Working set (context capsule ${last.digest}): ${paths.join(', ')}${more}`
}

export function _resetContextCapsuleForTesting(): void {
  lastAttached.clear()
}

const CARRIER_PREFIXES = [
  '<system-reminder',
  '<local-command',
  '<command-name',
  '<command-message',
  '<task-notification',
  '<teammate-message',
]

export function latestUserTaskText(messages: readonly Message[] | undefined): string | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { type?: string; message?: { content?: unknown } }
    if (m?.type !== 'user') continue
    const content = m.message?.content
    let text: string | null = null
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      const blocks = (content as Array<{ type?: string; text?: string }>).filter(
        b => b.type === 'text' && typeof b.text === 'string',
      )
      text = blocks.length > 0 ? blocks.map(b => b.text).join('\n') : null
    }
    if (!text) continue
    const trimmed = text.trim()
    if (!trimmed) continue
    if (CARRIER_PREFIXES.some(p => trimmed.startsWith(p))) continue
    return trimmed
  }
  return null
}

export function priorCapsuleFromTranscript(messages: readonly Message[] | undefined): PriorCapsule | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as {
      type?: string
      attachment?: { type?: string; digest?: string; refs?: string[]; semDigest?: string }
    }
    if (m?.type === 'attachment' && m.attachment?.type === 'context_capsule') {
      return {
        digest: m.attachment.digest ?? '',
        refs: m.attachment.refs ?? [],
        ...(m.attachment.semDigest !== undefined ? { semDigest: m.attachment.semDigest } : {}),
      }
    }
  }
  return null
}

export function capsuleShouldEmit(
  prior: PriorCapsule | null,
  next: { digest: string; semDigest: string; refs: readonly string[] },
): boolean {
  if (!prior) return true
  if (prior.digest === next.digest) return false
  const priorRefs = new Set(prior.refs)
  if (
    prior.semDigest !== undefined &&
    prior.semDigest === next.semDigest &&
    next.refs.every(r => priorRefs.has(r))
  ) {
    return false
  }
  return true
}

function deltaLine(prior: PriorCapsule, refs: string[]): string | null {
  const prev = new Set(prior.refs)
  const next = new Set(refs)
  const added = refs.filter(r => !prev.has(r)).slice(0, 5)
  const removed = prior.refs.filter(r => !next.has(r)).slice(0, 5)
  if (added.length === 0 && removed.length === 0) return null
  const parts: string[] = []
  if (added.length > 0) parts.push(`+${added.map(r => r.replace('mercury://file/', '')).join(', ')}`)
  if (removed.length > 0) parts.push(`−${removed.map(r => r.replace('mercury://file/', '')).join(', ')}`)
  return parts.join(' · ')
}

export async function getContextCapsuleAttachment(
  input: string | null,
  messages: readonly Message[] | undefined,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  try {
    const { projectIntelEnabled } =
      require('../../services/projectIntel/contracts.js') as typeof import('../../services/projectIntel/contracts.js')
    if (!projectIntelEnabled()) return []
    const inputTask = (() => {
      const trimmed = (input ?? '').trim()
      if (!trimmed) return null
      if (CARRIER_PREFIXES.some(p => trimmed.startsWith(p))) return null
      return trimmed
    })()
    const task = inputTask ?? latestUserTaskText(messages)
    if (!task) return []

    const { assembleContextCapsule, renderCapsule } =
      require('../../services/projectIntel/capsule.js') as typeof import('../../services/projectIntel/capsule.js')
    const { getActiveMission } =
      require('../hooks/missionHook.js') as typeof import('../hooks/missionHook.js')

    const workspace = getOriginalCwd()
    const recentAbs = cacheKeys(toolUseContext.readFileState).slice(-10)
    const recentFiles = recentAbs
      .map(p => (p.startsWith(workspace) ? relative(workspace, p) : p))
      .filter(p => !p.startsWith('..') && !p.startsWith('/'))

    let goal: string | null = null
    if (!toolUseContext.agentId) {
      try {
        goal = getActiveMission()?.condition ?? null
      } catch {
        goal = null
      }
    }

    const { ownerFromToolUseContext } =
      require('../../services/run/resolveOwner.js') as typeof import('../../services/run/resolveOwner.js')
    const { describeOwner, MAIN_LANE, makeOwnerKey, parseOwnerKey } =
      require('../../services/primitives/owner.js') as typeof import('../../services/primitives/owner.js')
    const { getContextMarks } =
      require('../../services/projectIntel/pins.js') as typeof import('../../services/projectIntel/pins.js')
    const laneOwner = ownerFromToolUseContext(toolUseContext)
    const marksOwner =
      describeOwner(laneOwner).parent ??
      makeOwnerKey({ ...parseOwnerKey(laneOwner), lane: MAIN_LANE })
    const { pins, drops } = getContextMarks(marksOwner)

    const semDigest = createHash('sha256')
      .update(JSON.stringify({ task, goal, pins: [...pins].sort(), drops: [...drops].sort() }))
      .digest('hex')
      .slice(0, 12)
    const prior = priorCapsuleFromTranscript(messages)
    const semanticallyUnchanged =
      prior !== null && prior.semDigest !== undefined && prior.semDigest === semDigest

    const { getProjectSnapshotAsync } =
      require('../../services/projectIntel/snapshot.js') as typeof import('../../services/projectIntel/snapshot.js')
    const snapshotRead = await getProjectSnapshotAsync(workspace, {
      maxStaleMs: semanticallyUnchanged ? Number.POSITIVE_INFINITY : 120_000,
    })
    const capsule = assembleContextCapsule({
      workspace,
      task,
      goal,
      recentFiles,
      pins,
      drops,
      snapshotRead,
    })
    if (!capsule || capsule.items.length === 0) return []
    if (!capsule.items.some(i => i.tier <= 4)) return []

    const refs = capsule.items.map(i => i.ref)
    if (!capsuleShouldEmit(prior, { digest: capsule.digest, semDigest, refs })) return []
    const delta = prior ? deltaLine(prior, refs) : null
    if (lastAttached.size > 64) {
      const oldest = lastAttached.keys().next().value
      if (oldest !== undefined) lastAttached.delete(oldest)
    }
    lastAttached.set(String(laneOwner), { digest: capsule.digest, refs })

    return [
      {
        type: 'context_capsule',
        markdown: renderCapsule(capsule),
        digest: capsule.digest,
        semDigest,
        refs,
        delta,
      },
    ]
  } catch {
    return []
  }
}
