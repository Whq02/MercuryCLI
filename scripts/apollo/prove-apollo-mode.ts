#!/usr/bin/env bun
// ============================================================================
//  scripts/apollo/prove-apollo-mode.ts
//  PROOF: the Apollo interview station (operator decision; FULL
//  REBUILD — nothing of the removed MERCURY_FABLE estate returns). Pins:
//    1. the carousel order — apollo directly after strategy, always
//       available; apollo exits to flow/sovereign/default;
//    2. the mode vocabulary — 'apollo' in the runtime lists, external
//       projection 'default', never a bypass posture; seal ∵ and title from
//       the ONE config;
//    3. the pack — mode-apollo composes ONLY for permissionMode==='apollo'
//       (the main-agent-only and next-turn laws ride the REPL threading,
//       pinned structurally on the REPL build sites);
//    4. the poll letters — A–D + E = custom, one owner (apolloLetters.ts),
//       display-only in the two question views;
//    5. the setting — apollo.preflightQuestions default 7, interpolated
//       into the pack;
//    6. the closing review tool — apollo-only at validation, ask on a clean
//       review / allow on a blockered one, the guarded handoff to
//       flow-else-implement on the clean path;
//    7. the wiring — registration, consent routing, contract ownership,
//       and the headless reject arm.
//
//  Run:  ~/.bun/bin/bun run scripts/apollo/prove-apollo-mode.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const src = (...p: string[]) =>
  readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Apollo Mode — the interview station joins the cycle (proof)')
console.log('============================================================')

// Fork-sim so stamp-gated config resolves when imported (the established
// prover pattern — scripts/autopilot/prove-carousel-autopilot.ts).
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

// ── 1 · the carousel ────────────────────────────────────────────────────────
section('the carousel: default → implement → strategy → APOLLO → flow|sovereign|default')
let carouselLoadable = true
try {
  const { getNextPermissionMode } = (await import(
    '../../src/utils/permissions/getNextPermissionMode.js'
  )) as typeof import('../../src/utils/permissions/getNextPermissionMode.js')
  const ctx = (mode: string, bypass = false) =>
    ({ mode, isBypassPermissionsModeAvailable: bypass }) as never
  check("default → implement", getNextPermissionMode(ctx('default')) === 'implement')
  check("implement → strategy", getNextPermissionMode(ctx('implement')) === 'strategy')
  check("strategy → apollo (the two think-first stations sit together)", getNextPermissionMode(ctx('strategy')) === 'apollo')
  check(
    'apollo → flow|sovereign|default (strategy’s old exits moved here)',
    ['flow', 'sovereign', 'default'].includes(getNextPermissionMode(ctx('apollo'))),
  )
  check('apollo never cycles back into strategy', getNextPermissionMode(ctx('apollo')) !== 'strategy')
  check(
    'apollo with bypass available exits toward sovereign or flow, never default',
    ['flow', 'sovereign'].includes(getNextPermissionMode(ctx('apollo', true))),
  )
} catch (e) {
  carouselLoadable = false
  console.log(`  [info] carousel not loadable under bun-run (${String(e).split('\n')[0]}) — structural assertions`)
  const gn = src('utils', 'permissions', 'getNextPermissionMode.ts')
  check("case 'strategy' returns 'apollo'", /case 'strategy':[\s\S]{0,220}return 'apollo'/.test(gn))
  check("case 'apollo' carries the flow/sovereign/default exits", /case 'apollo':[\s\S]{0,400}return 'flow'[\s\S]{0,200}'sovereign'/.test(gn))
}

// ── 2 · the vocabulary ──────────────────────────────────────────────────────
section("the vocabulary: 'apollo' joins the mode lists; seal + title from the ONE config")
try {
  const types = (await import('../../src/types/permissions.js')) as typeof import('../../src/types/permissions.js')
  check("PERMISSION_MODES includes 'apollo' (user-addressable)", (types.PERMISSION_MODES as readonly string[]).includes('apollo'))
  check("INTERNAL_PERMISSION_MODES includes 'apollo'", (types.INTERNAL_PERMISSION_MODES as readonly string[]).includes('apollo'))
  check("'apollo' is NOT an external mode (projection only)", !(types.EXTERNAL_PERMISSION_MODES as readonly string[]).includes('apollo'))
  const pm = (await import('../../src/utils/permissions/PermissionMode.js')) as typeof import('../../src/utils/permissions/PermissionMode.js')
  const glyphs = (await import('../../src/components/mercury-ui/glyphs.js')) as typeof import('../../src/components/mercury-ui/glyphs.js')
  check("permissionModeFromString('apollo') === 'apollo'", pm.permissionModeFromString('apollo') === 'apollo')
  check("title is 'Apollo Mode'", pm.permissionModeTitle('apollo') === 'Apollo Mode')
  check('the seal is ∵ (U+2235), read from GLYPH.modeApollo', pm.permissionModeSymbol('apollo') === glyphs.GLYPH.modeApollo && glyphs.GLYPH.modeApollo === '∵')
  check("external projection is 'default'", pm.toExternalPermissionMode('apollo') === 'default')
  check('apollo never bypasses permissions', !pm.modeBypassesPermissions('apollo'))
  check("band colour role is 'permission'", pm.getModeColor('apollo') === 'permission')
} catch (e) {
  check('vocabulary modules loadable', false, String(e).split('\n')[0])
}

// ── 3 · the pack ────────────────────────────────────────────────────────────
section("the pack: mode-apollo composes ONLY while the mode is 'apollo'")
try {
  const pack = (await import('../../src/prompt/apolloMode.js')) as typeof import('../../src/prompt/apolloMode.js')
  const on = pack.getApolloModeSections('apollo')
  check('apollo ⇒ exactly one section', on.length === 1)
  const text = on[0] ?? ''
  check('the section is the Apollo interview appendix', text.startsWith('# Apollo Mode'))
  // The budget in the pack equals the live setting (7 unless this checkout's
  // settings override apollo.preflightQuestions — the equality is the pin).
  const { getApolloPreflightQuestions } = (await import('../../src/utils/settings/settings.js')) as typeof import('../../src/utils/settings/settings.js')
  check(`the poll budget rides the setting (${getApolloPreflightQuestions()})`, text.includes(`Budget: ${getApolloPreflightQuestions()} polls`))
  check('the pack names the four-option + automatic-E shape', /FOUR options \(A–D\)/.test(text) && /E is where the user types/.test(text))
  check('the pack names the spec home under .mercury/apollo', /\.mercury[\/\\]apollo/.test(text))
  check('the pack names the closing review tool', /ApolloReview/.test(text))
  check('the layman-language rule is stated', /plain meaning/i.test(text))
  check('the prototype bar is stated (playable demo / runnable slice)', /playable demo/.test(text) && /runnable slice/.test(text))
  check(
    'the pack teaches the three review answers and the only-door law',
    /yes-but-ask-first/.test(text) && /Ask me more questions/.test(text) && /only door to the build/.test(text),
  )
  for (const off of [undefined, 'default', 'strategy', 'implement', 'flow', 'sovereign', 'autopilot'] as const) {
    check(`${String(off)} ⇒ [] (byte-identical prompt off-mode)`, pack.getApolloModeSections(off as never).length === 0)
  }
} catch (e) {
  check('apolloMode.ts loadable', false, String(e).split('\n')[0])
}
{
  const prompts = src('constants', 'prompts.ts')
  // The prefix law: the top-level system prompt is part of the prefix every
  // thinking block is bound to, so the pack never composes into it — it
  // rides the conversation as a persisted mode_pack row (the attachment
  // lifecycle owner emits it on entry, an exit row on leaving).
  check('prompts.ts never pushes the apollo pack into the system prompt (the pack rides a mode_pack row)', !/pushPack\('mode-apollo'/.test(prompts) && !/getApolloModeSections\(/.test(prompts))
  const lifecycles = src('utils', 'attachments', 'modeLifecycles.ts')
  check('the attachment lifecycle owner emits the apollo pack as a mode_pack row from getApolloModeSections', /getApolloModeSections\('apollo'\)/.test(lifecycles) && /type: 'mode_pack'/.test(lifecycles))
  // Law 9 hoisted the build sites behind fetchSystemPromptParts — the live
  // mode threads at the standing callers (the next-turn law), and the one
  // owner forwards it to getSystemPrompt.
  check(
    'the prompt-build callers thread the LIVE toolPermissionContext.mode (the next-turn law)',
    /permissionMode: appStateSnapshot\.toolPermissionContext\.mode/.test(src('QueryEngine.ts')) &&
      /permissionMode: appState\.toolPermissionContext\.mode/.test(src('utils', 'queryContext.ts')) &&
      src('utils', 'queryContext.ts').includes('getSystemPrompt(tools, mainLoopModel, additionalWorkingDirectories, mcpClients, permissionMode)'),
  )
  const contract = src('prompt', 'behaviourContract.ts')
  check('behaviour contract owns mode:mode-apollo → src/prompt/apolloMode.ts', /\['mode:mode-apollo', 'src\/prompt\/apolloMode\.ts'\]/.test(contract))
}

// ── 4 · the letters ─────────────────────────────────────────────────────────
section('the poll letters: A–D + E = custom, one owner, ordinal-channel display')
try {
  const letters = (await import('../../src/tools/AskUserQuestionTool/apolloLetters.js')) as typeof import('../../src/tools/AskUserQuestionTool/apolloLetters.js')
  check('apolloIndexLabel letters A–D by index', letters.apolloIndexLabel(0) === 'A.' && letters.apolloIndexLabel(1) === 'B.' && letters.apolloIndexLabel(2) === 'C.' && letters.apolloIndexLabel(3) === 'D.')
  check('index past the cap yields undefined (numeric prefix shows)', letters.apolloIndexLabel(4) === undefined)
  check("the custom option's ordinal is 'E.' (E is a stable identity)", letters.apolloCustomIndexLabel() === 'E.')
} catch (e) {
  check('apolloLetters.ts loadable', false, String(e).split('\n')[0])
}
{
  const qv = src('components', 'permissions', 'AskUserQuestionPermissionRequest', 'QuestionView.tsx')
  check('QuestionView letters options only in apollo (ordinal channel; labels/values raw)', /isApolloPoll \? \{ indexLabel: apolloIndexLabel\(index\) \} : \{\}/.test(qv) && /value: opt\.label/.test(qv))
  check('QuestionView letters the Other row as E in apollo', /isApolloPoll \? \{ indexLabel: apolloCustomIndexLabel\(\) \} : \{\}/.test(qv))
  const pv = src('components', 'permissions', 'AskUserQuestionPermissionRequest', 'PreviewQuestionView.tsx')
  check('PreviewQuestionView letters its ordinals in apollo', /isApolloPoll \? APOLLO_OPTION_LETTERS\[index\]/.test(pv))
  const sel = src('components', 'CustomSelect', 'select.tsx')
  check('the select owner honours an option-declared display ordinal (rowPrefix)', /option\.indexLabel !== undefined/.test(sel) && (sel.match(/rowPrefix\(option, option\.index \+ 1/g) ?? []).length >= 2)
  // The declared-ordinal grammar guarantees one trailing space at every site
  // (padEnd to at least length + 1) — pin the shape at all three owners.
  check('the grammar guarantees the trailing space (rowPrefix padEnd ≥ len+1)', /indexLabel\.padEnd\(Math\.max\(reservedWidth, option\.indexLabel\.length \+ 1\)\)/.test(sel))
  check('input rows honour the ordinal too', /option\.indexLabel !== undefined[\s\S]{0,200}option\.indexLabel\.length \+ 1/.test(src('components', 'CustomSelect', 'select-input-option.tsx')))
  check('multi-select rows honour the ordinal too', /option\.indexLabel !== undefined[\s\S]{0,260}option\.indexLabel\.length \+ 1/.test(src('components', 'CustomSelect', 'SelectMulti.tsx')))
}

// ── 5 · the setting ─────────────────────────────────────────────────────────
section('the setting: apollo.preflightQuestions, default 7')
try {
  const settings = (await import('../../src/utils/settings/settings.js')) as typeof import('../../src/utils/settings/settings.js')
  check('getApolloPreflightQuestions() defaults to 7', settings.getApolloPreflightQuestions() === 7)
} catch (e) {
  check('settings module loadable', false, String(e).split('\n')[0])
}
{
  const types = src('utils', 'settings', 'types.ts')
  check('the settings schema registers apollo.preflightQuestions', /apollo:[\s\S]{0,160}preflightQuestions/.test(types))
}

// ── 6 · the closing review tool ─────────────────────────────────────────────
section('ApolloReview: apollo-only, ask-on-clean, guarded handoff to flow|implement')
try {
  const { ApolloReviewTool } = (await import('../../src/tools/ApolloReviewTool/ApolloReviewTool.js')) as typeof import('../../src/tools/ApolloReviewTool/ApolloReviewTool.js')
  const mkContext = (mode: string) => {
    let state = {
      toolPermissionContext: {
        mode,
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
      },
    }
    return {
      agentId: undefined,
      getAppState: () => state as never,
      setAppState: (updater: (prev: typeof state) => typeof state) => {
        state = updater(state)
      },
      options: { tools: [] },
      read: () => state,
    }
  }

  const wrongMode = await ApolloReviewTool.validateInput!({ summary: 's', blockers: [], specFiles: [] } as never, mkContext('default') as never)
  check('validateInput refuses outside Apollo Mode', wrongMode.result === false)
  const rightMode = await ApolloReviewTool.validateInput!({ summary: 's', blockers: [], specFiles: [] } as never, mkContext('apollo') as never)
  check('validateInput accepts in Apollo Mode (main session)', rightMode.result === true)

  const askClean = await ApolloReviewTool.checkPermissions!({ summary: 's', blockers: [], specFiles: [] } as never, mkContext('apollo') as never)
  check("a CLEAN review asks ('Begin the prototype build?')", (askClean as { behavior: string }).behavior === 'ask')
  const allowBlocked = await ApolloReviewTool.checkPermissions!({ summary: 's', blockers: ['unsettled'], specFiles: [] } as never, mkContext('apollo') as never)
  check('a BLOCKERED review is informational (allow, no consent dialog)', (allowBlocked as { behavior: string }).behavior === 'allow')

  // The blockered call changes nothing.
  const blockedCtx = mkContext('apollo')
  const blockedResult = (await ApolloReviewTool.call({ summary: 's', blockers: ['unsettled'], specFiles: [] } as never, blockedCtx as never)) as { data: { buildStarted: boolean } }
  check('blockers ⇒ buildStarted=false', blockedResult.data.buildStarted === false)
  check('blockers ⇒ the mode did not move', (blockedCtx.getAppState() as never as { toolPermissionContext: { mode: string } }).toolPermissionContext.mode === 'apollo')

  // The clean call hands off through the guarded setter: flow when the live
  // gate allows, implement otherwise — assert the settled pair.
  const cleanCtx = mkContext('apollo')
  const cleanResult = (await ApolloReviewTool.call({ summary: 's', blockers: [], specFiles: [] } as never, cleanCtx as never)) as { data: { buildStarted: boolean; buildMode?: string } }
  const settledMode = (cleanCtx.getAppState() as never as { toolPermissionContext: { mode: string } }).toolPermissionContext.mode
  check('clean ⇒ buildStarted=true', cleanResult.data.buildStarted === true)
  check("clean ⇒ the session moved to flow|implement (the ruled posture)", settledMode === 'flow' || settledMode === 'implement', `settled=${settledMode}`)
  check('the output records the settled mode', cleanResult.data.buildMode === settledMode)

  const wire = ApolloReviewTool.mapToolResultToToolResultBlockParam!(cleanResult.data as never, 'toolu_x') as { content: string }
  check("the wire tells the model the build begins NOW", /build begins NOW/.test(wire.content))
  const blockedWire = ApolloReviewTool.mapToolResultToToolResultBlockParam!(blockedResult.data as never, 'toolu_y') as { content: string }
  check('the blockered wire says nothing changed hands', /Nothing changed hands/.test(blockedWire.content))

  // The three-answer consent (the closing-consent trap): every yes moves
  // the mode — the tiers differ in permission breadth only — and the third
  // answer holds everything with the interview resuming.
  const askFirstCtx = mkContext('apollo')
  const askFirstResult = (await ApolloReviewTool.call(
    { summary: 's', blockers: [], specFiles: [], decision: 'build-ask-first' } as never,
    askFirstCtx as never,
  )) as { data: { buildStarted: boolean; buildMode?: string } }
  const askFirstMode = (askFirstCtx.getAppState() as never as { toolPermissionContext: { mode: string } }).toolPermissionContext.mode
  check(
    'yes-but-ask-first ⇒ the mode MOVES to default (per-edit consent; a yes can never strand the session)',
    askFirstResult.data.buildStarted === true && askFirstMode === 'default' && askFirstResult.data.buildMode === 'default',
    `settled=${askFirstMode}`,
  )
  const askFirstWire = ApolloReviewTool.mapToolResultToToolResultBlockParam!(askFirstResult.data as never, 'toolu_af') as { content: string }
  check('the ask-first wire names the per-edit consent beside the build start', /each edit will ask/.test(askFirstWire.content) && /build begins NOW/.test(askFirstWire.content))

  const holdCtx = mkContext('apollo')
  const holdResult = (await ApolloReviewTool.call(
    { summary: 's', blockers: [], specFiles: [], decision: 'more-questions', refineNote: 'the save system' } as never,
    holdCtx as never,
  )) as { data: { buildStarted: boolean; interviewContinues?: boolean } }
  const holdMode = (holdCtx.getAppState() as never as { toolPermissionContext: { mode: string } }).toolPermissionContext.mode
  check(
    "'ask me more questions' ⇒ nothing moves: apollo holds, buildStarted=false, interviewContinues=true",
    holdResult.data.buildStarted === false && holdResult.data.interviewContinues === true && holdMode === 'apollo',
    `mode=${holdMode}`,
  )
  const holdWire = ApolloReviewTool.mapToolResultToToolResultBlockParam!(holdResult.data as never, 'toolu_h') as { content: string }
  check('the held wire speaks the discuss grammar (drafts held, resume the interview, review afresh)', /drafts held/.test(holdWire.content) && /Resume the interview/.test(holdWire.content) && /review afresh/.test(holdWire.content))
  check("the held wire carries the user's refine note verbatim", /the save system/.test(holdWire.content))

  // The prefix law retired the mode exemption: the tools array is part of
  // the prefix every thinking block is bound to, so the closing tool is
  // listed the same way in every mode — deferred like every deferrable
  // tool, from the conversation's first request — and refuses outside
  // apollo at call time through its own validateInput.
  const { isDeferredTool } = (await import('../../src/tools/ToolSearchTool/prompt.js')) as typeof import('../../src/tools/ToolSearchTool/prompt.js')
  check('ApolloReview is listed deferred in apollo too (never a mode-driven roster change)', isDeferredTool(ApolloReviewTool as never, 'apollo') === true)
  check(
    'ApolloReview stays deferred outside apollo (and for mode-less callers)',
    isDeferredTool(ApolloReviewTool as never, 'default') === true && isDeferredTool(ApolloReviewTool as never) === true,
  )
} catch (e) {
  console.log(`  [info] tool not loadable/drivable under bun-run (${String(e).split('\n')[0]}) — structural assertions`)
  const tool = src('tools', 'ApolloReviewTool', 'ApolloReviewTool.tsx')
  check("validateInput refuses mode !== 'apollo'", /mode !== 'apollo'/.test(tool))
  check('clean path asks; blockered path allows', /behavior: 'ask' as const/.test(tool) && /behavior: 'allow' as const/.test(tool))
  check('the handoff rides setPermissionModeWithGuards to flow-else-implement', /isAutoModeGateEnabled\(\)\s*\?\s*\['flow', 'implement'\]\s*:\s*\['implement'\]/.test(tool))
  check("the ask-first tier lands default (structural)", /'build-ask-first'\s*\?\s*\['default'\]/.test(tool))
  check("the held review is a typed outcome (structural)", /interviewContinues: true/.test(tool))
  check('the apollo deferral force-load arm exists (structural)', /APOLLO_REVIEW_TOOL_NAME && permissionMode === 'apollo'/.test(src('tools', 'ToolSearchTool', 'prompt.ts')))
}
{
  const tool = src('tools', 'ApolloReviewTool', 'ApolloReviewTool.tsx')
  check('subagents are refused at validation (main-agent-only)', /getAgentContext\(\) !== undefined \|\| context\.agentId/.test(tool))
  const tools = src('tools.ts')
  check('ApolloReviewTool is registered in the pool', /ApolloReviewTool,/.test(tools))
  const router = src('components', 'permissions', 'PermissionRequest.tsx')
  check('the consent router carries the Apollo review card', /ApolloReviewPermissionRequest/.test(router))
  // The consent card: three ruled answers; every yes rides the tool input
  // as a typed decision; esc stays the plain hold.
  const card = src('components', 'permissions', 'ApolloReviewPermissionRequest', 'ApolloReviewPermissionRequest.tsx')
  check(
    'the consent card offers the three ruled answers',
    /Yes — begin the build/.test(card) && /Yes — but ask me before each edit/.test(card) && /No — ask me more questions/.test(card),
  )
  check(
    'every yes rides the tool input as a decision; the hold is a typed outcome, not a reject',
    /decision: 'more-questions'/.test(card) && /decision: value/.test(card),
  )
  check('esc stays the plain hold (reject path preserved)', /onCancel=\{handleCancel\}/.test(card) && /onReject\(\)/.test(card))
  // The file dialog's session tier honours apollo: the QF-audited
  // permission-mode read completes the transition its label promises.
  const filesystem = src('utils', 'permissions', 'filesystem.ts')
  check(
    "modeSuggestion counts apollo with the ask-posture modes (the session tier moves apollo → implement)",
    /context\.mode === 'default' \|\| context\.mode === 'strategy' \|\| context\.mode === 'apollo'/.test(filesystem),
  )
  // The wire roster never reads the live mode: the deferred-name set is
  // mode-independent (the prefix law) and the roster's owner is the
  // tool-economy fold, not the stream core.
  const toolEconomy = src('services', 'providers', 'toolEconomy.ts')
  check('the wire roster resolves deferral without the live mode (the roster is mode-independent)', /isDeferredTool\(t\)/.test(toolEconomy) && !/rosterPermissionMode/.test(toolEconomy))
  // The receipt renders the held state.
  const ui = src('tools', 'ApolloReviewTool', 'UI.tsx')
  check('the transcript receipt has the held settled line', /the interview continues with more questions/.test(ui))
}

// ── 7 · the headless arm ────────────────────────────────────────────────────
section('headless/ACP: honest availability — and the SEAT-RUNNER acceptance')
{
  const handlers = src('cli', 'headless', 'controlHandlers.ts')
  check(
    "SDK/print set_permission_mode still rejects 'apollo' with guidance — GATED on the worker role stamp",
    /mode === 'apollo' && flagEnv\('MERCURY_CONCOURSE_WORKER'\) !== '1'[\s\S]{0,500}interactive-only/.test(handlers),
  )
  const acp = src('services', 'acp', 'acpServer.ts')
  check('the ACP advertised mode list does NOT advertise apollo (autopilot precedent)', !/id: 'apollo'/.test(acp))
}

// ── 8 · the seat-runner law (the operator-sighted carousel flicker) ─────────
// Since the one-door unification every interactive chat IS a daemon-hosted
// runner. The old refusal bounced the operator's shift+tab: the screen
// adopted apollo, this refusal answered the control, and the next facts
// beat snapped the chip back — apollo held for a split second, then broke.
// The law now: a runner wearing the concourse worker role stamp ACCEPTS
// apollo (its polls and review card ride the seat ask stream to the
// operator's face; the engine threads the live mode into every build); a
// genuine SDK/print embedder still refuses.
section('the seat runner accepts apollo; the SDK embedder still refuses')
{
  const priorMarker = process.env.MERCURY_CONCOURSE_WORKER
  try {
    const { resolvePermissionModeTransition, handleSetPermissionMode } = (await import(
      '../../src/cli/headless/controlHandlers.js'
    )) as typeof import('../../src/cli/headless/controlHandlers.js')
    const baseContext = {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      isBypassPermissionsModeAvailable: false,
    } as never

    delete process.env.MERCURY_CONCOURSE_WORKER
    const embedder = resolvePermissionModeTransition('apollo' as never, baseContext)
    check(
      'no role stamp (a genuine SDK/print embedder): apollo refuses with the interactive-only sentence',
      embedder.ok === false && /interactive-only/.test(embedder.ok === false ? embedder.error : ''),
      JSON.stringify(embedder),
    )

    process.env.MERCURY_CONCOURSE_WORKER = '1'
    const seat = resolvePermissionModeTransition('apollo' as never, baseContext)
    check(
      "the concourse session runner ACCEPTS apollo and the context lands on mode 'apollo'",
      seat.ok === true && (seat.ok ? (seat.context as { mode?: string }).mode === 'apollo' : false),
      JSON.stringify(seat),
    )

    // The wire door end-to-end: a success control_response and the
    // transitioned context returned (what the seat's facts then carry —
    // the chip stays on apollo instead of snapping back).
    const responses: unknown[] = []
    const outputStub = { enqueue: (m: unknown) => responses.push(m) } as never
    const landed = handleSetPermissionMode({ mode: 'apollo' as never }, 'req-apollo-1', baseContext, outputStub)
    const first = responses[0] as { type?: string; response?: { subtype?: string; response?: { mode?: string } } }
    check(
      'the wire door answers success and returns the apollo context',
      (landed as { mode?: string }).mode === 'apollo' && first?.response?.subtype === 'success' && first?.response?.response?.mode === 'apollo',
      JSON.stringify({ landed: (landed as { mode?: string }).mode, first }),
    )
  } finally {
    if (priorMarker === undefined) delete process.env.MERCURY_CONCOURSE_WORKER
    else process.env.MERCURY_CONCOURSE_WORKER = priorMarker
  }

  // THE AUTOPILOT TWIN (lead-authorized): the same door's autopilot arm
  // had the identical pre-unification shape. A seat runner now accepts it
  // UNDER THE FULL RUNTIME ELIGIBILITY — the interactive guard's own
  // validateModeEntry (opt-in flag · policy kill · bypass launch flag), so
  // the wire can never be a consent backdoor — while a genuine embedder
  // still refuses toward sovereign.
  const priorMarker2 = process.env.MERCURY_CONCOURSE_WORKER
  const priorAutopilot = process.env.MERCURY_AUTOPILOT
  try {
    const { resolvePermissionModeTransition } = (await import(
      '../../src/cli/headless/controlHandlers.js'
    )) as typeof import('../../src/cli/headless/controlHandlers.js')
    const bypassContext = {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      isBypassPermissionsModeAvailable: true,
    } as never
    const noBypassContext = {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {},
      isBypassPermissionsModeAvailable: false,
    } as never

    delete process.env.MERCURY_CONCOURSE_WORKER
    process.env.MERCURY_AUTOPILOT = '1'
    const embedder = resolvePermissionModeTransition('autopilot' as never, bypassContext)
    check(
      'autopilot, no role stamp: the embedder still refuses toward sovereign',
      embedder.ok === false && /in SDK\/print mode/.test(embedder.ok === false ? embedder.error : ''),
      JSON.stringify(embedder),
    )

    process.env.MERCURY_CONCOURSE_WORKER = '1'
    delete process.env.MERCURY_AUTOPILOT
    const unarmed = resolvePermissionModeTransition('autopilot' as never, bypassContext)
    check(
      'autopilot on the seat WITHOUT the opt-in: the eligibility owner refuses (no consent backdoor)',
      unarmed.ok === false && /MERCURY_AUTOPILOT/.test(unarmed.ok === false ? unarmed.error : ''),
      JSON.stringify(unarmed),
    )
    process.env.MERCURY_AUTOPILOT = '1'
    const noLaunch = resolvePermissionModeTransition('autopilot' as never, noBypassContext)
    check(
      'autopilot on the seat WITHOUT the bypass launch flag: refused with the runtime guard sentence',
      noLaunch.ok === false && /dangerously-skip-permissions/.test(noLaunch.ok === false ? noLaunch.error : ''),
      JSON.stringify(noLaunch),
    )
    const eligible = resolvePermissionModeTransition('autopilot' as never, bypassContext)
    check(
      "the FULLY ELIGIBLE seat (opt-in + bypass launch) accepts autopilot, context on mode 'autopilot'",
      eligible.ok === true && (eligible.ok ? (eligible.context as { mode?: string }).mode === 'autopilot' : false),
      JSON.stringify(eligible),
    )
  } finally {
    if (priorMarker2 === undefined) delete process.env.MERCURY_CONCOURSE_WORKER
    else process.env.MERCURY_CONCOURSE_WORKER = priorMarker2
    if (priorAutopilot === undefined) delete process.env.MERCURY_AUTOPILOT
    else process.env.MERCURY_AUTOPILOT = priorAutopilot
  }

  // The threading that makes acceptance MEANINGFUL, structural: the main
  // engine passes the live mode into every build (REPL and runner alike),
  // and the subagent build passes none (the main-agent-only law).
  const engine = src('QueryEngine.ts')
  check(
    'QueryEngine threads the live toolPermissionContext.mode into fetchSystemPromptParts',
    /permissionMode: appStateSnapshot\.toolPermissionContext\.mode/.test(engine),
  )
  const agentTool = src('tools', 'AgentTool', 'AgentTool.tsx')
  check(
    'the subagent prompt build passes NO permissionMode (main-agent-only holds by construction)',
    /getSystemPrompt\(\s*options\.tools,\s*options\.mainLoopModel,[\s\S]{0,220}options\.mcpClients,\s*\)/.test(agentTool),
  )
  // The face reads the mode chip from the CONNECTOR's facts — with the
  // runner accepting, the facts carry apollo and the chip stays.
  const frame = src('components', 'MercuryFrame.tsx')
  check('the mode chip reads the connector facts (the surface the old refusal snapped back)', /getFocusedSessionConnector\(\)\.permissionMode\(\)/.test(frame))
}

// ── 8b · the seat's initial posture (the birth road) ────────────────────────
// A session born from the Boot face in Apollo Mode carries the operator's
// mode into the admission; the seat's initial posture used to admit only
// the headless postures and fell back to flow — the screen believed apollo
// while the seat ran flow, the roster never shipped ApolloReview, the review
// card never painted. The law: the CARRIED override may be 'apollo' (a
// cockpit-attached seat has a face; its control door accepts apollo under
// the role stamp); the saved default and the daemon's env road keep the
// strict headless list; the spec carries the posture to the argv.
section("the seat's initial posture: a carried 'apollo' crosses the admission; the strict list holds elsewhere")
{
  const { seatInitialPermissionMode } = (await import('../../src/daemon/concourseSupervisor.js')) as typeof import('../../src/daemon/concourseSupervisor.js')
  const { getHeadlessPermissionMode, headlessPermissionArgv, HEADLESS_PERMISSION_MODES } = (await import('../../src/daemon/headlessRun.js')) as typeof import('../../src/daemon/headlessRun.js')
  const headless = HEADLESS_PERMISSION_MODES as readonly string[]
  check("a carried 'apollo' crosses the admission as apollo", seatInitialPermissionMode('apollo' as never) === 'apollo')
  check("a carried headless posture crosses as itself ('flow', 'implement')", seatInitialPermissionMode('flow' as never) === 'flow' && seatInitialPermissionMode('implement' as never) === 'implement')
  check("a carried interactive-only posture that is not apollo ('strategy') never crosses — the seat falls to a headless posture", headless.includes(seatInitialPermissionMode('strategy' as never)))
  check('nothing carried ⇒ a headless posture (the saved default, else flow)', headless.includes(seatInitialPermissionMode()))
  const priorEnv = process.env.MERCURY_DAEMON_PERMISSION_MODE
  try {
    delete process.env.MERCURY_DAEMON_PERMISSION_MODE
    check("the spec's carried apollo reaches the child's posture when the daemon env is unset", getHeadlessPermissionMode('apollo') === 'apollo')
    check("…spelled on the argv as --permission-mode apollo", JSON.stringify(headlessPermissionArgv('apollo')) === JSON.stringify(['--permission-mode', 'apollo']))
    process.env.MERCURY_DAEMON_PERMISSION_MODE = 'implement'
    check("the operator's daemon env still wins over the carried posture (the strict road)", getHeadlessPermissionMode('apollo') === 'implement')
    process.env.MERCURY_DAEMON_PERMISSION_MODE = 'apollo'
    check("the daemon env never spells apollo — an invalid value falls to the spec default", getHeadlessPermissionMode('flow') === 'flow')
  } finally {
    if (priorEnv === undefined) delete process.env.MERCURY_DAEMON_PERMISSION_MODE
    else process.env.MERCURY_DAEMON_PERMISSION_MODE = priorEnv
  }
  const supervisor = src('daemon', 'concourseSupervisor.ts')
  check("the apollo arm sits on the CARRIED road alone (the saved default still resolves through the headless list)", /decodePermissionModeSpelling\(override\) === 'apollo'\) return 'apollo'/.test(supervisor) && /const saved = asHeadless\(getInitialSettings\(\)\.permissions\?\.defaultMode\)/.test(supervisor))
  const hop = src('services', 'switchboard', 'hopIntoSession.ts')
  check('the birth road carries the boot facts posture into the admission', /bootBirthFacts\(\)\.permissionMode/.test(hop))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL APOLLO STATION PROOFS PASS')
else console.log(`❌ ${failures} APOLLO PROOF(S) FAILED`)
console.log('═'.repeat(76))
if (!carouselLoadable) console.log('(carousel checks ran structurally — see [info] above)')
process.exit(failures === 0 ? 0 : 1)
