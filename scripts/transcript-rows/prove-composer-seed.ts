#!/usr/bin/env bun
// ============================================================================
//  scripts/transcript-rows/prove-composer-seed.ts — COCKPIT S5: type-through
//  on the tool-permission card, proven on the SHIPPED artifact.
//
//  The law: while a consent card is up, a printable NON-DIGIT key seeds the
//  composer draft (the card yields via the existing isPromptInputActive
//  suppression) and NEVER decides the ask; digits stay Select hotkeys and
//  DO decide it. The suppression lapse (PROMPT_SUPPRESSION_MS) brings the
//  undecided card back — type-through defers, never answers.
//
//  Three layers: (1) the pure seed predicate (isSeedableInput) — digits,
//  chords, control bytes, whitespace all refused; (2) source pins on the
//  three wiring points (REPL seeder · PermissionRequest arm · the
//  use-select-input fall-through); (3) two hermetic artifactArena scenes on
//  dist/mercury.mjs — TYPE-THROUGH (seed hides the card, draft lands, card
//  returns undecided) and DIGIT (the '1' hotkey approves: the Write lands
//  on disk).
// ============================================================================

import { existsSync, readFileSync } from 'node:fs'
import { vshotBudgetScale } from '../lib/captureDriver.ts'
import { join } from 'node:path'
import {
  type ArenaRun,
  firstOutputTs,
  grabScreens,
  runArtifactArena,
} from '../streaming/artifactArena.ts'

/** Epoch ts of the send whose payload contains `needle` (ptydrive sendLog). */
const sendTs = (run: ArenaRun, needle: string): number[] =>
  run.sendLog
    .filter(s => Buffer.from(s.b64, 'base64').toString('utf8').includes(needle))
    .map(s => s.sent)
import {
  __composerSeedResetForTest,
  armComposerSeed,
  isSeedableInput,
  registerComposerSeeder,
  trySeedComposer,
} from '../../src/utils/cockpit/composerSeed.ts'
import type { Key } from '../../src/ink.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

console.log('── composer type-through (shipped artifact) ──')

// ── layer 1: the pure predicate ─────────────────────────────────────────────
{
  const key = (over: Partial<Key> = {}): Key =>
    ({
      upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
      pageDown: false, pageUp: false, wheelUp: false, wheelDown: false,
      home: false, end: false, return: false, escape: false, ctrl: false,
      shift: false, fn: false, tab: false, backspace: false, delete: false,
      meta: false, super: false,
      ...over,
    }) as Key
  check('letter seeds', isSeedableInput('w', key()))
  check('CJK seeds', isSeedableInput('好', key()))
  check('paste chunk seeds', isSeedableInput('fix the test first', key()))
  check('digit refused (Select hotkey)', !isSeedableInput('1', key()))
  check('multi-digit refused', !isSeedableInput('12', key()))
  check('space refused (would not flip suppression)', !isSeedableInput(' ', key()))
  check('empty refused', !isSeedableInput('', key()))
  check('ctrl chord refused', !isSeedableInput('c', key({ ctrl: true })))
  check('escape refused', !isSeedableInput('', key({ escape: true })))
  check('return refused', !isSeedableInput('', key({ return: true })))
  check('tab refused', !isSeedableInput('', key({ tab: true })))
  check('control byte refused', !isSeedableInput('\x1b[A', key()))

  __composerSeedResetForTest()
  const seeds: string[] = []
  check('unarmed: no seed', !trySeedComposer('w', key()))
  const unregister = registerComposerSeeder(s => seeds.push(s))
  check('registered but unarmed: no seed', !trySeedComposer('w', key()))
  const disarm = armComposerSeed()
  check('armed + registered: seeds', trySeedComposer('w', key()) && seeds.join('') === 'w')
  check('armed: digit still refused', !trySeedComposer('1', key()))
  disarm()
  disarm() // idempotent (StrictMode double-invoke)
  check('disarmed: no seed', !trySeedComposer('x', key()))
  const disarmA = armComposerSeed()
  armComposerSeed() // a second queued card overlaps
  disarmA()
  check('counted arm: still armed while one card remains', trySeedComposer('y', key()))
  unregister()
  check('unregistered: no seed', !trySeedComposer('z', key()))
  __composerSeedResetForTest()
}

// ── layer 2: wiring pins ────────────────────────────────────────────────────
{
  const repl = readFileSync('src/screens/REPL.tsx', 'utf8')
  const perm = readFileSync('src/components/permissions/PermissionRequest.tsx', 'utf8')
  const select = readFileSync('src/components/CustomSelect/use-select-input.ts', 'utf8')
  check(
    'REPL registers the seeder through the owner chokepoint (T13 S2: append = edit(text + seed))',
    /registerComposerSeeder\(seed => pendingInput\.append\(seed\)\)/.test(repl) &&
      readFileSync('src/input-core/pending-input.ts', 'utf8').includes('edit(draft.text + seed)'),
  )
  check(
    'PermissionRequest arms the seam while mounted (question cards EXEMPT — an open question is modal focus; its options carry ordinal hotkeys and must never yield to the composer)',
    /if \(isQuestionCard\) return undefined/.test(perm) &&
      /return armComposerSeed\(\)/.test(perm) &&
      /toolUseConfirm\.tool === AskUserQuestionTool/.test(perm),
  )
  check(
    'use-select-input falls through to trySeedComposer',
    /trySeedComposer\(input, key\)/.test(select),
  )
  // Re-cut at the ordinal-hotkey fold: digits ride the shared
  // ordinal-activation body now (full-width normalized, /^\d+$/) — same
  // ordering law: the seed fall-through sits AFTER the digit branch.
  check(
    'the fall-through sits AFTER the numeric hotkey branch',
    select.indexOf('/^\\d+$/.test(digits)') !== -1 && select.indexOf('/^\\d+$/.test(digits)') < select.indexOf('trySeedComposer(input, key)'),
  )
}

// ── layer 3a: TYPE-THROUGH scene ────────────────────────────────────────────
{
  const run = await runArtifactArena({
    turns: cwd => [
      {
        kind: 'tool_use',
        preText: 'Writing a file.\n',
        name: 'Write',
        input: { file_path: join(cwd, 'seed-through.txt'), content: 'never-written\n' },
      },
      { kind: 'text', text: 'Done.' },
    ],
    // Seeds shifted late: the consent card needs
    // boot+turn+tool time and a loaded runner wasn't painted by 8s — the
    // fixed-instant seed fired pre-card and every dwell law cascaded. All
    // grabs anchor to the ACTUAL send instants, so only the card's
    // time-to-paint margin changes.
    // The prompt rides observed-ready sends (the chat's composer is live
    // only after the Boot face's ↵ — a fixed instant raced the landing):
    // `hello` once the composer invites, ↵ once the echo shows; the seeds
    // keep their late fixed instants (the card needs boot + turn + tool).
    // The gap between 'w' and 'atch' sits inside the card's own suppression
    // window (a state criterion, not a schedule): the driver stretches every
    // fixed moment by the hosted scale, so the gap is handed over pre-divided
    // and lands authored (600 ms) on every host.
    sends: ['after:Type a prompt:300:hello', 'after:hello:400:\\r', '12000:w', `${12000 + 600 / vshotBudgetScale()}:atch`],
    seconds: 20,
    probe: true,
    keep: true,
  })
  const cardUp = (rows: string[]): boolean =>
    rows.some(r => /Do you want to (create|overwrite)/.test(r))
  // Anchor grabs to the ACTUAL send instants: grabScreens offsets are
  // relative to the first OUTPUT chunk while `sends` specs are relative to
  // PTY spawn — raw literals drift by the boot lag (the first run of this
  // prover flaked on exactly that skew).
  const base = firstOutputTs(run)
  const seedAt = (sendTs(run, 'w')[0] ?? 0) - base
  const lastKeyAt = (sendTs(run, 'atch')[0] ?? 0) - base
  const [t1, t2, t3] = grabScreens(run, 120, 40, [
    seedAt - 600,
    lastKeyAt + 800,
    // PROMPT_SUPPRESSION_MS (1500) after the last keystroke the ask
    // interrupts again; +3300 is comfortably past the re-show.
    lastKeyAt + 3300,
  ])
  check('card visible before any seed key', cardUp(t1!.rows))
  check('no draft before the seed', !t1!.rows.some(r => r.includes('watch')))
  check('seed key hides the card', !cardUp(t2!.rows))
  check('the draft reads watch', t2!.rows.some(r => r.includes('watch')))
  check(
    'the suppressed-ask hint shows',
    t2!.rows.some(r => r.includes('Waiting for permission')),
  )
  check(
    'suppression lapses ⇒ the UNDECIDED card returns',
    cardUp(t3!.rows),
    'card should re-show ~1500ms after the last keystroke',
  )
  check(
    'type-through never decided the ask (file never written)',
    !existsSync(join(run.paths.cwd, 'seed-through.txt')),
  )
  run.cleanup()
}

// ── layer 3b: DIGIT scene — hotkeys still answer the card ──────────────────
{
  const run = await runArtifactArena({
    turns: cwd => [
      {
        kind: 'tool_use',
        preText: 'Writing a file.\n',
        name: 'Write',
        input: { file_path: join(cwd, 'seed-digit.txt'), content: 'approved\n' },
      },
      { kind: 'text', text: 'Done.' },
    ],
    sends: ['after:Type a prompt:300:hello', 'after:hello:400:\\r', '12000:1'],  // same late-seed margin as the type-through scene
    seconds: 19,
    probe: true,
    keep: true,
  })
  const digitAt = (sendTs(run, '1')[0] ?? 0) - firstOutputTs(run)
  const [after] = grabScreens(run, 120, 40, [digitAt + 4000])
  check(
    "digit '1' approved: the Write landed on disk",
    existsSync(join(run.paths.cwd, 'seed-digit.txt')),
  )
  check('the follow-up turn settled (Done.)', after!.rows.some(r => r.includes('Done.')))
  check("digit never seeded a draft", !after!.rows.some(r => /❯\s*1\b/.test(r)))
  run.cleanup()
}

console.log(failures === 0 ? '✅ composer-seed GREEN' : `❌ composer-seed RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
