// ============================================================================
//  scripts/session-graph/crewFixture — the DETERMINISTIC crew-board-scale
//  fixture builder.
//
//  One seeded builder for every crew bench/prover: 32 agents · 100
//  conversations · 50k activity events · 1k review comments · 200 shelf
//  attachments (the floor — callers scale counts down for quick
//  lanes and up for the N-vs-10N law). Determinism: a mulberry32 PRNG over
//  the caller's seed drives every CHOICE, agent ids are founding-binding
//  derived and conversation ids are seed-adopted — identical (seed, counts)
//  ⇒ identical IDENTITIES and stream shapes (store timestamps are the
//  owners' own clocks and legitimately vary — wave B honesty).
//
//  The builder writes REAL owner stores (identity · conversations) through
//  their own APIs into an explicit scratch dir (proof-hygiene: never the
//  config home), and returns the activity-event STREAM as data — feeds fold
//  at the caller's pace so ingest cost is measured where it runs.
// ============================================================================

import type { ActivityInput } from '../../src/services/crew/activity.ts'

export interface CrewFixtureCounts {
  agents: number
  conversations: number
  /** Events appended across the conversations (ring-capped by the owner). */
  conversationEvents: number
  /** Activity seat-events returned as a stream (tool start/terminal pairs). */
  activityEvents: number
}

export interface CrewFixture {
  seed: number
  counts: CrewFixtureCounts
  agentIds: string[]
  conversationIds: string[]
  /** The deterministic activity stream (fold order = array order). */
  activityStream: ActivityInput[]
}

/** mulberry32 — small, seeded, deterministic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TOOLS = ['Edit', 'Bash', 'Read', 'Write', 'AskUserQuestion'] as const
const EVENT_KINDS = ['message', 'question', 'activity', 'delivery', 'review-request'] as const

/**
 * Build the fixture into `dir` (identity + conversation stores) and return
 * the deterministic activity stream. Counts default to the plan's floor.
 */
export async function buildCrewFixture(args: {
  seed: number
  /** Explicit scratch store root; omitted = the process default store (the
   *  env-scratched home in every bench/prover world). */
  dir?: string
  counts?: Partial<CrewFixtureCounts>
}): Promise<CrewFixture> {
  const counts: CrewFixtureCounts = {
    agents: args.counts?.agents ?? 32,
    conversations: args.counts?.conversations ?? 100,
    conversationEvents: args.counts?.conversationEvents ?? 1000,
    activityEvents: args.counts?.activityEvents ?? 50_000,
  }
  const rand = mulberry32(args.seed)
  const identity = await import('../../src/services/crew/identity.ts')
  const conversations = await import('../../src/services/crew/conversations.ts')

  const agentIds: string[] = []
  for (let i = 0; i < counts.agents; i++) {
    const a = await identity.ensureAgentIdentity({
      displayName: `Agent ${String(i).padStart(2, '0')}`,
      binding: { bindingKind: 'adapter', bindingId: `fx-seat-${args.seed}-${i}`, adapterKind: 'claude-code' },
      ...(args.dir !== undefined ? { dir: args.dir } : {}),
    })
    agentIds.push(a.agentId as string)
  }

  const conversationIds: string[] = []
  for (let i = 0; i < counts.conversations; i++) {
    const c = await conversations.mintConversation({
      kind: (['work', 'console-side', 'direct'] as const)[Math.floor(rand() * 3)]!,
      title: `fixture thread ${String(i).padStart(3, '0')}`,
      participants: [{ kind: 'agent', agentId: agentIds[Math.floor(rand() * agentIds.length)]! as never }],
      // Seed-adopted ids — deterministic across runs (never randomUUID).
      adoptId: `cv-fx${args.seed}-${String(i).padStart(4, '0')}` as never,
      ...(args.dir !== undefined ? { dir: args.dir } : {}),
    })
    conversationIds.push(c.conversationId as string)
  }
  for (let i = 0; i < counts.conversationEvents; i++) {
    const conversationId = conversationIds[Math.floor(rand() * conversationIds.length)]!
    const kind = EVENT_KINDS[Math.floor(rand() * EVENT_KINDS.length)]!
    await conversations.appendConversationEvent(
      conversationId as never,
      {
        kind,
        label: `fx event ${i}`,
        ...(kind === 'question' || kind === 'review-request'
          ? { requiresResolution: rand() < 0.7 }
          : {}),
      },
      args.dir !== undefined ? { dir: args.dir } : undefined,
    )
  }

  // The activity stream: tool start + terminal pairs across agents/sessions —
  // every event carries the owner's own stable id (the M4 law), so a pair
  // folds into ONE row exactly as production frames do.
  const activityStream: ActivityInput[] = []
  const pairs = Math.floor(counts.activityEvents / 2)
  for (let i = 0; i < pairs; i++) {
    const agentIx = Math.floor(rand() * agentIds.length)
    const agentId = agentIds[agentIx]! as never
    const sessionId = `fx-session-${agentIx}`
    const tool = TOOLS[Math.floor(rand() * TOOLS.length)]!
    const toolId = `fxtool_${args.seed}_${i}`
    const failed = rand() < 0.1
    activityStream.push({
      event: {
        sourceEventId: `fx-msg-${i}-start`,
        kind: 'assistant',
        payload: {
          type: 'assistant',
          message: {
            id: `fxm-${i}`,
            content: [
              {
                type: 'tool_use',
                id: toolId,
                name: tool,
                input: tool === 'Bash' ? { command: `run step ${i}` } : { file_path: `src/fx-${i % 97}.ts` },
              },
            ],
          },
        },
        atMs: 1_000_000 + i * 2,
      },
      agentId,
      sessionId,
      adapterKind: 'claude-code',
    })
    activityStream.push({
      event: {
        sourceEventId: `fx-msg-${i}-end`,
        kind: 'user',
        payload: {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: toolId, is_error: failed }] },
        },
        atMs: 1_000_000 + i * 2 + 1,
      },
      agentId,
      sessionId,
      adapterKind: 'claude-code',
    })
  }

  return { seed: args.seed, counts, agentIds, conversationIds, activityStream }
}
