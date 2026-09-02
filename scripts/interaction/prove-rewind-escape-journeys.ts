#!/usr/bin/env bun
// ============================================================================
//  scripts/interaction/prove-rewind-escape-journeys.ts — LANE REWIND
// escape ALWAYS closes the rewind surface back to the chat.
//
//  THE INCIDENT: the rewind pick list's close handler listened for
//  'confirm:no' under the 'MessageSelector' context — a context whose binding
//  table carried NO escape row — while the composer unmounts and the cancel
//  handler stands down whenever the surface shows. Escape resolved to
//  nothing; double-esc SUMMONED an overlay escape could never close, and the
//  operator was stranded over their own transcript with no route home.
//
//  The law under proof: from EVERY rewind state — pick, confirm, the
//  restoring wait, the failure card — esc has a route back to the plain chat
//  with the composer focused, and a completed restore leaves no rewind
//  chrome behind.
//
//  PRODUCT legs (real binary, real PTY, the resume-2turn scenario; every
//  transition observed, never tick-guessed — the two-phase-paint law):
//   R1  esc-esc on the idle composer OPENS the rewind pick list (its footer
//       says 'esc close'); ONE esc CLOSES it back to the composer. This is
//       the incident's exact journey — on the broken build the surface
//       stays and the leg reds.
//   R2  pick → ↵ confirm → esc returns to pick (the one-level-up grammar)
//       → esc home. The stepwise route exists at every depth.
//   R3  the restore journey end-to-end: pick 'second task' → ↵ → 'Restore
//       conversation' ↵ → the conversation rewinds — transcript keeps
//       'first task', the composer stages 'second task' — and NO rewind
//       chrome survives the restore.
//
//  FIXTURE legs (the self-spawn idiom: the child mounts MessageSelector
//  under the REAL KeybindingSetup — the states a live PTY cannot freeze):
//   F1  restoring: a never-settling restore paints 'Restoring…'; esc still
//       closes (the always-armed messageSelector:close hatch).
//   F2  error: a rejecting restore paints the failure card; ONE esc closes.
// ============================================================================
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const SELF = fileURLToPath(import.meta.url)
const VSHOT = join(dirname(SELF), '../ui/vshot.py')
const ESC = String.fromCharCode(27)

if (process.env.REWESC_CHILD) {
  // ── child: MessageSelector under the real keybinding registry ──────────────
  process.env.NODE_ENV = 'test'
  ;(globalThis as Record<string, unknown>).MACRO = {
    VERSION: '1.0.0',
    ISSUES_EXPLAINER: '',
    PACKAGE_URL: '',
    README_URL: '',
    IS_DEV: false,
    IS_DEMO: false,
  }
  const React = await import('react')
  const h = React.createElement
  const ink = (await import('../../src/ink.js')) as unknown as {
    render: (n: React.ReactNode) => Promise<unknown>
    Box: React.ComponentType<Record<string, unknown>>
    Text: React.ComponentType<Record<string, unknown>>
    useInput: (handler: () => void) => void
  }
  const { AppStateProvider } = await import('../../src/state/AppState.js')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.js')
  const { MessageSelector } = await import('../../src/components/MessageSelector.js')

  const mode = process.env.REWESC_MODE === 'error' ? 'error' : 'restoring'
  const userMessage = (n: number, text: string) => ({
    type: 'user' as const,
    uuid: `00000000-0000-4000-8000-00000000000${n}`,
    timestamp: `2026-06-19T12:00:0${n}.000Z`,
    message: { role: 'user' as const, content: text },
  })
  const messages = [userMessage(1, 'alpha step'), userMessage(2, 'beta step')]

  function Fixture(): React.ReactNode {
    const [closed, setClosed] = React.useState(false)
    // A standing consumer keeps ink reading stdin in raw mode.
    ink.useInput(() => {})
    if (closed) return h(ink.Text, {}, 'SELECTOR-CLOSED')
    return h(MessageSelector as React.ComponentType<Record<string, unknown>>, {
      messages,
      onPreRestore: () => {},
      // 'restoring': the await never settles — the surface would hang on
      // 'Restoring…' forever without the hatch. 'error': the restore
      // rejects and the failure card paints. (The one restore door —
      // FN-015 rank 8: the session's runner performs it and answers a
      // typed receipt; a rejection here is the road itself failing.)
      onRestore:
        mode === 'error'
          ? () => Promise.reject(new Error('fixture boom'))
          : () => new Promise(() => {}),
      onSummarize: () => {},
      onClose: () => setClosed(true),
      // A wired timeline action forces the CONFIRM phase (the direct-restore
      // shortcut would skip the states under proof).
      onViewOnly: () => {},
    })
  }

  void ink.render(
    h(
      AppStateProvider as never,
      {},
      h(KeybindingSetup as never, {}, h(ink.Box, { flexDirection: 'column' }, h(Fixture))),
    ),
  )
  setTimeout(() => process.exit(0), 30_000)
} else {
  // ── parent: drive both halves through vshot ────────────────────────────────
  const { CONFIG_HOME, scenario, cleanupScenario } = await import('../ui/renderScenarios.ts')

  let failures = 0
  const check = (name: string, ok: boolean, detail = ''): void => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
    if (!ok) failures++
  }
  const section = (name: string): void => {
    console.log(`\n== ${name} ==`)
  }
  if (!existsSync(VSHOT)) {
    console.error('vshot.py missing — render-verify required')
    process.exit(1)
  }

  type Send = Record<string, unknown>
  type Mark = { label: string; atTick: number; grid: Array<Array<{ c: string }>> }
  type Payload = { grid: Array<Array<{ c: string }>>; endReason: string; marks?: Mark[] }
  const rowsOf = (grid: Array<Array<{ c: string }>>): string[] =>
    grid.map(r => r.map(c => c.c).join(''))
  const textOf = (grid: Array<Array<{ c: string }>>): string => rowsOf(grid).join('\n')
  const mark = (p: Payload, label: string): Mark | undefined =>
    p.marks?.find(m => m.label === label)

  type ScenarioCfg = { sends: Send[]; total: number } & Record<string, unknown>

  /** Drive one PRODUCT journey on the resume-2turn scenario. */
  function driveProduct(
    tag: string,
    sends: Send[],
    total: number,
    readyText?: string,
  ): Payload | null {
    const base = scenario('resume-2turn', 100, 44) as unknown as ScenarioCfg
    const cfg = { ...base, sends, total } as Record<string, unknown>
    if (readyText !== undefined) cfg['readyText'] = readyText
    else delete cfg['readyText']
    delete cfg['stableTicks']
    const gridPath = `/tmp/rewesc-${tag}-${process.pid}.json`
    const cfgPath = `/tmp/rewesc-${tag}-cfg-${process.pid}.json`
    writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: gridPath }))
    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
      env: {
        ...process.env,
        MERCURY_FULLSCREEN: '1',
        // Frame-0 statics (the capture pin): whole-grid byte-stability is
        // this journey's settled-phase gate, so the alive-glyph grammar and
        // the critter gaze must hold still.
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_CRITTER_GAZE: '0',
        MERCURY_CONFIG_DIR: CONFIG_HOME,
      },
    })
    if (res.status !== 0) {
      check(`${tag}: PTY journey completed`, false, (res.stderr ?? '').slice(-300))
      return null
    }
    check(`${tag}: PTY journey completed`, true)
    return JSON.parse(readFileSync(gridPath, 'utf8')) as Payload
  }

  /** Drive one FIXTURE journey (the self-spawned MessageSelector child). */
  function driveFixture(tag: string, mode: 'restoring' | 'error', sends: Send[], total: number, readyText: string): Payload | null {
    const gridPath = `/tmp/rewesc-fx-${tag}-${process.pid}.json`
    const cfgPath = `/tmp/rewesc-fx-${tag}-cfg-${process.pid}.json`
    writeFileSync(
      cfgPath,
      JSON.stringify({ argv: [process.execPath, 'run', SELF], sends, total, readyText, cols: 90, rows: 30, out: gridPath }),
    )
    const res = spawnSync('/usr/bin/python3', [VSHOT, cfgPath], {
      encoding: 'utf8',
      timeout: vshotBudgetMs(120_000),
      env: {
        ...process.env,
        REWESC_CHILD: '1',
        REWESC_MODE: mode,
        MERCURY_LIVE_GLYPHS: '0',
        MERCURY_CONFIG_DIR: CONFIG_HOME,
      },
    })
    if (res.status !== 0) {
      check(`${tag}: fixture journey completed`, false, (res.stderr ?? '').slice(-300))
      return null
    }
    check(`${tag}: fixture journey completed`, true)
    return JSON.parse(readFileSync(gridPath, 'utf8')) as Payload
  }

  const UP = '\x1b[A'
  const PICK_TITLE = 'Rewind'
  // The pick frame's SETTLED-phase observable (two-phase-paint law): the
  // footer is the last line the list paints, so gating a send on it means
  // the whole surface — and its keybinding effects — are up. Gating on the
  // title caught torn transition frames on the first run (the title cell
  // lands first, over the still-painting composer chrome).
  const PICK_FOOTER = 'esc close'
  // Re-cut against the captured frame: the confirm card windows
  // its Select at 5 rows and the product offers 7 options, so 'Never mind'
  // (the last row) never paints. Option 1 is always on-frame and focused.
  const CONFIRM_MARKER = 'Restore conversation'
  // The confirm card's LAST line in this rig (no code restore ⇒ no trailing
  // hand-edit caveat): the settled-phase needle for confirm-gated sends. It
  // is the card's own code line for the conversation-only focus
  // (MessageSelector's codeLine — 'The files are unchanged.'), painted under
  // the focused option's description, after the Select: the last row the
  // card commits. The capitalised spelling is unique to that row — the
  // description's wrapped '…so the files are unchanged.' never carries it.
  const CONFIRM_SETTLED = 'The files are unchanged.'
  // Round-2 re-cut, from the captured torn frames: a text needle alone
  // cannot tell a NEW frame's row from a STALE row the repaint has not
  // reached yet — the fast boot ran the whole journey inside tick 11, the
  // old pick frame's footer lingered under the half-painted confirm card,
  // and two escs cascaded straight past the pick step. Every phase-gated
  // send now rides `requireAwait` (never deadline-fired blind — exit 4
  // refuses a journey that did not happen as written) + `awaitStableTicks`
  // (the grid must hold byte-identical after the needle paints, which a
  // torn mid-repaint frame never does).
  const SETTLE = { requireAwait: true, awaitStableTicks: 2 } as const

  section('R1 · esc-esc opens the rewind list; ONE esc closes it (the incident journey)')
  {
    const p = driveProduct(
      'open-close',
      [
        { atTick: 60, minTick: 8, awaitText: '❯', data: ESC },
        // Inside the 800 ms double-press window (~2 ticks ≈ 0.4 s).
        { afterPrevTicks: 2, data: ESC },
        // Gated on the pick footer — the frame's LAST line — held stable, so
        // the settled surface (and its registered handlers) is what the mark
        // snapshots.
        { ...SETTLE, awaitText: PICK_FOOTER, data: ESC, mark: 'open' },
      ],
      120,
      '❯', // the composer must come back
    )
    if (p) {
      const open = mark(p, 'open')
      check('the pick list was up when the closing esc fired', open !== undefined && textOf(open.grid).includes(PICK_TITLE))
      check("…and its footer promises 'esc close'", open !== undefined && textOf(open.grid).includes(PICK_FOOTER))
      const final = textOf(p.grid)
      check('esc CLOSED the rewind surface (no chrome left)', !final.includes(PICK_TITLE), 'Rewind still painted')
      check('…back to the chat with the composer up', final.includes('❯'))
      check('…and Mercury stayed open', p.endReason !== 'eof', `endReason=${p.endReason}`)
    }
    cleanupScenario('resume-2turn')
  }

  section('R2 · confirm: esc steps back to pick, esc again goes home')
  {
    const p = driveProduct(
      'confirm-unwind',
      [
        { atTick: 60, minTick: 8, awaitText: '❯', data: ESC },
        { afterPrevTicks: 2, data: ESC },
        { ...SETTLE, awaitText: PICK_FOOTER, data: UP },
        { afterPrevTicks: 1, data: '\r' },
        // The settled confirm card (its last line is the needle); esc = one
        // level up.
        { ...SETTLE, awaitText: CONFIRM_SETTLED, data: ESC, mark: 'confirm' },
        // Back on the settled pick list; esc = home.
        { ...SETTLE, awaitText: PICK_FOOTER, data: ESC, mark: 'pick-again' },
      ],
      160,
      '❯',
    )
    if (p) {
      const confirm = mark(p, 'confirm')
      check('the confirm phase painted before its esc', confirm !== undefined && textOf(confirm.grid).includes(CONFIRM_MARKER))
      const pick = mark(p, 'pick-again')
      check('esc from confirm returned to the pick list', pick !== undefined && textOf(pick.grid).includes(PICK_TITLE))
      const final = textOf(p.grid)
      check('the second esc went home (no rewind chrome)', !final.includes(PICK_TITLE) && final.includes('❯'))
    }
    cleanupScenario('resume-2turn')
  }

  section('R3 · the restore journey: conversation rewinds, nothing strands')
  {
    const p = driveProduct(
      'restore',
      [
        { atTick: 60, minTick: 8, awaitText: '❯', data: ESC },
        { afterPrevTicks: 2, data: ESC },
        // Up moves off '(current prompt)' onto 'second task'.
        { ...SETTLE, awaitText: PICK_FOOTER, data: UP },
        { afterPrevTicks: 1, data: '\r' },
        // 'Restore conversation' holds the default focus — ↵ on the settled
        // card runs it.
        { ...SETTLE, awaitText: CONFIRM_SETTLED, data: '\r', mark: 'confirm' },
      ],
      160,
      '❯',
    )
    if (p) {
      const final = textOf(p.grid)
      check('the restore CLOSED the rewind surface (no stale chrome)', !final.includes(PICK_TITLE), 'Rewind still painted')
      check('the transcript kept the earlier turn', final.includes('first task'))
      const composerRow = rowsOf(p.grid).find(l => l.includes('❯') && l.includes('second task'))
      check('the rewound prompt is STAGED in the composer', composerRow !== undefined)
      check('Mercury stayed open', p.endReason !== 'eof', `endReason=${p.endReason}`)
    }
    cleanupScenario('resume-2turn')
  }

  section('F1 · restoring: a never-settling restore cannot strand — esc closes')
  {
    const p = driveFixture(
      'restoring',
      'restoring',
      [
        { ...SETTLE, awaitText: PICK_FOOTER, data: UP },
        { afterPrevTicks: 1, data: '\r' },
        { ...SETTLE, awaitText: CONFIRM_SETTLED, data: '\r' },
        // The frozen restoring wait — the state no live PTY can hold still.
        { ...SETTLE, awaitText: 'Restoring', data: ESC, mark: 'restoring' },
      ],
      90,
      'SELECTOR-CLOSED',
    )
    if (p) {
      const restoring = mark(p, 'restoring')
      check("the 'Restoring…' wait was painted when esc fired", restoring !== undefined && textOf(restoring.grid).includes('Restoring'))
      check('…and the wait names its own escape route', restoring !== undefined && textOf(restoring.grid).includes('esc returns to the chat'))
      check('esc closed the surface from the restoring wait', textOf(p.grid).includes('SELECTOR-CLOSED'))
    }
  }

  section('F2 · error: the failure card closes on ONE esc')
  {
    const p = driveFixture(
      'error',
      'error',
      [
        { ...SETTLE, awaitText: PICK_FOOTER, data: UP },
        { afterPrevTicks: 1, data: '\r' },
        { ...SETTLE, awaitText: CONFIRM_SETTLED, data: '\r' },
        { ...SETTLE, awaitText: 'Restore failed', data: ESC, mark: 'error' },
      ],
      90,
      'SELECTOR-CLOSED',
    )
    if (p) {
      const err = mark(p, 'error')
      check('the failure card was painted when esc fired', err !== undefined && textOf(err.grid).includes('Restore failed'))
      check('ONE esc closed the failure card', textOf(p.grid).includes('SELECTOR-CLOSED'))
    }
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(` ❌ prove-rewind-escape-journeys: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log(' ✅ rewind-escape-journeys — open/close · confirm unwind · restore · restoring-wait esc · failure-card esc (E2E)')
}
