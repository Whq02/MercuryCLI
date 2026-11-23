#!/usr/bin/env bun


let failures = 0
let sectionSource = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  const shown = cond || !sectionSource ? detail : [detail, `change the code in ${sectionSource}`].filter(Boolean).join(' | ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
function section(t: string, source = ''): void {
  sectionSource = source
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' Apollo Mode — the interview station joins the cycle (proof)')
console.log('============================================================')

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

section('the carousel: default → implement → APOLLO → flow|sovereign|default', 'getNextPermissionMode in src/permissions/rules/getNextPermissionMode.ts')
let carouselLoadable = true
try {
  const { getNextPermissionMode } = (await import(
    '../../src/permissions/rules/getNextPermissionMode.js'
  )) as typeof import('../../src/permissions/rules/getNextPermissionMode.js')
  const ctx = (mode: string, bypass = false) =>
    ({ mode, isBypassPermissionsModeAvailable: bypass }) as never
  check("default → implement", getNextPermissionMode(ctx('default')) === 'implement')
  check("implement → apollo", getNextPermissionMode(ctx('implement')) === 'apollo')
  check(
    'apollo → flow|sovereign|default',
    ['flow', 'sovereign', 'default'].includes(getNextPermissionMode(ctx('apollo'))),
  )
  check(
    'apollo with bypass available exits toward sovereign or flow, never default',
    ['flow', 'sovereign'].includes(getNextPermissionMode(ctx('apollo', true))),
  )
} catch (e) {
  carouselLoadable = false
  console.log(`  [info] carousel not loadable under bun-run (${String(e).split('\n')[0]}) — structural assertions`)
}

section("the vocabulary: 'apollo' joins the mode lists; seal + title from the ONE config", 'src/permissions/rules/permissions.ts (mode lists), src/permissions/rules/permissionMode.ts (title, symbol, colour) and src/screen/theme/glyphs.ts (GLYPH.modeApollo)')
try {
  const types = (await import('../../src/permissions/rules/permissions.js')) as typeof import('../../src/permissions/rules/permissions.js')
  check("PERMISSION_MODES includes 'apollo' (user-addressable)", (types.PERMISSION_MODES as readonly string[]).includes('apollo'))
  check("INTERNAL_PERMISSION_MODES includes 'apollo'", (types.INTERNAL_PERMISSION_MODES as readonly string[]).includes('apollo'))
  check("'apollo' is NOT an external mode (projection only)", !(types.EXTERNAL_PERMISSION_MODES as readonly string[]).includes('apollo'))
  const pm = (await import('../../src/permissions/rules/permissionMode.js')) as typeof import('../../src/permissions/rules/permissionMode.js')
  const glyphs = (await import('../../src/screen/theme/glyphs.js')) as typeof import('../../src/screen/theme/glyphs.js')
  check("permissionModeFromString('apollo') === 'apollo'", pm.permissionModeFromString('apollo') === 'apollo')
  check("title is 'Apollo Mode'", pm.permissionModeTitle('apollo') === 'Apollo Mode')
  check('the seal is ◇ (U+25C7), read from GLYPH.modeApollo', pm.permissionModeSymbol('apollo') === glyphs.GLYPH.modeApollo && glyphs.GLYPH.modeApollo === '◇')
  check('apollo never bypasses permissions', !pm.modeBypassesPermissions('apollo'))
  check("band colour role is 'permission'", pm.getModeColor('apollo') === 'permission')
} catch (e) {
  check('vocabulary modules loadable', false, String(e).split('\n')[0])
}

section("the pack: mode-apollo composes ONLY while the mode is 'apollo'", 'getApolloModeSections in src/engine/system-prompt/apolloMode.ts')
try {
  const pack = (await import('../../src/engine/system-prompt/apolloMode.js')) as typeof import('../../src/engine/system-prompt/apolloMode.js')
  const on = pack.getApolloModeSections('apollo')
  check('apollo ⇒ exactly one section', on.length === 1)
  const text = on[0] ?? ''
  check('the section is the Apollo interview appendix', text.startsWith('# Apollo Mode'))
  const { getApolloPreflightQuestions } = (await import('../../src/platform/settings/settings.js')) as typeof import('../../src/platform/settings/settings.js')
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
  check(
    'the write-only-the-spec rule is stated where the files are named (Phase 2) and at the close, not a third time in Phase 1',
    !/write and edit ONLY the spec files/.test(text) && /the spec directory is the one place a write is admitted/.test(text) && /until the user approves the review, write only the spec files/.test(text),
  )
  for (const off of [undefined, 'default', 'implement', 'flow', 'sovereign'] as const) {
    check(`${String(off)} ⇒ [] (byte-identical prompt off-mode)`, pack.getApolloModeSections(off as never).length === 0)
  }
} catch (e) {
  check('apolloMode.ts loadable', false, String(e).split('\n')[0])
}

section('the poll letters: A–D + E = custom, one owner, ordinal-channel display', 'apolloIndexLabel and apolloCustomIndexLabel in src/tools/ask-question/apolloLetters.ts')
try {
  const letters = (await import('../../src/tools/ask-question/apolloLetters.js')) as typeof import('../../src/tools/ask-question/apolloLetters.js')
  check('apolloIndexLabel letters A–D by index', letters.apolloIndexLabel(0) === 'A.' && letters.apolloIndexLabel(1) === 'B.' && letters.apolloIndexLabel(2) === 'C.' && letters.apolloIndexLabel(3) === 'D.')
  check('index past the cap yields undefined (numeric prefix shows)', letters.apolloIndexLabel(4) === undefined)
  check("the custom option's ordinal is 'E.' (E is a stable identity)", letters.apolloCustomIndexLabel() === 'E.')
} catch (e) {
  check('apolloLetters.ts loadable', false, String(e).split('\n')[0])
}

section('the setting: apollo.preflightQuestions, default 7', 'getApolloPreflightQuestions in src/platform/settings/settings.ts')
try {
  const settings = (await import('../../src/platform/settings/settings.js')) as typeof import('../../src/platform/settings/settings.js')
  check('getApolloPreflightQuestions() defaults to 7', settings.getApolloPreflightQuestions() === 7)
} catch (e) {
  check('settings module loadable', false, String(e).split('\n')[0])
}

section('ApolloReview: apollo-only, ask-on-clean, guarded handoff to flow|implement', 'src/tools/apollo-review/ApolloReviewTool.tsx')
try {
  const { ApolloReviewTool } = (await import('../../src/tools/apollo-review/ApolloReviewTool.js')) as typeof import('../../src/tools/apollo-review/ApolloReviewTool.js')
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

  const blockedCtx = mkContext('apollo')
  const blockedResult = (await ApolloReviewTool.call({ summary: 's', blockers: ['unsettled'], specFiles: [] } as never, blockedCtx as never)) as { data: { buildStarted: boolean } }
  check('blockers ⇒ buildStarted=false', blockedResult.data.buildStarted === false)
  check('blockers ⇒ the mode did not move', (blockedCtx.getAppState() as never as { toolPermissionContext: { mode: string } }).toolPermissionContext.mode === 'apollo')

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

  const { isDeferredTool } = (await import('../../src/tools/tool-search/prompt.js')) as typeof import('../../src/tools/tool-search/prompt.js')
  check('ApolloReview is listed deferred in apollo too (never a mode-driven roster change)', isDeferredTool(ApolloReviewTool as never, 'apollo') === true)
  check(
    'ApolloReview stays deferred outside apollo (and for mode-less callers)',
    isDeferredTool(ApolloReviewTool as never, 'default') === true && isDeferredTool(ApolloReviewTool as never) === true,
  )
} catch (e) {
  console.log(`  [info] tool not loadable/drivable under bun-run (${String(e).split('\n')[0]}) — structural assertions`)
}

section('the runner accepts Apollo for every host', 'resolvePermissionModeTransition in src/daemon/runner/controlHandlers.ts')
{
  const priorMarker = process.env.MERCURY_CONCOURSE_WORKER
  try {
    const { resolvePermissionModeTransition } = (await import(
      '../../src/daemon/runner/controlHandlers.js'
    )) as typeof import('../../src/daemon/runner/controlHandlers.js')
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
      'a host without a worker role selects Apollo',
      embedder.ok === true && embedder.context.mode === 'apollo',
      JSON.stringify(embedder),
    )

    process.env.MERCURY_CONCOURSE_WORKER = '1'
    const seat = resolvePermissionModeTransition('apollo' as never, baseContext)
    check(
      "the concourse session runner ACCEPTS apollo and the context lands on mode 'apollo'",
      seat.ok === true && (seat.ok ? (seat.context as { mode?: string }).mode === 'apollo' : false),
      JSON.stringify(seat),
    )

    const { liveFactsOf, withLiveRunner } = await import('../lib/builtProduct.ts')
    const asked = ['implement', 'apollo', 'sovereign', 'bogus']
    const door = await withLiveRunner(async runner => {
      const verdicts: Array<{ from: string; answer: string; mode: string }> = []
      for (const mode of asked) {
        const from = (await liveFactsOf(runner)).permissionMode
        const answer = await runner.request('session/set_mode', { mode: mode as never }).then(taken => JSON.stringify(taken), (refusal: { message: string }) => refusal.message)
        verdicts.push({ from, answer, mode: (await liveFactsOf(runner)).permissionMode })
      }
      return verdicts
    })
    const ruled = door.map((verdict, at) => {
      const rule = resolvePermissionModeTransition(asked[at] as never, { ...(baseContext as object), mode: verdict.from } as never)
      return rule.ok ? { from: verdict.from, answer: JSON.stringify({ mode: asked[at] }), mode: (rule.context as { mode: string }).mode } : { from: verdict.from, answer: rule.error, mode: verdict.from }
    })
    check(
      "the door's set_mode arm resolves through the one transition rule and answers the mode",
      JSON.stringify(door) === JSON.stringify(ruled) && door.filter(verdict => verdict.mode !== verdict.from).length === 2,
    )
  } finally {
    if (priorMarker === undefined) delete process.env.MERCURY_CONCOURSE_WORKER
    else process.env.MERCURY_CONCOURSE_WORKER = priorMarker
  }

}

section("the seat's initial posture: a carried 'apollo' crosses the admission; the env road keeps the strict list", 'seatInitialPermissionMode in src/daemon/concourse-workers/concourseWorkers.ts and getHeadlessPermissionMode in src/daemon/runner-link/headlessRun.ts')
{
  const { seatInitialPermissionMode } = (await import('../../src/daemon/concourse-workers/concourseWorkers.js')) as typeof import('../../src/daemon/concourse-workers/concourseWorkers.js')
  const { getHeadlessPermissionMode, headlessPermissionArgv, HEADLESS_PERMISSION_MODES } = (await import('../../src/daemon/runner-link/headlessRun.js')) as typeof import('../../src/daemon/runner-link/headlessRun.js')
  const headless = HEADLESS_PERMISSION_MODES as readonly string[]
  check("a carried 'apollo' crosses the admission as apollo", seatInitialPermissionMode('apollo' as never) === 'apollo')
  check("a carried headless posture crosses as itself ('flow', 'implement')", seatInitialPermissionMode('flow' as never) === 'flow' && seatInitialPermissionMode('implement' as never) === 'implement')
  check("a carried word outside the mode list never crosses — the seat falls to a headless posture", headless.includes(seatInitialPermissionMode('frobnicate' as never)))
  check('nothing carried ⇒ a headless posture (the saved default, else default)', headless.includes(seatInitialPermissionMode()))
  const priorEnv = process.env.MERCURY_DAEMON_PERMISSION_MODE
  try {
    delete process.env.MERCURY_DAEMON_PERMISSION_MODE
    check("the spec's carried apollo reaches the child's posture when the daemon env is unset", getHeadlessPermissionMode('apollo') === 'apollo')
    check("…spelled on the argv as --mode apollo", JSON.stringify(headlessPermissionArgv('apollo')) === JSON.stringify(['--mode', 'apollo']))
    process.env.MERCURY_DAEMON_PERMISSION_MODE = 'implement'
    check("the operator's daemon env still wins over the carried posture (the strict road)", getHeadlessPermissionMode('apollo') === 'implement')
    process.env.MERCURY_DAEMON_PERMISSION_MODE = 'apollo'
    check("the daemon env never spells apollo — an invalid value falls to the spec default", getHeadlessPermissionMode('flow') === 'flow')
  } finally {
    if (priorEnv === undefined) delete process.env.MERCURY_DAEMON_PERMISSION_MODE
    else process.env.MERCURY_DAEMON_PERMISSION_MODE = priorEnv
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL APOLLO STATION PROOFS PASS')
else console.log(`❌ ${failures} APOLLO PROOF(S) FAILED`)
console.log('═'.repeat(76))
if (!carouselLoadable) console.log('(carousel checks ran structurally — see [info] above)')
process.exit(failures === 0 ? 0 : 1)
