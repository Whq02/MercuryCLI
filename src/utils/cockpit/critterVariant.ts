// ============================================================================
//  utils/cockpit/critterVariant — stable per-agent critter assignment + mood→pose
//  mapping (the assignment half of the critter family; the sprite pool is
//  utils/cockpit/critterData.ts).
//
//  Each agent gets its OWN creature from the critterData pool: a first-seen registry
//  hands the next variant to each new agent id, modulo the pool size — so the first
//  N agents each get a DISTINCT critter and, past the pool, it loops (agent N+1
//  reuses variant 0). Deterministic + zero-cost:
//  a module-scoped Map + a monotonic index, stable for the session, resets on reload.
//  LIVE: the SessionManagerView session
//  cards resolve their creature through critterForKey — stable per SESSION KEY,
//  where the old index-positional pick reshuffled every card as the list reordered.
//
//  KEYING. The variant is assigned by the critter key (`critterKeyFor`, defined
//  here): the MAIN agent is keyed by its SESSION id (so each session's main agent
//  gets its own creature and EVERY surface — card, header, deck row — shows the
//  SAME critter for it), sub-agents/teammates key on their own id. Pass
//  critterKeyFor(agentId, sessionId) into critterVariantFor.
//
//  MOOD→POSE. `toCritterState` collapses Mercury's EIGHT BuddyState moods
//  (utils/cockpit/buddyState.ts) onto critterData's SIX poses — LIVE in the
//  DeckCompanion row (mood → pose glyph).
//  Mercury has no separate `greeting`/`celebrating` mood, so this
//  maps exactly the 8 Mercury produces — never invents a pose for a mood that
//  cannot occur.
//
//  PURE: no I/O, no Date, no Math.random, no React. The only state is the
//  session-lifetime assignment Map (intentional).
// ============================================================================

import type { BuddyState } from './buddyState.js'
import {
  CRITTER_COUNT,
  critterAt,
  type CritterDef,
  type CritterState,
} from './critterData.js'

/** The critter VARIANT KEY for an agent on a given session. The main agent
 *  ('main') is keyed by its SESSION id so each session's main agent gets its
 *  OWN creature and every surface shows the SAME critter for it;
 *  sub-agents/teammates key on their own id; falls back to 'main' when the
 *  session is unknown. */
export function critterKeyFor(agentId: string, sessionId: string | null | undefined): string {
  return agentId === 'main' ? sessionId || 'main' : agentId
}

const assigned = new Map<string, number>()
let nextVariant = 0

/** The critter variant index for an agent KEY — stable for the app's life, distinct
 *  per key until the pool is exhausted, then cycles. Pass `critterKeyFor(agentId,
 *  sessionId)` (NOT a raw agent id) so the main agent keys on its session. An empty
 *  key folds to variant 0 (crab) without registering. */
export function critterVariantFor(key: string | null | undefined): number {
  if (!key) return 0
  let v = assigned.get(key)
  if (v === undefined) {
    v = nextVariant % CRITTER_COUNT
    assigned.set(key, v)
    nextVariant += 1
    // FIFO cap — arbitrary keys on an app-lifetime map; eviction is cosmetic.
    if (assigned.size > 256) {
      const oldest = assigned.keys().next().value
      if (oldest !== undefined) assigned.delete(oldest)
    }
  }
  return v
}

/** The resolved critter DEF for an agent key — variant assignment + pool lookup in
 *  one call (the common case for a render site). Never throws; an empty key → crab. */
export function critterForKey(key: string | null | undefined): CritterDef {
  return critterAt(critterVariantFor(key))
}

/** Map Mercury's richer 8-mood BuddyState onto critterData's 6-pose set. Mercury
 *  produces exactly these eight (buddyState.ts) — no greeting/celebrating mood
 *  exists here, so this is total over the live union and invents nothing.
 *    thinking/focused → thinking   working → working   blocked/sad → blocked
 *    done → done   sleeping → sleeping   idle (default) → idle */
export function toCritterState(s: BuddyState): CritterState {
  switch (s) {
    case 'thinking':
    case 'focused':
      return 'thinking'
    case 'working':
      return 'working'
    case 'blocked':
    case 'sad':
      return 'blocked'
    case 'done':
      return 'done'
    case 'sleeping':
      return 'sleeping'
    case 'idle':
    default:
      return 'idle'
  }
}

