#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-surface-router.ts — the one
//  in-process route owner.
//
//  §1  typed refusals: unregistered surfaces refuse honestly, nothing moves.
//  §2  registration + typed return tokens: leaving restores the EXACT prior
//      route; stale tokens are single-use dead.
//  §3  stacked surfaces + the root unwind (Esc-home law).
//  §4  transition byte/process silence — structurally: the route owner
//      imports no termio/process machinery, and a full transition cycle
//      leaves the terminal-mode ledger UNTOUCHED (the in-process
//      half; the PTY census rides prove-route-silence.ts).
//  §5  the MERCURY_CONCOURSE closed value grammar (registered flag).
//  §6  resolveInitialSurface: flag + the bounded records summary
//      only; Off imports nothing; Auto counts pid-alive records; a torn
//      summary renders the honest idle answer.
//  §7  mount seeding adopts only registered routes.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

const t = checker()
scratchRoot('surface-router')

const route = await import('../../src/context/surfaceRoute.js')
const ledger = await import('../../src/ink/root/terminalModeLedger.js')

t.section('§1 — typed refusals while nothing is registered')
{
  route._resetSurfaceRouteForTesting()
  t.check('the initial route is the root REPL', route.currentSurfaceRoute().kind === 'repl', route.surfaceRouteId(route.currentSurfaceRoute()))
  const boot = route.enterBootSettings()
  t.check('enterBootSettings refuses surface-unregistered', !boot.ok && boot.code === 'surface-unregistered', JSON.stringify(boot))
  const conc = route.enterConcourse()
  t.check('enterConcourse refuses surface-unregistered (typed until registration)', !conc.ok && conc.code === 'surface-unregistered', JSON.stringify(conc))
  const sess = route.enterSessionRepl('abc')
  t.check('enterSessionRepl refuses surface-unregistered (typed until registration)', !sess.ok && sess.code === 'surface-unregistered', JSON.stringify(sess))
  const back = route.returnToConcourse()
  t.check('returnToConcourse refuses the same way', !back.ok && back.code === 'surface-unregistered', JSON.stringify(back))
  const empty = route.enterSessionRepl('')
  t.check('an empty session id is invalid-target, not a route', !empty.ok && empty.code === 'invalid-target', JSON.stringify(empty))
  t.check('nothing moved — still the root REPL, no return token', route.currentSurfaceRoute().kind === 'repl' && route.activeReturnToken() === null, route.surfaceRouteId(route.currentSurfaceRoute()))
}

t.section('§2 — registration, entry, and the exact-return token')
{
  route._resetSurfaceRouteForTesting()
  const unregister = route.registerRouteSurface('boot-settings', { render: () => null })
  t.check('the surface registers', route.routeSurfaceRegistered('boot-settings'), 'registered')
  // The landed chat-presence law (returnFromSurface): a token onto the chat
  // route restores only while a chat is PRESENT — the return legs below
  // register one; the absent-chat refusal arm is pinned at the section's end.
  const releasePresence = route.registerChatPresence({ present: () => true, subscribe: () => () => {} })
  const entered = route.enterBootSettings()
  t.check('enterBootSettings answers ok + a token', entered.ok === true, JSON.stringify(entered))
  t.check('the route moved', route.currentSurfaceRoute().kind === 'boot-settings', route.surfaceRouteId(route.currentSurfaceRoute()))
  const token = entered.ok ? entered.token : { to: route.ROOT_REPL_ROUTE, nonce: -1 }
  t.check('the token captures the EXACT prior route', token.to.kind === 'repl', JSON.stringify(token))
  t.check('activeReturnToken answers the same token', route.activeReturnToken()?.nonce === token.nonce, String(route.activeReturnToken()?.nonce))
  const again = route.enterBootSettings()
  t.check('re-entering the current surface refuses already-current', !again.ok && again.code === 'already-current', JSON.stringify(again))
  const left = route.returnFromSurface(token)
  t.check('returnFromSurface restores the exact prior route', left.ok && route.currentSurfaceRoute().kind === 'repl', route.surfaceRouteId(route.currentSurfaceRoute()))
  const stale = route.returnFromSurface(token)
  t.check('the token is single-use — a second return refuses', !stale.ok, JSON.stringify(stale))
  const reentered = route.enterBootSettings()
  const leave = route.leaveCurrentSurface()
  t.check('leaveCurrentSurface rides the active token', reentered.ok && leave.ok && route.currentSurfaceRoute().kind === 'repl', route.surfaceRouteId(route.currentSurfaceRoute()))
  // THE REFUSAL ARM (the landed law's other half): with NO chat present a
  // token onto the chat route refuses and the route STANDS — the bridge
  // that emptied is not a route to return to; the token survives the
  // refusal and restores once a chat is present again.
  const reenter2 = route.enterBootSettings()
  releasePresence()
  const refused = route.leaveCurrentSurface()
  t.check('a return onto the chat route with NO chat present refuses and the route stands', reenter2.ok && !refused.ok && route.currentSurfaceRoute().kind === 'boot-settings', route.surfaceRouteId(route.currentSurfaceRoute()))
  route.registerChatPresence({ present: () => true, subscribe: () => () => {} })
  const homeAgain = route.leaveCurrentSurface()
  t.check('the surviving token restores once a chat is present again (single-use spends on SUCCESS only)', homeAgain.ok && route.currentSurfaceRoute().kind === 'repl', route.surfaceRouteId(route.currentSurfaceRoute()))
  unregister()
  t.check('unregister removes the surface', !route.routeSurfaceRegistered('boot-settings'), 'unregistered')
}

t.section('§3 — stacked surfaces and the root unwind')
{
  route._resetSurfaceRouteForTesting()
  route.registerRouteSurface('boot-settings', { render: () => null })
  route.registerRouteSurface('concourse', { render: () => null })
  // The chat route is the focused session's bridge: home routes there only
  // while a chat is present (the strip pins the absent case), so the unwind
  // leg registers a present chat.
  route.registerChatPresence({ present: () => true, subscribe: () => () => {} })
  const c = route.enterConcourse()
  const b = route.enterBootSettings()
  t.check('concourse → boot-settings stacks two returns', c.ok && b.ok && route.currentSurfaceRoute().kind === 'boot-settings', route.surfaceRouteId(route.currentSurfaceRoute()))
  const back = route.leaveCurrentSurface()
  t.check('leaving boot-settings restores the CONCOURSE exactly (ruling 12)', back.ok && route.currentSurfaceRoute().kind === 'concourse', route.surfaceRouteId(route.currentSurfaceRoute()))
  route.enterBootSettings()
  const home = route.enterRootRepl()
  t.check('enterRootRepl unwinds every stacked surface', home.ok && route.currentSurfaceRoute().kind === 'repl' && route.activeReturnToken() === null, route.surfaceRouteId(route.currentSurfaceRoute()))
}

t.section('§4 — transition silence (ledger untouched; no termio/process imports)')
{
  route._resetSurfaceRouteForTesting()
  route.registerRouteSurface('boot-settings', { render: () => null })
  ledger._resetTerminalModeLedgerForTesting()
  ledger.noteModeAcquired('proof-owner', 'alt-screen')
  ledger.noteModeAcquired('proof-owner', 'mouse-tracking')
  const before = JSON.stringify(ledger.terminalModeLedgerSnapshot())
  const e = route.enterBootSettings()
  route.leaveCurrentSurface()
  route.enterBootSettings()
  route.enterRootRepl()
  const after = JSON.stringify(ledger.terminalModeLedgerSnapshot())
  t.check('a full transition cycle leaves the terminal-mode ledger IDENTICAL', e.ok && before === after, after)
  ledger._resetTerminalModeLedgerForTesting()

  const src = await Bun.file(join(process.cwd(), 'src/context/surfaceRoute.ts')).text()
  t.check(
    'the route owner imports no termio/child-process machinery (structural)',
    !/termio|child_process|node:child_process|spawn\(/.test(src),
    'surfaceRoute.ts import surface',
  )
  // AMENDED: commitTransition marks the
  // route-commit consumption watermark, so the route owner statically imports
  // the input-event SEAM (a pure counter module) alongside the flag registry.
  // The law's spirit — the store loads anywhere, transitions stay silent —
  // now guards the seam transitively: input-event itself must stay free of
  // termio/child-process machinery and import only the decoder tables + the
  // Event base.
  // AMENDED: cycleSurface is
  // the ONE guard site for the surface strip, so the owner also imports the
  // fullscreen gate (utils/fullscreen — an env-read predicate; its tmux
  // probe is cached and already warmed by every fullscreen boot path). A
  // transition itself still changes no terminal mode — the ledger check
  // above keeps those teeth.
  // AMENDED (the strip counts its stops from what exists): the owner reads
  // the persisted concourse switch (services/concourse/concourseEnabled — a
  // config-read predicate) for the concourse stop; the chat stop arrives
  // through a REGISTERED presence seam, never a slot import (the slot's
  // static graph reaches the supervisor, which the Off path must not carry).
  // AMENDED (the host's key spelling, class-5 seams): the strip legend
  // paints its shift+←/→ hints through keyHintLabel — a PURE string fold
  // whose only import is the platform predicate; the transitive-silence
  // tooth below covers it like the input-event seam.
  t.check(
    "the route owner's only static imports are the flag registry + the input-event seam + the CB-10 fullscreen gate + the concourse switch + the key-hint fold (+ types)",
    (src.match(/^import .*from '(.*)'/gm) ?? []).every(
      l => l.includes('flagRegistry') || l.includes('ink/events/input-event') || l.includes('utils/fullscreen') || l.includes('services/concourse/concourseEnabled') || l.includes('components/mercury-ui/keyHintLabel'),
    ),
    JSON.stringify(src.match(/^import .*from '(.*)'/gm) ?? []),
  )
  // Import-shaped needle: the landed presence-seam docblock lawfully NAMES
  // the slot module in prose — only an IMPORT line is the disease.
  t.check(
    'the route owner never imports the focused slot (the chat stop rides the registered presence seam)',
    !(src.match(/^import .*from '(.*)'/gm) ?? []).some(l => l.includes('engine-connector/focusedConnector')) && /registerChatPresence/.test(src),
    'surfaceRoute.ts import surface',
  )
  const hintSrc = await Bun.file(join(process.cwd(), 'src/components/mercury-ui/keyHintLabel.ts')).text()
  t.check(
    'the key-hint fold imports only the platform predicate (transitive silence)',
    !/termio|child_process|node:child_process|spawn\(/.test(hintSrc) &&
      (hintSrc.match(/^import .*from '(.*)'/gm) ?? []).every(l => l.includes('utils/platform')),
    JSON.stringify(hintSrc.match(/^import .*from '(.*)'/gm) ?? []),
  )
  const seamSrc = await Bun.file(join(process.cwd(), 'src/ink/events/input-event.ts')).text()
  t.check(
    'the input-event seam imports no termio/child-process machinery (transitive silence)',
    !/termio|child_process|node:child_process|spawn\(/.test(seamSrc),
    'input-event.ts import surface',
  )
  t.check(
    'the input-event seam statically imports only the decoder tables + the Event base',
    (seamSrc.match(/^import .*from '(.*)'/gm) ?? []).every(
      l => l.includes('input-decoder') || l.includes('./event'),
    ),
    JSON.stringify(seamSrc.match(/^import .*from '(.*)'/gm) ?? []),
  )
}

t.section('§5 — the MERCURY_CONCOURSE closed value grammar')
{
  const { getFlagSpec } = await import('../../src/substrate/flagRegistry.js')
  t.check('MERCURY_CONCOURSE is a registered flag', getFlagSpec('MERCURY_CONCOURSE') != null, String(getFlagSpec('MERCURY_CONCOURSE')?.kind))
  t.check('unset resolves off', route.resolveConcoursePolicy({}) === 'off', route.resolveConcoursePolicy({}))
  t.check("'auto' resolves auto", route.resolveConcoursePolicy({ MERCURY_CONCOURSE: 'auto' }) === 'auto', 'auto')
  t.check("'always' resolves always", route.resolveConcoursePolicy({ MERCURY_CONCOURSE: 'always' }) === 'always', 'always')
  t.check("'off' resolves off", route.resolveConcoursePolicy({ MERCURY_CONCOURSE: 'off' }) === 'off', 'off')
  t.check('an unknown value resolves off (closed grammar, never a guess)', route.resolveConcoursePolicy({ MERCURY_CONCOURSE: 'sometimes' }) === 'off', 'sometimes→off')
}

t.section('§6 — resolveInitialSurface reads flag + the bounded summary only')
{
  route._resetSurfaceRouteForTesting()
  const dir = mkdtempSync(join(tmpdir(), 'signalhouse-router-'))
  try {
    const off = await route.resolveInitialSurface({ env: {}, recordsDir: dir })
    t.check('Off: the root REPL, reason concourse-off, no summary read', off.effective.kind === 'repl' && off.reason === 'concourse-off' && off.liveWorkers === undefined, JSON.stringify(off))

    const alwaysUnreg = await route.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'always' }, recordsDir: dir })
    t.check(
      'Always without a registered surface: requested concourse, EFFECTIVE repl, typed reason',
      alwaysUnreg.requested.kind === 'concourse' && alwaysUnreg.effective.kind === 'repl' && alwaysUnreg.reason === 'concourse-surface-unregistered',
      JSON.stringify(alwaysUnreg),
    )

    route.registerRouteSurface('concourse', { render: () => null })
    const always = await route.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'always' }, recordsDir: dir })
    t.check('Always with the surface registered resolves concourse', always.effective.kind === 'concourse' && always.reason === 'always', JSON.stringify(always))

    // NEW-2: an explicit continue/resume/doctor journey records
    // the 'repl' boot-surface intent, and the intent OUTRANKS the policy in
    // both directions — a policy-always Concourse must never mount the
    // operator's chosen conversation covered beneath the opaque host.
    const { _setBootSurfaceIntentForTesting } = await import('../../src/substrate/splashHandover.js')
    _setBootSurfaceIntentForTesting('repl')
    const chosenRepl = await route.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'always' }, recordsDir: dir })
    t.check(
      "the 'repl' intent outranks a policy-always Concourse (reason splash-intent)",
      chosenRepl.effective.kind === 'repl' && chosenRepl.reason === 'splash-intent',
      JSON.stringify(chosenRepl),
    )
    const afterIntent = await route.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'always' }, recordsDir: dir })
    t.check(
      'the intent is one-shot — the next resolution answers the policy again',
      afterIntent.effective.kind === 'concourse' && afterIntent.reason === 'always',
      JSON.stringify(afterIntent),
    )

    const autoIdle = await route.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'auto' }, recordsDir: dir })
    t.check('Auto with no records: idle → repl, liveWorkers 0', autoIdle.effective.kind === 'repl' && autoIdle.reason === 'auto-idle' && autoIdle.liveWorkers === 0, JSON.stringify(autoIdle))

    const mkRecord = (n: number) => ({
      schema: 1,
      runnerId: `concourse-w${n}`,
      sessionId: `sess-${n}`,
      workspaceId: `/tmp/ws-${n}`,
      isolation: 'exclusive',
      modelKey: 'fable',
      spawnedAt: 1,
      lastLiveAt: 1,
      pid: process.pid,
    })
    writeFileSync(
      join(dir, 'concourse-workers.json'),
      JSON.stringify({ version: 1, workers: { 'concourse-w1': mkRecord(1), 'concourse-w2': mkRecord(2) } }),
    )
    const autoLive = await route.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'auto' }, recordsDir: dir })
    t.check(
      'Auto with two pid-alive records enters the concourse (the >1 rule)',
      autoLive.effective.kind === 'concourse' && autoLive.reason === 'auto-live-sessions' && autoLive.liveWorkers === 2,
      JSON.stringify(autoLive),
    )

    writeFileSync(
      join(dir, 'concourse-workers.json'),
      JSON.stringify({ version: 1, workers: { 'concourse-w1': mkRecord(1) } }),
    )
    const autoOne = await route.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'auto' }, recordsDir: dir })
    t.check('Auto with ONE live session stays on the root REPL', autoOne.effective.kind === 'repl' && autoOne.reason === 'auto-idle' && autoOne.liveWorkers === 1, JSON.stringify(autoOne))

    writeFileSync(join(dir, 'concourse-workers.json'), '{torn')
    const torn = await route.resolveInitialSurface({ env: { MERCURY_CONCOURSE: 'auto' }, recordsDir: dir })
    t.check('a torn summary renders the honest idle answer, never a block', torn.effective.kind === 'repl' && torn.liveWorkers === 0, JSON.stringify(torn))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

t.section('§7 — mount seeding adopts only registered routes')
{
  route._resetSurfaceRouteForTesting()
  route.initializeSurfaceRoute({ kind: 'concourse' })
  t.check('an unregistered initial route falls to the root REPL', route.currentSurfaceRoute().kind === 'repl', route.surfaceRouteId(route.currentSurfaceRoute()))
  route.registerRouteSurface('concourse', { render: () => null })
  route.initializeSurfaceRoute({ kind: 'concourse' })
  t.check('a registered initial route is adopted', route.currentSurfaceRoute().kind === 'concourse', route.surfaceRouteId(route.currentSurfaceRoute()))
  route._resetSurfaceRouteForTesting()
}

t.section('§8 — every boot journey hosts the router (NEW-1: no bare REPL mount)')
{
  // The interactive picker path (--resume) mounts REPL by an in-place swap
  // inside ResumeConversation — NOT through launchRepl. Before it
  // mounted BARE: no SurfaceRouter, registration never ran, the registry sat
  // empty — surface chords were silent no-ops and /concourse//bootmenu
  // refused with 'not registered in this build' (a ruling-1 violation: the
  // splash 'resume' receipt lands exactly there). Ratchet the hosting.
  const resumeSrc = readFileSync(join(import.meta.dir, '../../src/screens/ResumeConversation.tsx'), 'utf8')
  t.check(
    'ResumeConversation imports SurfaceRouter (registration rides the module side effect)',
    /import \{ SurfaceRouter \} from '\.\.\/components\/SurfaceRouter\.js'/.test(resumeSrc),
  )
  t.check(
    'the post-pick REPL swap is hosted under SurfaceRouter, never bare',
    /<SurfaceRouter><REPL /.test(resumeSrc) && /<\/SurfaceRouter>\);/.test(resumeSrc),
  )
  t.check(
    'the route owner is seeded to the root before the resume paints and the swap (the pick is an explicit REPL journey)',
    resumeSrc.indexOf('initializeSurfaceRoute(ROOT_REPL_ROUTE);') !== -1 &&
      resumeSrc.indexOf('initializeSurfaceRoute(ROOT_REPL_ROUTE);') < resumeSrc.indexOf('focusResumedSession(') &&
      resumeSrc.indexOf('focusResumedSession(') < resumeSrc.indexOf('setResumeData({'),
  )
}

t.finish('prove-surface-router')
