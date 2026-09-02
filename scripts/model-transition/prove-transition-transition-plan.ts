#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-transition-plan.ts — (A01/A02
//  substrate): the frozen TransitionPlan previews a requested switch with
//  typed per-item dispositions computed against the REAL encode truth, and
//  confirmation is stale-safe.
//
//    §A PARITY (openai target) — the planner's counts equal what the real
//       walk (toBridgeMessages → mapMessagesToOpenaiInput) actually does to
//       the same history: thinking never reaches the wire; the sameModel
//       guard's carried record; '[image]'/'[<type>]' placeholders. The
//       parity-oracle pattern — codec drift breaks THIS prover.
//    §B the sameModel law — a same-provider GPT model change resets every
//       previously-carried record (planner AND walk agree)
//    §C anthropic target — native carry (thinking/image/unknown lossless);
//       OpenAI continuation records stop being read; a lossless
//       claude→claude history needs no choice
//    §D zai target — the zaiCodec law (thinking dropped · images/unknown
//       degrade · records never carried)
//    §E one frozen plan — deep-frozen, digest deterministic (wall-clock
//       excluded), lossy items bounded explicitly
//    §F stale-safe confirm — matching revision+epoch confirms; a history
//       append is stale-source; a capability flip is stale-capability
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-plan-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'

const { buildTransitionPlan, transitionSourceRevision, transitionCapabilityEpoch } =
  await import('../../src/services/providers/transitionPreview.ts')
const { confirmTransitionPlan } = await import('../../src/utils/model/modelTransition.ts')
const { toBridgeMessages } = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { mapMessagesToOpenaiInput } = await import('../../src/services/providers/openai/responsesBridge.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── the crafted history (the encode-loss inventory's synthetic shapes) ──────
const ts = new Date().toISOString()
const uid = (n: number): string => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`
const user = (n: number, content: unknown): Record<string, unknown> => ({
  type: 'user',
  uuid: uid(n),
  timestamp: ts,
  message: { role: 'user', content },
})
const asst = (n: number, content: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'assistant',
  uuid: uid(n),
  timestamp: ts,
  message: {
    id: `msg_${n}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content,
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  },
  ...over,
})
const gptRecord = (tag: string): Record<string, unknown> => ({
  provider: 'openai',
  responseId: `resp_${tag}`,
  items: [
    { type: 'reasoning', id: `rs_${tag}`, encrypted_content: `opaque-${tag}`, summary: [] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: tag }] },
  ],
})
const gptTurn = (n: number, served: string, tag: string): Record<string, unknown> =>
  asst(n, [{ type: 'text', text: tag }], {
    apexProviderTurn: gptRecord(tag),
  }) as Record<string, unknown>
;(gptTurn as unknown as { _: unknown })._ = null

const HISTORY = [
  user(1, 'plain text turn'),
  asst(2, [
    { type: 'thinking', thinking: 'private reasoning' },
    { type: 'text', text: 'answer' },
  ]),
  (() => {
    const t = gptTurn(3, 'gpt-5.2', 'served-matching')
    ;(t.message as { model: string }).model = 'gpt-5.2'
    return t
  })(),
  (() => {
    const t = gptTurn(4, 'gpt-5.1', 'served-older')
    ;(t.message as { model: string }).model = 'gpt-5.1'
    return t
  })(),
  user(5, [
    { type: 'text', text: 'see attached' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
  ]),
  user(6, [{ type: 'mystery_block', payload: 'x' }]),
  asst(7, [{ type: 'tool_use', id: 'tu_1', name: 'Echo', input: { text: 'hi' } }]),
  user(8, [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'echoed' }]),
] as never[]

/** The REAL walk's observations for a target. */
function walkObservations(target: string, imagesSupported: boolean) {
  const bridge = toBridgeMessages(HISTORY as never, undefined as never, target)
  const carriedRecords = bridge.rows.filter(r => (r as { turnRecord?: unknown }).turnRecord).length
  const items = mapMessagesToOpenaiInput(bridge.rows as never, { imagesSupported } as never)
  const flat = JSON.stringify(items)
  return {
    carriedRecords,
    wireReasoningFromThinking: (flat.match(/private reasoning/g) ?? []).length,
    imagePlaceholders: (flat.match(/\[image\]/g) ?? []).length,
    unknownPlaceholders: (flat.match(/\[mystery_block\]/g) ?? []).length,
  }
}

section('§A parity with the real encode walk (openai target, images permissive)')
{
  const plan = buildTransitionPlan({ messages: HISTORY as never, from: null, to: 'gpt-5.2' })
  const walk = walkObservations('gpt-5.2', true)
  check('thinking never reaches the wire; the planner counts the reset', walk.wireReasoningFromThinking === 0 && plan.counts['thinking-continuity-reset'] === 1, `wire=${walk.wireReasoningFromThinking} plan=${plan.counts['thinking-continuity-reset']}`)
  check('the sameModel guard carries exactly one record; the planner resets the other', walk.carriedRecords === 1 && plan.counts['stateless-replay-reset'] === 1, `carried=${walk.carriedRecords} reset=${plan.counts['stateless-replay-reset']}`)
  check('permissive modality: no image placeholder, no planner degradation', walk.imagePlaceholders === 0 && plan.counts['image-degraded'] === 0)
  check('the unknown block degrades on the wire AND in the plan', walk.unknownPlaceholders === 1 && plan.counts['unknown-block-degraded'] === 1)
  check('tool pairs stay exact', plan.counts['tool-results-exact'] === 2)
  check('meaningful loss gates the choice', plan.needsChoice === true)
  check('the lossy items name their refs', plan.items.some(i => i.ref === uid(2)) && plan.items.some(i => i.ref === uid(4)))

  const planNoImages = buildTransitionPlan({ messages: HISTORY as never, from: null, to: 'gpt-5.2', imagesSupported: false })
  const walkNoImages = walkObservations('gpt-5.2', false)
  check('modality-denied: the wire degrades the image AND the planner counts it', walkNoImages.imagePlaceholders === 1 && planNoImages.counts['image-degraded'] === 1)
}

section('§B the sameModel law — a same-provider model change resets continuity')
{
  const plan = buildTransitionPlan({ messages: HISTORY as never, from: 'gpt-5.2', to: 'gpt-5.3' })
  const walk = walkObservations('gpt-5.3', true)
  check('NO record survives a gpt-5.x → gpt-5.3 switch (walk truth)', walk.carriedRecords === 0)
  check('the planner resets BOTH recorded turns', plan.counts['stateless-replay-reset'] === 2, String(plan.counts['stateless-replay-reset']))
  check('same-family switch is not cross-provider', plan.crossProvider === false)
}

section('§C anthropic target — native carry; records stop being read')
{
  const plan = buildTransitionPlan({ messages: HISTORY as never, from: 'gpt-5.2', to: null })
  check('images/unknown carry natively; UNSIGNED foreign thinking resets (the wire drops it)', plan.counts['thinking-continuity-reset'] === 1 && plan.counts['image-degraded'] === 0 && plan.counts['unknown-block-degraded'] === 0, JSON.stringify(plan.counts))
  check('both OpenAI continuation records reset (not consumed by this lane)', plan.counts['stateless-replay-reset'] === 2)
  check('gpt → claude is cross-provider; the loss still gates a choice', plan.crossProvider === true && plan.needsChoice === true)

  // NATIVE (signed) thinking replays untouched on the anthropic wire — the
  // planner counts zero loss and the switch needs no choice.
  const clean = [user(1, 'q'), asst(2, [{ type: 'thinking', thinking: 'x', signature: 'sig-native' }, { type: 'text', text: 'a' }])] as never[]
  const lossless = buildTransitionPlan({ messages: clean as never, from: null, to: 'claude-sonnet-5' })
  check('a lossless claude→claude history (signed thinking) needs NO choice', lossless.needsChoice === false && lossless.counts['carried-exact'] === 2, JSON.stringify(lossless.counts))

  // The same history with the signature MISSING (a foreign runtime's block)
  // is wire-dropped even on an anthropic→anthropic move — planner ≡ codec.
  const foreign = [user(1, 'q'), asst(2, [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'a' }])] as never[]
  const stripped = buildTransitionPlan({ messages: foreign as never, from: null, to: 'claude-sonnet-5' })
  check('unsigned thinking into anthropic counts the reset and gates the choice', stripped.counts['thinking-continuity-reset'] === 1 && stripped.needsChoice === true, JSON.stringify(stripped.counts))
}

section('§D zai target — the zaiCodec law')
{
  const plan = buildTransitionPlan({ messages: HISTORY as never, from: null, to: 'glm-4.7' })
  check('thinking resets · image degrades · unknown degrades · records reset', plan.counts['thinking-continuity-reset'] === 1 && plan.counts['image-degraded'] === 1 && plan.counts['unknown-block-degraded'] === 1 && plan.counts['stateless-replay-reset'] === 2)
  check('the zai route is typed on the plan', plan.targetRoute === 'zai')
}

section('§E one frozen plan — digest-addressed, wall-clock-free, bounded')
{
  const a = buildTransitionPlan({ messages: HISTORY as never, from: null, to: 'gpt-5.2' })
  const b = buildTransitionPlan({ messages: HISTORY as never, from: null, to: 'gpt-5.2' })
  check('identical inputs → identical planDigest (computedAt excluded)', a.planDigest === b.planDigest)
  check('digest form: sha256 hex', /^[0-9a-f]{64}$/.test(a.planDigest))
  check('the plan is deep-frozen (plan · items · counts)', Object.isFrozen(a) && Object.isFrozen(a.items) && Object.isFrozen(a.counts) && (a.items.length === 0 || Object.isFrozen(a.items[0])))
  check('the item cap is EXPLICIT, not silent', a.itemsTruncated === false)
  const differentTarget = buildTransitionPlan({ messages: HISTORY as never, from: null, to: 'gpt-5.3' })
  check('a different target is a different plan identity', differentTarget.planDigest !== a.planDigest)
}

section('§F stale-safe confirm')
{
  const plan = buildTransitionPlan({ messages: HISTORY as never, from: null, to: 'gpt-5.2' })
  const fresh = {
    sourceRevision: transitionSourceRevision(HISTORY as never),
    capabilityEpoch: transitionCapabilityEpoch('gpt-5.2', true),
  }
  check('matching revision + epoch confirms', confirmTransitionPlan(plan, fresh).ok === true)
  const appended = [...HISTORY, user(9, 'a new turn landed after the preview')] as never[]
  const staleSource = confirmTransitionPlan(plan, {
    sourceRevision: transitionSourceRevision(appended as never),
    capabilityEpoch: fresh.capabilityEpoch,
  })
  check('a history append is stale-source', staleSource.ok === false && !staleSource.ok && staleSource.reason === 'stale-source')
  const staleCap = confirmTransitionPlan(plan, {
    sourceRevision: fresh.sourceRevision,
    capabilityEpoch: transitionCapabilityEpoch('gpt-5.2', false),
  })
  check('a capability flip is stale-capability', staleCap.ok === false && !staleCap.ok && staleCap.reason === 'stale-capability')
}

section('§G the loss summary — plain words, nonzero classes only, plan-addressed')
{
  const { transitionPlanSummary } = await import('../../src/services/providers/transitionPreview.ts')
  const lossy = buildTransitionPlan({ messages: HISTORY as never, from: null, to: 'glm-4.7' })
  const s = transitionPlanSummary(lossy)
  check(
    'every nonzero class appears in plain words',
    s.includes('1 thinking span(s) reset') &&
      s.includes('2 continuation record(s) reset') &&
      s.includes('1 image(s) degrade') &&
      s.includes('1 unsupported block(s) degrade'),
    s,
  )
  check('the summary is plan-addressed (digest prefix)', s.includes(lossy.planDigest.slice(0, 8)))
  check('the exact-replay reassurance is stated', s.includes('text and tool results replay exactly'))
  const lossless = buildTransitionPlan({
    messages: [user(1, 'q')] as never,
    from: null,
    to: 'claude-sonnet-5',
  })
  check('a no-choice plan yields an EMPTY summary (no noise)', transitionPlanSummary(lossless) === '')
}

section('§H the pick sites consume the plan (wiring anchors)')
{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const ROOT = join(import.meta.dir, '..', '..')
  for (const rel of [
    'src/commands/model/mercuryModel.tsx',
    'src/components/PromptInput/PromptInput.tsx',
    'src/commands/model/model.tsx',
  ]) {
    const src = readFileSync(join(ROOT, rel), 'utf8')
    check(
      `${rel} builds the preview and rides its summary`,
      src.includes('previewForSelection(') && src.includes('transitionPlanSummary('),
    )
    check(
      `${rel} gates needs_choice at the card + stale-safe reconfirm`,
      src.includes('TransitionPreviewCard') && src.includes('reconfirmTransitionPlan('),
    )
  }
  // The text path settles through the ONE owner — the direct
  // mainLoopModel write class is dead in SetModelAndClose.
  const textPath = readFileSync(join(ROOT, 'src/commands/model/model.tsx'), 'utf8')
  check(
    'the /model <id> text path routes through settleModelSelection',
    textPath.includes('settleModelSelection('),
  )
}

console.log(failures === 0 ? '\n ✅ TRANSITION PLAN — parity-anchored, frozen, stale-safe' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
