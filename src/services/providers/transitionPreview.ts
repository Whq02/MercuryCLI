import { createHash } from 'node:crypto'
import { getSdkBetas } from '../../bootstrap/state.js'
import type { Message } from '../../types/message.js'
import { isConfigReadingAllowed } from '../../utils/config/globalConfig.js'
import { resolveContextWindow } from '../../utils/model/capabilities.js'
import { parseUserSpecifiedModel } from '../../utils/model/model.js'
import {
  confirmTransitionPlan,
  MEANINGFUL_LOSS_CLASSES,
  providerFamilyOfSetting,
  type ProviderFamily,
  type TransitionDispositionClass,
  type TransitionPlan,
  type TransitionPlanItem,
  type TransitionWindowFact,
} from '../../utils/model/modelTransition.js'
import { isUnsignedThinkingBlock } from '../../utils/messages.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages/systemMessages.js'
import { contextFill, usageAnchorModel } from '../../utils/tokens.js'
import { getBlockingLimit, resolveAutoCompactWindow } from '../compact/autoCompact.js'
import { declaredRouteOf } from './routeLaw.js'

import { toBridgeMessages } from './openai/openaiCallModel.js'

const sha256Hex = (data: string): string =>
  createHash('sha256').update(data).digest('hex')

const MAX_PLAN_ITEMS = 200

export function transitionSourceRevision(messages: readonly Message[]): string {
  const last = messages.at(-1) as
    | { uuid?: string; timestamp?: string }
    | undefined
  return sha256Hex(
    JSON.stringify([messages.length, last?.uuid ?? '', last?.timestamp ?? '']),
  )
}

export function transitionCapabilityEpoch(
  to: string | null,
  imagesSupported: boolean,
  window?: Pick<TransitionWindowFact, 'window' | 'limit'>,
): string {
  return sha256Hex(
    JSON.stringify([
      providerFamilyOfSetting(to),
      imagesSupported,
      ...(window !== undefined ? [window.window, window.limit] : []),
    ]),
  )
}

export function transitionWindowFact(
  messages: readonly Message[],
  to: string | null,
): TransitionWindowFact | undefined {
  if (!isConfigReadingAllowed()) return undefined
  const target = parseUserSpecifiedModel(to ?? 'best')
  if (declaredRouteOf(target) === null) return undefined
  const live = getMessagesAfterCompactBoundary(messages as Message[])
  const fenced = contextFill(live, target)
  const anchored = contextFill(live)
  const usageWins = anchored.source === 'usage' && anchored.tokens >= fenced.tokens
  const count = Math.max(fenced.tokens, anchored.tokens)
  const countModel = usageWins ? usageAnchorModel(live) : undefined
  const limit = getBlockingLimit(target)
  return {
    count,
    countSource: usageWins ? 'usage' : 'estimate',
    ...(countModel !== undefined ? { countModel } : {}),
    window: resolveAutoCompactWindow(target).window,
    windowSource: resolveContextWindow(target, getSdkBetas()).source,
    limit,
    fits: count < limit,
  }
}

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

  const replayCarried = new Map<string, boolean>()
  if (targetRoute === 'openai' && typeof to === 'string') {
    const walkable = messages.filter(
      m => m.type === 'user' || m.type === 'assistant',
    )
    const bridge = toBridgeMessages(walkable as Message[], to)
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
  const window = transitionWindowFact(messages, to)
  const capabilityEpoch = transitionCapabilityEpoch(to, imagesSupported, window)
  const needsChoice = MEANINGFUL_LOSS_CLASSES.some(cls => counts[cls] > 0) || window?.fits === false
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
      window: window === undefined ? null : [window.count, window.window, window.limit, window.fits],
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
    ...(window !== undefined ? { window: Object.freeze(window) } : {}),
    needsChoice,
    computedAt: new Date().toISOString(),
  }
  Object.freeze(plan.items)
  Object.freeze(plan.counts)
  return Object.freeze(plan)
}

export function previewForSelection(
  messages: readonly Message[],
  from: string | null,
  to: string | null,
): TransitionPlan {
  return buildTransitionPlan({ messages, from, to })
}

export function reconfirmTransitionPlan(
  plan: TransitionPlan,
  messages: readonly Message[],
):
  | { ok: true }
  | { ok: false; reason: 'stale-source' | 'stale-capability'; freshPlan: TransitionPlan } {
  const imagesSupported = defaultImagesSupported(plan.targetRoute)
  const verdict = confirmTransitionPlan(plan, {
    sourceRevision: transitionSourceRevision(messages),
    capabilityEpoch: transitionCapabilityEpoch(plan.to, imagesSupported, transitionWindowFact(messages, plan.to)),
  })
  if (verdict.ok) return verdict
  return {
    ...verdict,
    freshPlan: buildTransitionPlan({ messages, from: plan.from, to: plan.to }),
  }
}

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
  if (plan.window !== undefined && !plan.window.fits) {
    const fmt = (n: number): string => n.toLocaleString('en-US')
    parts.push(
      `about ${fmt(plan.window.count)} tokens by Mercury's count against the ${fmt(plan.window.window)}-token window — the conversation folds before the first request`,
    )
  }
  return ` · this switch: ${parts.join(' · ')} — text and tool results replay exactly (plan ${plan.planDigest.slice(0, 8)})`
}
