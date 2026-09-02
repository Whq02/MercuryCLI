// ============================================================================
//  attachments/contextCapsule — the working-set attachment.
//
// Cadence law: attach ONE compact capsule when the task-scoped working
//  set is NEW or CHANGED; never re-attach an unchanged capsule. The dedup
//  cursor is the thread's own message history (the mcp_instructions_delta
//  pattern): the last context_capsule attachment VISIBLE in the window is
//  the prior — so compaction (window lost the block) naturally re-attaches,
//  resume re-validates against the live tree, and an aborted turn's
//  never-appended attachment re-announces. Nothing is consumed at collection
//  time; no side-band state is load-bearing.
//
//  The block is REFS + reasons (never bodies), carries its digest as a
//  needle, and names the delta vs the previous capsule when one existed.
//
//  EVERY thread gets its own capsule scoped to ITS OWN latest task text:
//  the main thread from the operator prompt, a subagent from its delegated
//  task (its first user message), a workflow node from its node prompt —
// which IS the scoping law (task-scoped capsule + explicit deliverable,
//  never the parent transcript), with sibling isolation by construction
//  (per-thread messages, per-owner keying). Attaches in headless -p too:
//  this is model-facing context assembly (the product mechanism itself),
//  not an operator chrome surface.
// ============================================================================

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
  /** Semantic identity (task+goal+marks) — item 7; absent on capsules
   *  attached before the churn law. */
  semDigest?: string
}

/** Last-attached capsule per owner — NON-load-bearing (dedup rides the
 *  transcript); consumed by the run continuation capsule so compaction
 *  retains the digest + primary refs deterministically. */
const lastAttached = new Map<string, { digest: string; refs: string[] }>()

export function getLastAttachedCapsule(ownerKey: string): { digest: string; refs: string[] } | null {
  return lastAttached.get(ownerKey) ?? null
}

/** The one deterministic continuation line compaction retains: the
 *  active capsule digest + its primary refs. Null when no capsule attached
 *  this process (the post-compaction attachment re-derives regardless). */
export function capsuleContinuationLine(ownerKey: string, maxRefs = 8): string | null {
  const last = lastAttached.get(ownerKey)
  if (!last) return null
  const paths = last.refs.map(r => r.replace('mercury://file/', '')).slice(0, maxRefs)
  const more = last.refs.length > paths.length ? ` …+${last.refs.length - paths.length}` : ''
  return `Working set (context capsule ${last.digest}): ${paths.join(', ')}${more}`
}

/** TEST-ONLY. */
export function _resetContextCapsuleForTesting(): void {
  lastAttached.clear()
}

/** Known carrier prefixes — reminder/command wrappers, never the task. A
 *  REAL prompt that happens to start with markup (an XML-framed delegation
 *  task, "<100 cols…") must NOT be skipped, so the check is prefix-exact. */
const CARRIER_PREFIXES = [
  '<system-reminder',
  '<local-command',
  '<command-name',
  '<command-message',
  '<task-notification',
  '<teammate-message',
]

/** The latest REAL user prompt text in the window (skips tool-result
 *  carriers, attachments, and known command/system wrappers; joins ALL
 *  text blocks of a multi-block prompt). */
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

/** Exported for the churn-law prover (the transcript IS the dedup cursor). */
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

/**
 * The ONE capsule cadence law. Emit when: no prior in the
 * window (first attach / post-compaction), semantic identity changed
 * (task/goal/marks), or a RELEVANT ENTRY appeared (a ref the prior lacked).
 * Never on exact-identity repeats, never on removals-only recency churn —
 * a field run's "+README.md · −docs/…" reprints informed
 * nothing. A pre-law prior (no semDigest) falls back to exact-digest dedup.
 */
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
    // The CURRENT turn's prompt rides `input` — on the FIRST request of a
    // session `messages` holds no user text yet (the severed-loop the after-
    // bench caught: a producer reading only history never fires on turn 1).
    // Tool-loop continuation passes carry input=null; history serves then.
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

    // The standing mission is a MAIN-lane fact — a subagent's working set keys
    // on its own delegated task, never the parent's mission. CONSTRAINT: the
    // `goal` name stays — it is the semantic-identity hash key below and the
    // capsule record's field; renaming it would drift every capsule identity.
    let goal: string | null = null
    if (!toolUseContext.agentId) {
      try {
        goal = getActiveMission()?.condition ?? null
      } catch {
        goal = null
      }
    }

    // Marks + the continuation record key on the MAIN-lane owner: operator
    // corrections are session facts (a child honors them too), and lane-
    // keyed reads would mint one store entry per subagent lane — enough
    // lanes could LRU-evict the operator's marks mid-session (audit C5).
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

    // Semantic identity FIRST (hot-path cadence C2a): everything the
    // semantic arm needs — task, goal, explicit marks — exists BEFORE any
    // snapshot work, and the cadence law's unchanged-identity arm suppresses
    // most collections. Paying the snapshot's digest/git work before that
    // cheap check meant an unchanged capsule still COST something every
    // collection. An unchanged identity reuses whatever snapshot is cached
    // (no freshness demand); the refs-superset arm below still runs against
    // the assembled capsule, and a cold workspace still builds once.
    const semDigest = createHash('sha256')
      .update(JSON.stringify({ task, goal, pins: [...pins].sort(), drops: [...drops].sort() }))
      .digest('hex')
      .slice(0, 12)
    const prior = priorCapsuleFromTranscript(messages)
    const semanticallyUnchanged =
      prior !== null && prior.semDigest !== undefined && prior.semDigest === semDigest

    // The drain path must never BLOCK on digest/git work: a bounded-stale
    // cached snapshot serves the SET; a genuinely cold or post-TTL read
    // (session start, resume) rides the ASYNC snapshot path — the ~1.5s
    // large-repo tree digest runs off-loop and producer deadline
    // stays enforceable (a sync build here blocked the loop and burst-
    // drained queued keypresses: the tasks-runs-only red).
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
      // `from` rides through: a cache-ttl read still excludes the changed
      // tier (the mid-session churn law in capsule.ts).
      snapshotRead,
    })
    if (!capsule || capsule.items.length === 0) return []
    // Task-evidence guard: a capsule with ONLY instruction/knowledge tiers
    // adds nothing the standing prompt lacks — attach only when task-anchored
    // or working-state evidence (tiers 1-4) selected something.
    if (!capsule.items.some(i => i.tier <= 4)) return []

    // Semantic identity: task + goal + explicit marks —
    // computed ABOVE, before the snapshot read (hot-path cadence C2a). The
    // refs digest alone re-emitted the WHOLE capsule on incidental recency
    // churn — reading any file shifted the last-10 tail, so the AVS field
    // run got "Working-set delta: +README.md · −docs/…" reprints that
    // informed nothing. Cadence: emit on semantic change, on a RELEVANT
    // ENTRY (a ref not present before), and never on removals-only churn.
    const refs = capsule.items.map(i => i.ref)
    if (!capsuleShouldEmit(prior, { digest: capsule.digest, semDigest, refs })) return []
    const delta = prior ? deltaLine(prior, refs) : null
    // The continuation record keys on the LANE owner (per-thread — a child's
    // capsule must never overwrite the main conversation's compaction
    // record; compact.ts advances the SAME per-lane owner). Recorded at
    // COLLECTION time — an aborted turn can leave a record the window never
    // saw; it self-heals post-compaction (the re-derived attachment wins).
    // Bounded like every session map.
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
    return [] // never block a turn on intelligence assembly
  }
}
