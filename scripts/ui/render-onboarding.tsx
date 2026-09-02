#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/render-onboarding.tsx — the OWNED first-run walk RENDERED
//  Mounts the REAL <Onboarding/> in a PTY with a fresh hermetic config home
//  (Anthropic auth ENABLED — the walk of a virgin machine) and photographs
//  every station the component owns, at 100 and 120 cols:
//    · the fitting (theme): MercurySetupFrame header + rail, the critter,
//      the speech bubble, the two reachable theme rows, the syntax diff;
//    · the ONE provider station ("sign in"): the /logins card mounted in
//      place — ALL nine family rows on one screen (the shared row owner)
//      plus the "sign in later" row with its honest caveat; the retired
//      second sign-in station can never paint (no 'provider' rail label);
//    · the skip path INSIDE the component: later-row ↵ lands Guardrails
//      (voiced copy), then Terminal keys (TERM_PROGRAM pinned vscode);
//    · the foreign moon art can NEVER appear (' ██▒▒██ ' and 'clawd'
//      asserted ABSENT); no emoji;
//    · captures pin MERCURY_LIVE_GLYPHS=0 + MERCURY_CRITTER_GAZE=0 (the
//      frame-0 static degradation contract).
//  Hermetic: every endpoint base is pinned dead, BROWSER=true, scratch
//  MERCURY_CONFIG_DIR per capture — the idle catalogue touches no network,
//  and no scripted keystroke can reach a real endpoint.
// ============================================================================
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '1.0.0',
  ISSUES_EXPLAINER: '',
  PACKAGE_URL: '',
  README_URL: '',
  IS_DEV: false,
  IS_DEMO: false,
}

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = join(dirname(SELF), 'vshot.py')

if (process.env.ONBOARDING_RENDER_CHILD) {
  const React = await import('react')
  const { render } = (await import('../../src/ink.js')) as {
    render: (n: React.ReactNode) => Promise<unknown>
  }
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
  const { Onboarding } = await import('../../src/components/Onboarding.js')
  const { addBootNote } = await import('../../src/substrate/bootNotes.js')
  addBootNote('info', 'runtime abc1234 · repo main def5678 — refresh: scripts/ops/deploy-runtime.sh')
  const h = React.createElement
  void render(
    h(
      AppStateProvider as never,
      { onChangeAppState: () => {} } as never,
      h(
        KeybindingSetup as never,
        {} as never,
        h(Onboarding as never, { onDone: () => {} } as never),
      ),
    ),
  )
  setTimeout(() => process.exit(0), 16000)
} else {
  let failures = 0
  const check = (label: string, cond: boolean, detail = ''): void => {
    if (!cond) failures++
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  }
  if (!existsSync(VSHOT)) {
    console.error('vshot.py missing — render-verify required')
    process.exit(1)
  }

  type Send = { data: string; atTick?: number; minTick?: number; awaitText?: string; awaitSettleTicks?: number; afterPrevTicks?: number; requireAwait?: boolean }
  const DEAD = 'http://127.0.0.1:9'

  const capture = (tag: string, cols: number, sends: Send[], readyText: string[]): string => {
    const home = mkdtempSync(join(tmpdir(), 'onboarding-home-'))
    const cfg = `/tmp/vs-onboarding-${tag}-${cols}.json`
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MERCURY_CONFIG_DIR: home,
      ONBOARDING_RENDER_CHILD: '1',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CRITTER_GAZE: '0',
      MERCURY_CRITTER_IDLE: '0',
      // The walk of a VIRGIN machine: Anthropic auth enabled (no external
      // token/key), so the provider station exists. Every endpoint base the
      // run could conceivably reach is pinned dead and the browser command
      // is inert — an unpinned base fails open to real credentials.
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      BROWSER: 'true',
      ANTHROPIC_BASE_URL: DEAD,
      MERCURY_OPENAI_API_BASE: DEAD,
      MERCURY_OPENAI_CHATGPT_BASE: DEAD,
      MERCURY_OPENAI_AUTH_BASE: DEAD,
      MERCURY_OPENROUTER_API_BASE: DEAD,
      MERCURY_OPENROUTER_AUTH_BASE: DEAD,
      MERCURY_GEMINI_API_BASE: DEAD,
      MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
      MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
      MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
      MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
      MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
      MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
      MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`,
      MERCURY_ZAI_API_BASE: `${DEAD}/v4`,
      MERCURY_DEEPSEEK_API_BASE: DEAD,
      // Deterministic terminal station: a setup-capable TERM_PROGRAM with
      // the ambient IDE/terminal markers scrubbed (they outrank it).
      TERM_PROGRAM: 'vscode',
    }
    for (const key of [
      'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR',
      'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
      'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN',
      'CURSOR_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'VisualStudioVersion', 'TERMINAL_EMULATOR',
    ]) {
      delete env[key]
    }
    writeFileSync(
      cfg,
      JSON.stringify({
        argv: [process.execPath, 'run', SELF],
        sends,
        readyText,
        readySettleTicks: 3,
        stableTicks: 4,
        total: 70,
        cols,
        rows: 40,
        out: `/tmp/onboarding-${tag}-${cols}.json`,
      }),
    )
    try {
      return execFileSync('/usr/bin/python3', [VSHOT, cfg], {
        encoding: 'utf-8',
        timeout: 90000,
        env,
      })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  console.log('============================================================')
  console.log(' Owned onboarding render-verify — the one-station walk')
  console.log('============================================================')

  // ── the launcher handshake (shell → boot-notes.json → notes) ──
  {
    const { addBootNote, bootNotes, collectLauncherNotes, launcherNotesPath, _resetBootNotesForTesting } =
      await import('../../src/substrate/bootNotes.js')
    const home = mkdtempSync(join(tmpdir(), 'bootnotes-'))
    try {
      const file = launcherNotesPath(home)
      writeFileSync(file, JSON.stringify({ notes: [{ kind: 'warn', text: 'runtime stale' }, { kind: 'bogus', text: 'x' }, { text: '   ' }] }))
      collectLauncherNotes(home)
      const got = bootNotes()
      check('launcher notes ingested (warn kept, bogus kind → info, blank dropped)',
        got.length === 2 && got[0]?.kind === 'warn' && got[0]?.text === 'runtime stale' && got[1]?.kind === 'info')
      check('the handshake file is consumed', !existsSync(file))
      _resetBootNotesForTesting()
      writeFileSync(file, 'not json {{')
      collectLauncherNotes(home)
      check('malformed handshake never boots-fails and is still consumed', bootNotes().length === 0 && !existsSync(file))
      _resetBootNotesForTesting()
      for (let i = 0; i < 20; i++) addBootNote('info', `n${i}`)
      check('the note ring caps at 16', bootNotes().length === 16)
      _resetBootNotesForTesting()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  // The row owner is the needle source: a family added there must appear on
  // the walk's frame or the capture checks below redden.
  const { loginFamilyRows, SIGN_IN_LATER_ROW } = await import('../../src/components/loginFamilyRows.ts')
  const FAMILY_ROWS = loginFamilyRows({ engineLegs: true })

  // Transition sends are STRICT-gated (requireAwait — the settled-phase
  // law): each fires only once its station's needle is on screen and
  // settled; a never-ready station lands in vshot's undelivered-sends
  // refusal, loudly.
  const enterOnTheme: Send = { requireAwait: true, awaitText: 'welcome — pick our colors', awaitSettleTicks: 3, data: '\r' }
  const toLaterRow: Send[] = [
    enterOnTheme,
    // Nine ↓ from the catalogue's first row lands the tenth ("sign in
    // later"); the first waits for the catalogue itself.
    { requireAwait: true, awaitText: 'Sign in later', awaitSettleTicks: 2, data: '\x1b[B' },
    ...Array.from({ length: 8 }, (): Send => ({ afterPrevTicks: 2, data: '\x1b[B' })),
    { afterPrevTicks: 3, data: '\r' },
  ]

  for (const cols of [120, 100]) {
    console.log(`\n  ── the fitting @ ${cols} ──`)
    const grid = capture('fitting', cols, [], ['welcome — pick our colors'])
    check(`@${cols}: the wordmark header renders`, grid.includes('Mercury') && grid.includes('first run'))
    check(`@${cols}: the rail walks theme → sign in → guardrails → terminal → trust`,
      grid.includes('theme') && grid.includes('sign in') && grid.includes('guardrails') && grid.includes('terminal') && grid.includes('trust'))
    check(`@${cols}: ONE provider station — no 'provider' rail label beside 'sign in'`, !grid.includes('provider'))
    check(`@${cols}: the step tag counts the shrunken walk (theme · 1/5)`, grid.includes('theme · 1/5'))
    check(`@${cols}: the critter speaks the welcome`, grid.includes('welcome — pick our colors'))
    check(`@${cols}: the fitting byline`, grid.includes('the whole harness wears your pick'))
    check(`@${cols}: the two reachable theme rows`, grid.includes('Oasis dark · the oasis ground') && grid.includes('True Black · the same palette on pure black'))
    check(`@${cols}: the Mercury-real syntax diff`, grid.includes('helm.tsx') && grid.includes('bootHelm'))
    check(`@${cols}: footer verbs are the fitting's`, grid.includes('↑↓ preview · ↵ keep'))
    check(`@${cols}: the boot note rides the disclosure, not raw stderr`, grid.includes('boot note'))
    check(`@${cols}: NO foreign moon art`, !grid.includes('██▒▒██') && !grid.toLowerCase().includes('clawd'))
    check(`@${cols}: no emoji`, !/[\u{1F300}-\u{1FAFF}]/u.test(grid))
  }

  for (const cols of [120, 100]) {
    console.log(`\n  ── the provider station (the /logins catalogue) @ ${cols} ──`)
    const grid = capture('catalogue', cols, [enterOnTheme], ['Sign in later'])
    check(`@${cols}: the station is the sign-in moment (step tag)`, grid.includes('sign in · 2/5'))
    for (const row of FAMILY_ROWS) {
      check(`@${cols}: the ${row.value} row renders the card's own wording`, grid.includes(row.label), row.label)
    }
    check(`@${cols}: the "sign in later" row with its honest caveat`, grid.includes(SIGN_IN_LATER_ROW.label), SIGN_IN_LATER_ROW.label)
    check(`@${cols}: the opening line names the whole spread`, grid.includes('Mercury can run on a Claude or OpenAI subscription'))
    check(`@${cols}: the walk footer stays honest`, grid.includes('↑↓ move · ↵ choose · esc back'))
  }

  console.log('\n  ── the skip path: later-row ↵ lands Guardrails @ 100 ──')
  const afterSkip = capture('skip-guardrails', 100, toLaterRow, ['Guardrails'])
  check('guardrails heading renders', afterSkip.includes('Guardrails'))
  check('the step tag advanced without a credential (guardrails · 3/5)', afterSkip.includes('guardrails · 3/5'))
  check('the re-voiced copy (the mangled base line is dead)', afterSkip.includes('review what it does') && !afterSkip.includes('Mercuryreview'))
  check('prompt-injection guardrail present', afterSkip.includes('Prompt injection is real'))

  console.log('\n  ── the terminal station @ 100 ──')
  const terminal = capture('terminal', 100, [...toLaterRow, { requireAwait: true, awaitText: 'Guardrails', awaitSettleTicks: 2, data: '\r' }], ['Terminal keys'])
  check('the terminal station paints', terminal.includes('Terminal keys') && terminal.includes('terminal · 4/5'))
  check('the tweak line names the real chord', terminal.includes('Shift+Enter for newlines needs one terminal tweak.'))
  check('the deferral row names /terminal-setup', terminal.includes('not now — /terminal-setup does it later'))

  console.log(failures === 0 ? '\nONBOARDING RENDER: ALL GREEN' : `\nONBOARDING RENDER: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}
