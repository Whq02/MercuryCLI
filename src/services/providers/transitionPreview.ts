// ============================================================================
//  providers/transitionPreview — the transition preview builder.
//
//  Builds the ONE frozen TransitionPlan (utils/model/modelTransition.ts owns
//  the vocabulary) for "what would switching this history to <target> do",
//  with per-item typed dispositions computed against the REAL encode truth:
//    · openai targets — replay-carry read off the actual toBridgeMessages
//      walk (the sameModel guard's own output, never re-derived);
//      thinking/unknown drops per responsesBridge; images by the lane's
//      live-modality rule (permissive default, caller passes the live
//      verdict when it has one);
//    · zai targets — zaiCodec law: thinking dropped, images/unknown
//      degrade to '[<type>]', replay records never carried;
//    · anthropic targets — native carry; OpenAI continuation records stop
//      being read (stateless-replay-reset), nothing else moves.
//  prove-transition-transition-plan pins planner ≡ codec on the same history (the
//  parity-oracle pattern) — codec drift breaks the prover, not silently
//  the preview.
//
//  The plan is FROZEN (deep) and digest-addressed (changeSetPlan form);
//  it never writes state — settlement stays with settleModelSelection.
// ============================================================================
import { createHash } from 'node:crypto'
import type { Message } from '../../types/message.js'
import {
  confirmTransitionPlan,
  MEANINGFUL_LOSS_CLASSES,
  providerFamilyOfSetting,
  type ProviderFamily,
  type TransitionDispositionClass,
  type TransitionPlan,
  type TransitionPlanItem,
} from '../../utils/model/modelTransition.js'
import { isUnsignedThinkingBlock } from '../../utils/messages.js'

import { toBridgeMessages } from './openai/openaiCallModel.js'

const sha256Hex = (data: string): string =>
  createHash('sha256').update(data).digest('hex')

/** Bounded lossy-item carry — the counts stay total; the item list caps
 *  EXPLICITLY (itemsTruncated), never silently. */
const MAX_PLAN_ITEMS = 200

/** History identity at preview time: count · last uuid · last timestamp.
 *  Append-only histories make this an honest staleness key. */
export function transitionSourceRevision(messages: readonly Message[]): string {
  const last = messages.at(-1) as
    | { uuid?: string; timestamp?: string }
    | undefined
  return sha256Hex(
    JSON.stringify([messages.length, last?.uuid ?? '', last?.timestamp ?? '']),
  )
}

/** The capability facts the dispositions depend on — a flip regenerates. */
export function transitionCapabilityEpoch(
  to: string | null,
  imagesSupported: boolean,
): string {
  return sha256Hex(
    JSON.stringify([providerFamilyOfSetting(to), imagesSupported]),
  )
}

/** The default image-modality rule build AND reconfirm derive from — ONE
 *  owner, because the two drifting is the engine-lane confirm deadlock:
 *  reconfirm kept a zai-only spelling while build treated EVERY engine lane
 *  as image-degrading, so for moonshot/deepseek/gemini/openrouter/
 *  huggingface/local/compat targets the confirm-time capabilityEpoch never
 *  equalled the plan's and every confirm press re-presented 'refreshed'
 *  forever. The lanes as wired degrade images to text markers everywhere
 *  except the two native wires. */
function defaultImagesSupported(targetRoute: ProviderFamily): boolean {
  return targetRoute === 'anthropic' || targetRoute === 'openai'
}

type Blocks = ReadonlyArray<{ type?: string }>

function blocksOf(m: Message): Blocks {
  const content = (m as { message?: { content?: unknown } }).message?.content
  return Array.isArray(content) ? (content as Blocks) : []
}

export function buildTransitionPlan(args: {
  messages: readonly Message[]
  from: string | null
  to: string | null
  /** The target's live image-modality verdict, when the caller resolved a
   *  catalogue candidate; defaults to the lane rule (openai permissive ·
   *  zai never · anthropic native). */
  imagesSupported?: boolean
}): TransitionPlan {
  const { messages, from, to } = args
  const targetRoute = providerFamilyOfSetting(to)
  const crossProvider =
    providerFamilyOfSetting(from) !== providerFamilyOfSetting(to)
  const imagesSupported = args.imagesSupported ?? defaultImagesSupported(targetRoute)

  const counts: Record<TransitionDispositionClass, number> = {
    'carried-exact': 0,
    'tool-results-exact': 0,
    'thinking-continuity-reset': 0,
    'stateless-replay-reset': 0,
    'image-degraded': 0,
    'unknown-block-degraded': 0,
  }
  const items: TransitionPlanItem[] = []
  let itemsTruncated = false
  const addItem = (item: TransitionPlanItem): void => {
    if (items.length >= MAX_PLAN_ITEMS) {
      itemsTruncated = true
      return
    }
    items.push(item)
  }

  // Replay-carry truth for openai targets: the REAL walk's own per-row
  // verdict (the sameModel guard), aligned by construction — every
  // user/assistant message emits exactly one bridge row, in order.
  const replayCarried = new Map<string, boolean>()
  if (targetRoute === 'openai' && typeof to === 'string') {
    const walkable = messages.filter(
      m => m.type === 'user' || m.type === 'assistant',
    )
    const bridge = toBridgeMessages(walkable as Message[], undefined as never, to)
    walkable.forEach((m, i) => {
      const row = bridge.rows[i] as { turnRecord?: unknown } | undefined
      replayCarried.set(
        (m as { uuid: string }).uuid,
        Boolean(row && row.turnRecord),
      )
    })
  }

  for (const m of messages) {
    if (m.type !== 'user' && m.type !== 'assistant') continue
    const uuid = (m as { uuid: string }).uuid
    const blocks = blocksOf(m)
    let lossless = true

    if (m.type === 'assistant') {
      // Non-anthropic targets: NO thinking rides the wire. The anthropic
      // target replays its own signed thinking but STRIPS foreign unsigned
      // blocks (stripUnsignedThinkingBlocks — the shared predicate keeps
      // this count equal to what the wire drops).
      const thinkingBlocks =
        targetRoute !== 'anthropic'
          ? blocks.filter(
              b => b.type === 'thinking' || b.type === 'redacted_thinking',
            ).length
          : blocks.filter(b => isUnsignedThinkingBlock(b)).length
      if (thinkingBlocks > 0) {
        counts['thinking-continuity-reset'] += thinkingBlocks
        addItem({
          ref: uuid,
          disposition: 'thinking-continuity-reset',
          detail:
            targetRoute !== 'anthropic'
              ? `${thinkingBlocks} thinking block(s) never round-trip to the ${targetRoute} wire`
              : `${thinkingBlocks} foreign (unsigned) thinking block(s) are dropped at the anthropic wire`,
        })
        lossless = false
      }
      const hasRecord = Boolean(
        (m as { apexProviderTurn?: unknown }).apexProviderTurn,
      )
      if (hasRecord) {
        const carried =
          targetRoute === 'openai' ? (replayCarried.get(uuid) ?? false) : false
        if (!carried) {
          counts['stateless-replay-reset'] += 1
          addItem({
            ref: uuid,
            disposition: 'stateless-replay-reset',
            detail:
              targetRoute === 'openai'
                ? 'continuation record is model-bound (the sameModel guard) — content replays from the transcript'
                : 'OpenAI continuation record is not consumed by this lane',
          })
          lossless = false
        }
      }
    }

    for (const b of blocks) {
      const t = b.type
      if (t === 'tool_use' || t === 'tool_result') {
        counts['tool-results-exact'] += 1
      } else if (t === 'image') {
        if (targetRoute !== 'anthropic' && !imagesSupported) {
          counts['image-degraded'] += 1
          addItem({
            ref: uuid,
            disposition: 'image-degraded',
            detail: `image degrades to a '[image]' placeholder on the ${targetRoute} wire`,
          })
          lossless = false
        }
      } else if (
        t !== undefined &&
        t !== 'text' &&
        t !== 'thinking' &&
        t !== 'redacted_thinking' &&
        t !== 'document'
      ) {
        if (targetRoute !== 'anthropic') {
          counts['unknown-block-degraded'] += 1
          addItem({
            ref: uuid,
            disposition: 'unknown-block-degraded',
            detail: `'${t}' degrades to a '[${t}]' placeholder`,
          })
          lossless = false
        }
      }
    }

    if (lossless) counts['carried-exact'] += 1
  }

  const sourceRevision = transitionSourceRevision(messages)
  const capabilityEpoch = transitionCapabilityEpoch(to, imagesSupported)
  const needsChoice = MEANINGFUL_LOSS_CLASSES.some(cls => counts[cls] > 0)
  const planDigest = sha256Hex(
    JSON.stringify({
      v: 1,
      from,
      to,
      targetRoute,
      sourceRevision,
      capabilityEpoch,
      counts: Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
      items: items.map(i => [i.ref, i.disposition]),
      itemsTruncated,
    }),
  )

  const plan: TransitionPlan = {
    v: 1,
    planDigest,
    from,
    to,
    crossProvider,
    targetRoute,
    sourceRevision,
    capabilityEpoch,
    counts,
    items: items.map(i => Object.freeze(i)) as TransitionPlanItem[],
    itemsTruncated,
    needsChoice,
    computedAt: new Date().toISOString(),
  }
  Object.freeze(plan.items)
  Object.freeze(plan.counts)
  return Object.freeze(plan)
}

/** The pick-site convenience: the plan for a REAL model change (the caller
 *  already knows no-ops from the settlement owner's decision). */
export function previewForSelection(
  messages: readonly Message[],
  from: string | null,
  to: string | null,
): TransitionPlan {
  return buildTransitionPlan({ messages, from, to })
}

/** Stale-safe reconfirmation for a pick site: re-derives the CURRENT
 *  sourceRevision + capabilityEpoch under the same gate inputs the plan
 *  was built with, applies the ratified confirm law, and hands back a
 *  REGENERATED plan on staleness (A02: confirmation rejects stale and
 *  regenerates — the caller re-presents, never silently applies). */
export function reconfirmTransitionPlan(
  plan: TransitionPlan,
  messages: readonly Message[],
):
  | { ok: true }
  | { ok: false; reason: 'stale-source' | 'stale-capability'; freshPlan: TransitionPlan } {
  const imagesSupported = defaultImagesSupported(plan.targetRoute)
  const verdict = confirmTransitionPlan(plan, {
    sourceRevision: transitionSourceRevision(messages),
    capabilityEpoch: transitionCapabilityEpoch(plan.to, imagesSupported),
  })
  if (verdict.ok) return verdict
  return {
    ...verdict,
    freshPlan: buildTransitionPlan({ messages, from: plan.from, to: plan.to }),
  }
}

/** One operator-readable loss summary for a plan with meaningful loss —
 *  the typed dispositions in plain words, nonzero classes only, stable
 *  order. Empty string when the plan needs no choice. */
export function transitionPlanSummary(plan: TransitionPlan): string {
  if (!plan.needsChoice) return ''
  const parts: string[] = []
  const c = plan.counts
  if (c['thinking-continuity-reset'] > 0) {
    parts.push(`${c['thinking-continuity-reset']} thinking span(s) reset`)
  }
  if (c['stateless-replay-reset'] > 0) {
    parts.push(`${c['stateless-replay-reset']} continuation record(s) reset`)
  }
  if (c['image-degraded'] > 0) {
    parts.push(`${c['image-degraded']} image(s) degrade to placeholders`)
  }
  if (c['unknown-block-degraded'] > 0) {
    parts.push(`${c['unknown-block-degraded']} unsupported block(s) degrade to placeholders`)
  }
  return ` · this switch: ${parts.join(' · ')} — text and tool results replay exactly (plan ${plan.planDigest.slice(0, 8)})`
}
