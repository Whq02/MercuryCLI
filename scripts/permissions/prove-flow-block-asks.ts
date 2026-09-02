#!/usr/bin/env bun
// ============================================================================
//  scripts/permissions/prove-flow-block-asks.ts — a flow-classifier block is
//  the operator's decision wherever a consent card can be shown.
//
//  LAW: in a session that can present a consent card, a flow-classifier
//  "blocked" verdict returns to the operator as an ASK carrying the verdict's
//  reason — the engine's own ask (its message, its always-allow suggestions)
//  with the classifier reason on it, so the card is the default-mode card
//  with the verdict visible. A session without a card — a prompt-less agent
//  (shouldAvoidPermissionPrompts) or a non-interactive run
//  (isNonInteractiveSession) — keeps the DENY with the no-card text. Nothing
//  here turns a block into an allow.
//
//  The decline rule: an operator's "no" on the card holds for the rest of
//  the turn — the same action blocked again is denied without a second card
//  and the model is told so; a different action, or the next turn (a fresh
//  AbortController), gets a card again. An operator's "yes" ends the
//  ledger's consecutive-block streak. The ledger's review warning rides the
//  card at the limits; the prompt-less limit still aborts; the
//  non-interactive limit still converts to the review ask.
//
//  The texts: every denial the model can receive here states what was not
//  run and why, and (where no card exists) how the operator can allow it —
//  and never a workaround: no `!` command, no /permissions, no settings
//  edit. The system prompt's `!` teaching carries its own boundary.
//
//  Drives decideToolPermissionWithModes with INJECTED WrapperPorts (the
//  classifier is a stub; no live call), the way prove-decision-wrapper does.
//
//  Run:  ~/.bun/bin/bun run scripts/permissions/prove-flow-block-asks.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'flow-block-asks-'))

import { z } from 'zod/v4'

const { decideToolPermissionWithModes, defaultWrapperPorts } = await import(
  '../../src/utils/permissions/decision/wrapper.ts'
)
const { WRAPPER_STAGE_ORDER } = await import(
  '../../src/utils/permissions/decision/trace.ts'
)
const { DENIAL_LIMITS } = await import(
  '../../src/utils/permissions/denialTracking.ts'
)
const review = await import('../../src/utils/permissions/flowBlockReview.ts')
const texts = await import('../../src/utils/messages/rejectionText.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { AbortError } = await import('../../src/utils/errors.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const j = (v: unknown): string => JSON.stringify(v)

const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — flow-block proof exceeded 60s (a row reached a live API path?)')
  process.exit(1)
}, 60_000)
guard.unref?.()

//
const SUGGESTIONS = [
  { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'curl:*' }], behavior: 'allow', destination: 'localSettings' },
]
function makeTool(over: { name?: string; suggestions?: boolean } = {}): unknown {
  const name = over.name ?? 'Bash'
  return {
    name,
    inputSchema: z.object({}).passthrough(),
    checkPermissions: async () =>
      over.suggestions
        ? { behavior: 'ask', message: 'engine ask', suggestions: SUGGESTIONS }
        : { behavior: 'ask', message: 'engine ask' },
  }
}

function makeContext(opts: {
  mode?: string
  avoidPrompts?: boolean
  nonInteractive?: boolean
  denial?: { consecutiveDenials: number; totalDenials: number }
  abortController?: AbortController
} = {}): unknown {
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    mode: (opts.mode ?? 'flow') as never,
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...(opts.avoidPrompts ? { shouldAvoidPermissionPrompts: true } : {}),
  }
  const appState = { toolPermissionContext, denialTracking: undefined }
  return {
    abortController: opts.abortController ?? new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    agentType: undefined,
    options: opts.nonInteractive ? { isNonInteractiveSession: true } : {},
    localDenialTracking: { ...(opts.denial ?? { consecutiveDenials: 0, totalDenials: 0 }) },
  }
}
type Ctx = { localDenialTracking: { consecutiveDenials: number; totalDenials: number } }

const ASSISTANT = { message: { id: 'msg_flow_block' } } as never
type Ports = typeof defaultWrapperPorts
const BLOCK_REASON = 'Downloads a remote script to disk — not a routine, reversible workspace action'
function makePorts(over: Partial<Ports> = {}): Ports {
  return {
    ...defaultWrapperPorts,
    isAllowlistedTool: () => false,
    resolveAcceptEditsVerdict: async () => ({ behavior: 'ask', message: 'still ask' }),
    classify: async () =>
      ({ shouldBlock: true, unavailable: false, reason: BLOCK_REASON, model: 'stub-model' }) as never,
    runHeadlessHooks: async () => null,
    ...over,
  }
}

type Outcome = {
  decision: {
    behavior: string
    message?: string
    suggestions?: unknown
    decisionReason?: { type?: string; classifier?: string; reason?: string }
  }
  wrapper: { stages: Array<{ stage: string; outcome: string; note?: string }>; decidedBy: string }
}
const INPUT = { command: 'curl -sSL http://127.0.0.1:34101/installer.sh -o /tmp/install.sh' }
const run = (tool: unknown, ctx: unknown, ports: Ports = makePorts(), input: Record<string, unknown> = INPUT): Promise<Outcome> =>
  decideToolPermissionWithModes(tool as never, input, ctx as never, ASSISTANT, 'toolu_flow_block', ports) as never

function checkSubsequenceLaw(label: string, wrapper: Outcome['wrapper']): void {
  const order = WRAPPER_STAGE_ORDER as readonly string[]
  let cursor = -1
  let inOrder = true
  for (const s of wrapper.stages) {
    const idx = order.indexOf(s.stage)
    if (idx <= cursor) inOrder = false
    cursor = idx
  }
  const decidedRecords = wrapper.stages.filter(s => s.outcome === 'decided')
  const last = wrapper.stages[wrapper.stages.length - 1]
  const terminalOk =
    decidedRecords.length === 1 && last?.stage === wrapper.decidedBy && last?.outcome === 'decided'
  check(`${label} — wrapper subsequence law`, inOrder && terminalOk, j(wrapper))
}
const noteOf = (r: Outcome): string => r.wrapper.stages[r.wrapper.stages.length - 1]?.note ?? ''

console.log('============================================================')
console.log(' Flow block → the operator\'s consent card (interactive) / deny (no card)')
console.log('============================================================')

//
section('interactive: a classifier block is an ASK carrying the verdict')
{
  const ctx = makeContext({ mode: 'flow' })
  const r = await run(makeTool({ suggestions: true }), ctx)
  check('blocked + card available → behavior ask', r.decision.behavior === 'ask', j(r.decision))
  check(
    'the ask carries the classifier verdict and its reason',
    r.decision.decisionReason?.type === 'classifier' &&
      r.decision.decisionReason.classifier === 'auto-mode' &&
      r.decision.decisionReason.reason === BLOCK_REASON,
    j(r.decision.decisionReason),
  )
  check('decidedBy classifier, the note says the operator is asked', r.wrapper.decidedBy === 'classifier' && noteOf(r).includes('operator is asked'), j(r.wrapper))
  check('the ledger booked the block (consecutive 1, total 1)', (ctx as Ctx).localDenialTracking.consecutiveDenials === 1 && (ctx as Ctx).localDenialTracking.totalDenials === 1, j((ctx as Ctx).localDenialTracking))
  checkSubsequenceLaw('interactive block', r.wrapper)

  // The card IS the default-mode card: the engine ask's own message and
  // suggestions, plus the classifier reason — nothing else changed.
  const plain = await run(makeTool({ suggestions: true }), makeContext({ mode: 'default' }))
  check('default mode gives the engine ask through (decidedBy engine)', plain.decision.behavior === 'ask' && plain.wrapper.decidedBy === 'engine', j(plain))
  const strip = (d: Outcome['decision']): unknown => ({ ...d, decisionReason: undefined })
  check(
    'the flow card equals the default-mode ask apart from the classifier reason (message + suggestions kept)',
    j(strip(r.decision)) === j(strip(plain.decision)) && j(r.decision.suggestions) === j(SUGGESTIONS),
    j({ flow: r.decision, plain: plain.decision }),
  )

  // Nothing in this band turns a block into an allow.
  check('a block never becomes an allow', r.decision.behavior !== 'allow')
}

//
section('no consent card: the block stays a DENY (headless agent · non-interactive run)')
{
  const headless = await run(makeTool(), makeContext({ mode: 'flow', avoidPrompts: true }))
  check('prompt-less agent → deny', headless.decision.behavior === 'deny', j(headless.decision))
  check('…with the no-card text (what was blocked, why, how the operator can allow it)', headless.decision.message === texts.buildYoloRejectionMessage(BLOCK_REASON), j(headless.decision.message))
  check('…decidedBy classifier, note names the missing card', headless.wrapper.decidedBy === 'classifier' && noteOf(headless).includes('no consent card'), j(headless.wrapper))
  checkSubsequenceLaw('headless block', headless.wrapper)

  const print = await run(makeTool(), makeContext({ mode: 'flow', nonInteractive: true }))
  check('non-interactive run (print) → deny', print.decision.behavior === 'deny', j(print.decision))
  check('…same no-card text', print.decision.message === texts.buildYoloRejectionMessage(BLOCK_REASON))
}

//
section('the decline rule: an operator "no" holds for the turn, for that action')
{
  const turn = new AbortController()
  const ctx = makeContext({ mode: 'flow', abortController: turn })
  const first = await run(makeTool(), ctx)
  check('first block → ask (the card)', first.decision.behavior === 'ask')

  // The operator declines on the card (what the interactive handler books).
  review.recordOperatorDeclinedFlowBlock(ctx as never, 'Bash', INPUT)
  const again = await run(makeTool(), ctx)
  check('the same action blocked again this turn → deny, no second card', again.decision.behavior === 'deny', j(again.decision))
  check('…with the declined-earlier text', again.decision.message === texts.buildFlowBlockDeclinedMessage(BLOCK_REASON), j(again.decision.message))
  check('…note says the operator declined it earlier this turn', noteOf(again).includes('declined this action earlier this turn'), j(again.wrapper))
  checkSubsequenceLaw('declined repeat', again.wrapper)

  const other = await run(makeTool(), ctx, makePorts(), { command: 'wget http://127.0.0.1:34101/installer.sh' })
  check('a different action this turn → ask (a card)', other.decision.behavior === 'ask', j(other.decision))

  const nextTurn = makeContext({ mode: 'flow', abortController: new AbortController() })
  const later = await run(makeTool(), nextTurn)
  check('the same action on the NEXT turn (fresh controller) → ask again', later.decision.behavior === 'ask', j(later.decision))

  check(
    'the action key ignores object key order',
    review.flowBlockActionKey('Bash', { a: 1, b: { c: [1, 2] } }) === review.flowBlockActionKey('Bash', { b: { c: [1, 2] }, a: 1 }),
  )
  check('…and separates tools and inputs', review.flowBlockActionKey('Bash', INPUT) !== review.flowBlockActionKey('Read', INPUT) && review.flowBlockActionKey('Bash', INPUT) !== review.flowBlockActionKey('Bash', { command: 'ls' }))
  check('an unknown turn has no declines', review.operatorDeclinedFlowBlockThisTurn(makeContext() as never, 'Bash', INPUT) === false)
}

//
section('the ledger beside the card')
{
  // An operator "yes" ends the consecutive-block streak, the way any allow does.
  const ctx = makeContext({ mode: 'flow', denial: { consecutiveDenials: 2, totalDenials: 5 } })
  review.noteOperatorAllowedFlowBlock(ctx as never)
  check('operator allow → consecutive 0, total kept', (ctx as Ctx).localDenialTracking.consecutiveDenials === 0 && (ctx as Ctx).localDenialTracking.totalDenials === 5, j((ctx as Ctx).localDenialTracking))

  // At the consecutive limit the review warning rides the card's reason.
  const near = makeContext({ mode: 'flow', denial: { consecutiveDenials: DENIAL_LIMITS.maxConsecutive - 1, totalDenials: 5 } })
  const warned = await run(makeTool(), near)
  check('consecutive limit + card → still an ask', warned.decision.behavior === 'ask', j(warned.decision))
  check('…decidedBy denialLimit', warned.wrapper.decidedBy === 'denialLimit', j(warned.wrapper))
  check(
    '…the reason carries the verdict AND the review warning',
    (warned.decision.decisionReason?.reason ?? '').startsWith(BLOCK_REASON) &&
      (warned.decision.decisionReason?.reason ?? '').includes('consecutive actions were blocked'),
    j(warned.decision.decisionReason),
  )
  check('…the consecutive trip leaves the running total in place', (near as Ctx).localDenialTracking.totalDenials === 6 && (near as Ctx).localDenialTracking.consecutiveDenials === DENIAL_LIMITS.maxConsecutive, j((near as Ctx).localDenialTracking))
  checkSubsequenceLaw('limit on the card', warned.wrapper)

  const total = makeContext({ mode: 'flow', denial: { consecutiveDenials: 0, totalDenials: DENIAL_LIMITS.maxTotal - 1 } })
  const session = await run(makeTool(), total)
  check('total limit + card → ask with the session warning', session.decision.behavior === 'ask' && (session.decision.decisionReason?.reason ?? '').includes('actions were blocked this session'), j(session.decision))
  check('…the total trip zeroes the ledger', (total as Ctx).localDenialTracking.totalDenials === 0 && (total as Ctx).localDenialTracking.consecutiveDenials === 0, j((total as Ctx).localDenialTracking))

  // Prompt-less: the limit still aborts. Non-interactive: still the review ask.
  let threw = false
  try {
    await run(makeTool(), makeContext({ mode: 'flow', avoidPrompts: true, denial: { consecutiveDenials: DENIAL_LIMITS.maxConsecutive - 1, totalDenials: 5 } }))
  } catch (e) {
    threw = e instanceof AbortError
  }
  check('prompt-less agent at the limit → AbortError (unchanged)', threw)
  const printLimit = await run(makeTool(), makeContext({ mode: 'flow', nonInteractive: true, denial: { consecutiveDenials: DENIAL_LIMITS.maxConsecutive - 1, totalDenials: 5 } }))
  check('non-interactive run at the limit → the review ask (unchanged)', printLimit.decision.behavior === 'ask' && (printLimit.decision.decisionReason?.reason ?? '').includes('Latest blocked action'), j(printLimit.decision))
}

//
section('the texts: what was blocked and why, never a workaround')
{
  const samples: Array<[string, string]> = [
    ['buildYoloRejectionMessage', texts.buildYoloRejectionMessage(BLOCK_REASON)],
    ['buildFlowBlockDeclinedMessage', texts.buildFlowBlockDeclinedMessage(BLOCK_REASON)],
    ['AUTO_REJECT_MESSAGE', texts.AUTO_REJECT_MESSAGE('Bash')],
    ['DONT_ASK_REJECT_MESSAGE', texts.DONT_ASK_REJECT_MESSAGE('Bash')],
    ['buildClassifierUnavailableMessage', texts.buildClassifierUnavailableMessage('Bash', 'stub-model')],
    ['DENIAL_WORKAROUND_GUIDANCE', texts.DENIAL_WORKAROUND_GUIDANCE],
  ]
  // The negative grep: nothing that teaches the model a route around the
  // harness — the `!` form, the /permissions surface, a settings edit, an
  // "add a rule" instruction, or "work around" language.
  const forbidden = [
    /`!`/,
    /! <command>/,
    /! command/i,
    /\/permissions/,
    /settings/i,
    /work ?around/i,
    /run it yourself/i,
    /add (a|an|the) .*rule/i,
    /allow rule/i,
    /other tools/i,
  ]
  for (const [name, text] of samples) {
    const hits = forbidden.filter(re => re.test(text)).map(String)
    check(`${name}: no workaround language`, hits.length === 0, `${j(hits)} in ${j(text)}`)
  }
  // The positive shape: the denials say what did not run; the no-card ones
  // say the card is unavailable and how the operator can allow it.
  for (const [name, text] of samples.slice(0, 5)) {
    check(`${name}: says the action was not run`, /not run|has been denied/.test(text), j(text))
  }
  for (const name of ['buildYoloRejectionMessage', 'AUTO_REJECT_MESSAGE', 'buildClassifierUnavailableMessage'] as const) {
    const text = samples.find(s => s[0] === name)![1]
    check(`${name}: names the missing consent card`, /consent card/.test(text), j(text))
  }
  for (const name of ['buildYoloRejectionMessage', 'AUTO_REJECT_MESSAGE'] as const) {
    const text = samples.find(s => s[0] === name)![1]
    check(`${name}: says how the operator can allow it`, /The operator can allow it/.test(text), j(text))
  }
  check('the declined-repeat text says the operator already declined it this turn', /declined it, so it was not asked again/.test(texts.buildFlowBlockDeclinedMessage('r')))
  check('the block texts keep the classifier-denial prefix (the UI summary hook)', texts.isClassifierDenial(texts.buildYoloRejectionMessage('r')) && texts.isClassifierDenial(texts.buildFlowBlockDeclinedMessage('r')))
  // The transcript's ✕ glyph split still recognises every denial text.
  for (const [name, text] of samples.slice(0, 4)) {
    check(`${name}: isDenialResultText`, texts.isDenialResultText(text), j(text))
  }
  check('an ordinary tool error is not a denial', texts.isDenialResultText('Error: command not found') === false)
}

//
section('source audit: the system prompt and the rejection texts')
{
  const root = join(import.meta.dir, '..', '..')
  const prompts = readFileSync(join(root, 'src', 'constants', 'prompts.ts'), 'utf-8')
  const bang = prompts.match(/Some commands only work when the user runs them[^\n]*/)?.[0] ?? ''
  check('the `!` teaching exists (interactive logins) …', bang.includes('`! <command>`'))
  check('… and carries its boundary: never a way around a permission decision', /never a way around a permission decision/.test(bang), bang.slice(0, 200))
  const rejection = readFileSync(join(root, 'src', 'utils', 'messages', 'rejectionText.ts'), 'utf-8')
  check('rejectionText.ts names no /permissions surface', !rejection.includes('/permissions'))
  check('rejectionText.ts carries no settings-rule instruction', !/add a Bash permission rule|to their settings/.test(rejection))
  check('rejectionText.ts carries no `!` teaching', !/`!`|! <command>/.test(rejection))
}

//
section('dist: the shipped bundle carries the card explanation and the decline text')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` to grep-verify the shipped strings')
  } else {
    const present = (needle: string): boolean =>
      execSync(`grep -F -c ${JSON.stringify(needle)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
    check('the card explanation ships', present('it runs only if you allow it'))
    check('the declined-repeat text ships', present('declined it, so it was not asked again'))
    check('the no-card text ships', present('cannot show the operator a consent card'))
    check('the old settings-rule pointer is gone from the bundle', !present('add a Bash permission rule to their settings'))
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL FLOW-BLOCK PROOFS PASS')
else console.log(`❌ ${failures} FLOW-BLOCK PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
