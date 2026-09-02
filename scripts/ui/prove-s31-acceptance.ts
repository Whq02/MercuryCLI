#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-s31-acceptance.ts — the S31 "acceptance checks
//  with no dedicated oracle", items 1–32, as one prover.
//
//  Method per check class:
//  · pure importable surfaces (termio, keybinding grammar, resolver,
//    validation, loader, template, clipboard receipt) are exercised
//    BEHAVIOURALLY in-process;
//  · hook and REPL-closure semantics (no in-process ink render harness
//    exists) are pinned STRUCTURALLY on the rewritten sources, the same
//    idiom the sibling provers use for closure-locked laws;
//  · check 17 landed with the S31b mini-parcel (use-declared-cursor.ts was
//    carved out of S31 for firewall reasons and rewritten there);
//  · checks 21 and 31 are SKIPPED by the drop-dead-machinery
//    ruling: the tab-status emission lane is not built (useTabStatus is a
//    no-op, supportsTabStatus() is false — both pinned live below).
// ============================================================================

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The user-layer config home is scratch for the whole run (the loader keys
// its memo on this spelling and re-resolves live).
const SCRATCH_HOME = mkdtempSync(join(tmpdir(), 's31-acceptance-home-'))
process.env.MERCURY_CONFIG_DIR = SCRATCH_HOME

import {
  cursorBack,
  cursorDown,
  cursorForward,
  cursorMove,
  cursorUp,
  eraseLines,
  scrollDown,
  scrollUp,
} from '../../src/ink/termio/csi.js'
import {
  parseOSC,
  parseOscColor,
  setClipboardWithReceipt,
  supportsTabStatus,
  wrapForMultiplexer,
} from '../../src/ink/termio/osc.js'
import { useTabStatus } from '../../src/ink/hooks/use-tab-status.js'
import { parseChord, parseKeystroke, parseBindings } from '../../src/keybindings/parser.js'
import { matchesKeystroke } from '../../src/keybindings/match.js'
import {
  resolveKey,
  resolveKeyWithChordState,
  unboundConsumes,
} from '../../src/keybindings/resolver.js'
import {
  checkDuplicateKeysInJson,
  validateBindings,
  validateUserConfig,
} from '../../src/keybindings/validate.js'
import {
  NON_REBINDABLE,
  normalizeKeyForComparison,
} from '../../src/keybindings/reservedShortcuts.js'
import { DEFAULT_BINDINGS } from '../../src/keybindings/defaultBindings.js'
import { generateKeybindingsTemplate } from '../../src/keybindings/template.js'
import {
  disposeKeybindingWatcher,
  loadKeybindingsSyncWithWarnings,
} from '../../src/keybindings/loadUserBindings.js'
import { runWithCwdOverride } from '../../src/utils/cwd.js'
import type { Key } from '../../src/ink/events/input-event.js'

let failures = 0
let skips = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
function skip(name: string, reason: string): void {
  console.log(`  ∅ ${name} — SKIPPED: ${reason}`)
  skips++
}

const ESC = '\x1b'
const src = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8')

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    wheelUp: false,
    wheelDown: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    fn: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    isPasted: false,
    ...overrides,
  }
}

console.log('── S31 §7 acceptance checks 1–32 ──')

// ── 1: zero-count cursor/scroll generators emit the empty string ────────────
check(
  '1. zero-count generators emit empty string',
  cursorUp(0) === '' &&
    cursorDown(0) === '' &&
    cursorForward(0) === '' &&
    cursorBack(0) === '' &&
    scrollUp(0) === '' &&
    scrollDown(0) === '' &&
    eraseLines(0) === '' &&
    cursorUp(2) === `${ESC}[2A`,
)

// ── 2: relative move emits horizontal before vertical ───────────────────────
check(
  '2. cursorMove horizontal component first',
  cursorMove(3, 2) === `${cursorForward(3)}${cursorDown(2)}` &&
    cursorMove(-1, -4) === `${cursorBack(1)}${cursorUp(4)}` &&
    cursorMove(0, 1) === cursorDown(1) &&
    cursorMove(2, 0) === cursorForward(2),
)

// ── 3: multiplexer wrapping ─────────────────────────────────────────────────
{
  const saved = { TMUX: process.env.TMUX, STY: process.env.STY }
  const seq = `${ESC}]52;c;Zm9v${'\x07'}`
  process.env.TMUX = '/tmp/tmux-1000/default,123,0'
  delete process.env.STY
  const tmuxWrapped = wrapForMultiplexer(seq)
  delete process.env.TMUX
  process.env.STY = '1234.pts-0.host'
  const screenWrapped = wrapForMultiplexer(seq)
  delete process.env.STY
  const bare = wrapForMultiplexer(seq)
  if (saved.TMUX !== undefined) process.env.TMUX = saved.TMUX
  if (saved.STY !== undefined) process.env.STY = saved.STY
  check(
    '3. tmux doubles every ESC inside the DCS envelope',
    tmuxWrapped === `${ESC}Ptmux;${seq.replaceAll(ESC, ESC + ESC)}${ESC}\\`,
  )
  check('3. screen uses the bare DCS form', screenWrapped === `${ESC}P${seq}${ESC}\\`)
  check('3. neither variable set returns the input unchanged', bare === seq)
}

// ── 4: tab-status payload grammar (the LIVE parsing side) ───────────────────
{
  const get = (payload: string) => parseOSC(`21337;${payload}`) as {
    type: string
    action: Record<string, unknown>
  }
  const bareKey = get('status')
  const emptyValue = get('status=')
  const setValue = get('status=busy')
  const unknownKey = get('bogus=zap')
  const escaped = get('status=a\\;b')
  check(
    '4. bare key and key= both clear; key=value sets',
    bareKey.type === 'tabStatus' &&
      bareKey.action.status === null &&
      emptyValue.action.status === null &&
      setValue.action.status === 'busy',
  )
  check('4. unknown keys are ignored', unknownKey.type === 'tabStatus' && !('bogus' in unknownKey.action))
  check('4. \\; inside a value does not split the pair', escaped.action.status === 'a;b')
}

// ── 5: colour parsing ───────────────────────────────────────────────────────
{
  const white1 = parseOscColor('rgb:f/f/f')
  const white2 = parseOscColor('#ffffff')
  const black = parseOscColor('rgb:0/0/0')
  check(
    '5. rgb:f/f/f and #ffffff parse to (255,255,255)',
    white1 !== null &&
      white1.r === 255 && white1.g === 255 && white1.b === 255 &&
      white2 !== null &&
      white2.r === 255 && white2.g === 255 && white2.b === 255,
  )
  check('5. rgb:0/0/0 parses to (0,0,0)', black !== null && black.r === 0 && black.g === 0 && black.b === 0)
  check('5. unparseable spec yields null', parseOscColor('definitely-not-a-colour') === null)
}

// ── 6: a chord string of exactly one space is the space key ─────────────────
{
  const chord = parseChord(' ')
  check('6. parseChord(" ") is the space key, not empty', chord.length === 1 && chord[0]!.key === ' ')
}

// ── 7: plain escape binding matches the meta-flagged escape event ───────────
check(
  '7. escape binding matches despite the event meta flag',
  matchesKeystroke('', makeKey({ escape: true, meta: true }), parseKeystroke('escape')),
)

// ── 8: alt+k and meta+k fire on the same event; cmd+k does not ──────────────
{
  const event = makeKey({ meta: true })
  check(
    '8. alt+k and meta+k both match a meta-flagged k',
    matchesKeystroke('k', event, parseKeystroke('alt+k')) &&
      matchesKeystroke('k', event, parseKeystroke('meta+k')),
  )
  check('8. cmd+k does not match it', !matchesKeystroke('k', event, parseKeystroke('cmd+k')))
}

// ── 9: null-unbinding a chord's full form frees its prefix ──────────────────
{
  const withUnbind = [
    { chord: parseChord('ctrl+x ctrl+s'), action: 'test.twoStep', context: 'Global' as const },
    { chord: parseChord('ctrl+x'), action: 'test.single', context: 'Global' as const },
    { chord: parseChord('ctrl+x ctrl+s'), action: null, context: 'Global' as const },
  ]
  const resolved = resolveKeyWithChordState('x', makeKey({ ctrl: true }), ['Global'], withUnbind, null)
  check(
    '9. unbound full chord: prefix resolves to its single-key action',
    resolved.type === 'match' && (resolved as { action: string }).action === 'test.single',
  )
  const control = resolveKeyWithChordState(
    'x',
    makeKey({ ctrl: true }),
    ['Global'],
    withUnbind.slice(0, 2),
    null,
  )
  check('9. control: without the unbind the prefix arms the chord', control.type === 'chord_started')
}

// ── 10: unbind consumption differs inside and outside a chord ───────────────
{
  const midChord = resolveKeyWithChordState('q', makeKey(), ['Global'], [], [parseKeystroke('ctrl+x')])
  check(
    '10. mid-chord unmatched printable cancels (interceptor consumes the cancel)',
    midChord.type === 'chord_cancelled',
  )
  const unbound = resolveKey('q', makeKey(), ['Chat'], [
    { chord: parseChord('q'), action: null, context: 'Chat' },
  ])
  check(
    '10. no chord pending: a null-unbound printable reaches the editor',
    unbound.type === 'unbound' && unboundConsumes('q', makeKey()) === false,
  )
  check(
    '10. modifier and named keys stay consumed when unbound',
    unboundConsumes('c', makeKey({ ctrl: true })) === true && unboundConsumes('', makeKey({ home: true })) === true,
  )
}

// ── 11: duplicate-key detection is once per block, never cross-context ──────
{
  const triple =
    '{"bindings":[{"context":"Chat","bindings":{"ctrl+j":"a","ctrl+j":"b","ctrl+j":"c"}}]}'
  const twoContexts =
    '{"bindings":[{"context":"Chat","bindings":{"ctrl+j":"a"}},{"context":"Global","bindings":{"ctrl+j":"b"}}]}'
  check(
    '11. a key three times in one block reports exactly once',
    checkDuplicateKeysInJson(triple).length === 1,
  )
  check(
    '11. the same key in two contexts reports nothing',
    checkDuplicateKeysInJson(twoContexts).length === 0,
  )
}

// ── 12: command binding outside Chat is a warning, not an error ─────────────
{
  const blocks = [{ context: 'Global', bindings: { 'ctrl+j': 'command:model' } }]
  const warnings = validateUserConfig(blocks)
  check(
    '12. non-Chat command binding warns without erroring',
    warnings.length === 1 && warnings[0]!.severity === 'warning',
  )
  check('12. the config still loads', parseBindings(blocks).length === 1)
}

// ── 13/14/32: the layered loader (scratch home + scratch projects) ──────────
{
  const projectA = mkdtempSync(join(tmpdir(), 's31-acceptance-projA-'))
  const projectB = mkdtempSync(join(tmpdir(), 's31-acceptance-projB-'))
  const plain = mkdtempSync(join(tmpdir(), 's31-acceptance-plain-'))
  const plain2 = mkdtempSync(join(tmpdir(), 's31-acceptance-plain2-'))
  mkdirSync(join(projectA, '.mercury'), { recursive: true })
  mkdirSync(join(projectB, '.mercury'), { recursive: true })
  writeFileSync(
    join(projectA, '.mercury', 'keybindings.json'),
    '{"bindings":[{"context":"Chat","bindings":{"ctrl+j":"projectA.action"}}]}',
  )
  writeFileSync(
    join(projectB, '.mercury', 'keybindings.json'),
    '{"bindings":[{"context":"Chat","bindings":{"ctrl+j":"projectB.action"}}]}',
  )
  const userFile = join(SCRATCH_HOME, 'keybindings.json')
  const defaultCount = parseBindings(DEFAULT_BINDINGS).length
  try {
    // The loader observes the PRODUCT's logical working directory (the
    // bootstrap cwd slot with an async-context override), not the OS cwd —
    // runWithCwdOverride is the product's own directory-change mechanism,
    // and the sync cache is keyed on exactly this value.
    // 13 — invalid JSON degrades to defaults plus one parse-error warning.
    writeFileSync(userFile, '{ this is not json')
    let thrown = false
    let result13: ReturnType<typeof loadKeybindingsSyncWithWarnings> | null = null
    try {
      result13 = runWithCwdOverride(plain, () => loadKeybindingsSyncWithWarnings())
    } catch {
      thrown = true
    }
    check('13. invalid user JSON does not throw on the sync (first-render) path', !thrown)
    check(
      '13. it degrades to defaults plus exactly one parse-error warning',
      result13 !== null &&
        result13.bindings.length === defaultCount &&
        result13.warnings.filter(w => w.type === 'parse_error').length === 1,
      result13 ? `bindings ${result13.bindings.length}/${defaultCount}, warnings ${JSON.stringify(result13.warnings.map(w => w.type))}` : 'load threw',
    )

    // 32 — valid JSON whose bindings is an object degrades identically.
    writeFileSync(userFile, '{"bindings":{"context":"Chat"}}')
    const result32 = runWithCwdOverride(plain2, () => loadKeybindingsSyncWithWarnings())
    check(
      '32. bindings-not-an-array degrades to absent with one parse-error warning',
      result32.bindings.length === defaultCount &&
        result32.warnings.filter(w => w.type === 'parse_error').length === 1,
      `bindings ${result32.bindings.length}/${defaultCount}, warnings ${JSON.stringify(result32.warnings.map(w => w.type))}`,
    )

    // 14 — the project layer follows the working directory without a restart.
    writeFileSync(userFile, '{"bindings":[]}')
    const inA = runWithCwdOverride(projectA, () => loadKeybindingsSyncWithWarnings())
    const inB = runWithCwdOverride(projectB, () => loadKeybindingsSyncWithWarnings())
    const actionsA = inA.bindings.map(b => b.action)
    const actionsB = inB.bindings.map(b => b.action)
    check(
      '14. the sync loader returns each project\'s own layer after the directory change',
      actionsA.includes('projectA.action') &&
        !actionsA.includes('projectB.action') &&
        actionsB.includes('projectB.action') &&
        !actionsB.includes('projectA.action'),
      JSON.stringify({ a: actionsA.filter(x => String(x).startsWith('project')), b: actionsB.filter(x => String(x).startsWith('project')) }),
    )
  } finally {
    disposeKeybindingWatcher()
  }
}

// ── 15: the generated template ──────────────────────────────────────────────
{
  const template = generateKeybindingsTemplate()
  const nonRebindable = new Set(NON_REBINDABLE.map(entry => normalizeKeyForComparison(entry.key)))
  const parsed = JSON.parse(template) as { bindings: Array<{ context: string; bindings: Record<string, unknown> }> }
  const keys = parsed.bindings.flatMap(block => Object.keys(block.bindings))
  check(
    '15. template contains no non-rebindable chord',
    keys.length > 0 && keys.every(key => !nonRebindable.has(normalizeKeyForComparison(key))),
  )
  check('15. template has no $schema field', !template.includes('"$schema"'))
}

// ── 16–19, 27: hook semantics (structural pins — no in-process ink render) ──
{
  const viewport = src('src/ink/hooks/use-terminal-viewport.ts')
  check(
    '16. viewport hook carries the one-extra-row overflow correction',
    viewport.includes('screenHeight - viewportHeight + 1'),
  )
  check(
    '16. viewport walk subtracts every scrolled ancestor\'s offset',
    viewport.includes('top -= scrollTop'),
  )

  // 17 — sibling-clear semantics. The protocol splits across the seam: the
  // hook ALWAYS hands the owner its own node with a clear, and the owner
  // (the renderer's setter) clears only when that node holds the
  // declaration — so an inactive instance re-rendering cannot wipe an
  // active sibling's declaration, while unmounting the owner does clear it.
  {
    const declared = src('src/ink/hooks/use-declared-cursor.ts')
    const firstEffect = declared.indexOf('useLayoutEffect(')
    const secondEffect = declared.indexOf('useLayoutEffect(', firstEffect + 1)
    const perCommit =
      firstEffect !== -1 && secondEffect !== -1 ? declared.slice(firstEffect, secondEffect) : ''
    check(
      '17. per-commit declaration effect: no dependency list, sets carry the owning node, clears carry identity',
      perCommit.includes('setDeclaration({ relativeX: column, relativeY: line, node })') &&
        perCommit.includes('setDeclaration(null, node)') &&
        !perCommit.includes('}, ['),
    )
    check(
      '17. unmount clear is a separate fire-once effect and still carries the identity node',
      secondEffect !== -1 &&
        declared.slice(secondEffect).includes('setDeclaration(null, nodeRef.current)') &&
        declared.slice(secondEffect).includes('}, [])'),
    )
    check(
      '17. no identity-less clear anywhere in the hook',
      !declared.includes('setDeclaration(null)'),
    )
  }

  const input = src('src/ink/hooks/use-input.ts')
  const layoutEffectIdx = input.indexOf('useLayoutEffect(')
  const rawModeIdx = input.indexOf('setRawMode(true)')
  const effectIdx = input.indexOf('useEffect(')
  check(
    '18. useInput arms raw mode in the layout phase of the mounting commit',
    layoutEffectIdx !== -1 && rawModeIdx > layoutEffectIdx && (effectIdx === -1 || rawModeIdx < effectIdx),
  )

  const frame = src('src/ink/hooks/use-animation-frame.ts')
  check(
    '19. animation-frame samples on absolute buckets (shared tick for same interval)',
    frame.includes('Math.floor(clock.now() / interval)') && frame.includes('Math.floor(now / interval)'),
  )
  check('19. animation-frame subscribes keep-alive', frame.includes('}, true)'))

  const interval = src('src/ink/hooks/use-interval.ts')
  check(
    '27. interval hook keeps a rolling per-subscriber anchor (own firing phase)',
    interval.includes('let anchor = clock.now()') &&
      interval.includes('anchor = now') &&
      !interval.includes('Math.floor('),
  )
  check('27. interval hook subscribes non-keep-alive', interval.includes('}, false)'))
}

// ── 20: clipboard receipt honesty with no settled route ─────────────────────
{
  const saved = { SSH: process.env.SSH_CONNECTION, TMUX: process.env.TMUX }
  process.env.SSH_CONNECTION = '203.0.113.5 51234 203.0.113.9 22'
  delete process.env.TMUX
  const receipt = await setClipboardWithReceipt('s31 acceptance copy')
  if (saved.SSH !== undefined) process.env.SSH_CONNECTION = saved.SSH
  else delete process.env.SSH_CONNECTION
  if (saved.TMUX !== undefined) process.env.TMUX = saved.TMUX
  check(
    '20. no settled route: settled [], offer-shaped confirmation, non-empty sequence',
    receipt.settled.length === 0 &&
      receipt.sequence.length > 0 &&
      receipt.osc52Emitted === true &&
      /offer/i.test(receipt.confirmation) &&
      !/^copied/.test(receipt.confirmation),
    JSON.stringify({ settled: receipt.settled, confirmation: receipt.confirmation }),
  )
}

// ── 21, 31: tab-status emission — NOT BUILT by ruling; gates pinned live ────
{
  check('21/31. the emission gate is closed (supportsTabStatus() === false)', supportsTabStatus() === false)
  check(
    '21/31. useTabStatus is the ruled no-op (no throw, no return)',
    useTabStatus('busy') === undefined && useTabStatus(null) === undefined,
  )
  skip(
    '21. set-then-null emits a clear; null-first emits nothing',
    'the OSC 21337 emission lane is not built (operator drop-dead-machinery ruling); no emission surface exists to test',
  )
  skip(
    '31. gate-closed kind is remembered so a later clear is correct',
    'same ruling — the remembered-kind machinery is part of the unbuilt emission lane',
  )
}

// ── 22, 30: terminal-title sanitisation and channel gating (pins) ───────────
{
  const title = src('src/ink/hooks/use-terminal-title.ts')
  check(
    '22. title strip covers C0 (BEL, ESC), DEL and C1 bytes',
    title.includes('\\x00-\\x1f') && title.includes('\\x7f-\\x9f'),
  )
  const stripIdx = title.indexOf('stripAnsi(title)')
  const replaceIdx = title.indexOf('.replace(CONTROL_BYTES_RE')
  const emitIdx = title.indexOf('write(osc(')
  check(
    '22. sanitisation (escape sequences, then control bytes) precedes emission',
    stripIdx !== -1 && replaceIdx > stripIdx && emitIdx > replaceIdx,
  )
  const guardIdx = title.indexOf('if (title === null || !write) return')
  const win32Idx = title.indexOf("process.platform === 'win32'")
  const processTitleIdx = title.indexOf('process.title = ')
  check(
    '30. both platform branches sit behind the raw-write channel guard',
    guardIdx !== -1 && win32Idx > guardIdx && processTitleIdx > win32Idx,
  )
}

// ── 23–26, 29: REPL closure laws (pins on the rewritten screen) ─────────────
{
  const repl = src('src/screens/REPL.tsx')
  // The screen holds no transcript writer: every session's runner records
  // its own transcript, and the face paints the focused chat's records
  // through its connector (a hopped view never reaches a writer because
  // there is none on the screen).
  check(
    '23. the screen holds no transcript writer (the session runner records; the face paints through the connector)',
    !repl.includes('useLogMessages') && repl.includes('const messages = useFocusedTranscript();'),
  )

  // A dialog command (local-jsx) renders in place: it never enters history
  // and never reaches the session's queue — the branch clears the composer
  // and mounts the dialog; the composer-taking path (history + clear) is
  // reserved for the session and screen seats.
  const dialogIdx = repl.indexOf("if (seatCommand !== undefined && seatCommand.type === 'local-jsx') {")
  const dialogBlock = repl.slice(dialogIdx, repl.indexOf('const onSubmitRef = useRef(onSubmit);', dialogIdx))
  check(
    '24. the dialog-command branch mounts in place — no history entry, no session send',
    dialogIdx !== -1 && !dialogBlock.includes('takeComposer()') && !dialogBlock.includes('addToHistory(') && !dialogBlock.includes('.sendWords('),
  )

  // esc reaches the focused session through its connector's interrupt
  // door; the session's runner settles its own pending asks when the turn
  // stops and the asks feed empties — the screen keeps no ask store.
  check(
    "25. cancel reaches the focused connector's interrupt door (no ask store on the screen)",
    repl.includes('getFocusedSessionConnector().interrupt()') && !repl.includes('getInProcessAsks'),
  )

  // The face runs no auto-restore: an interrupted turn keeps its words as a
  // sent row in the session; the composer-restore door for a managed
  // session is a named follow-up.
  check(
    '26. the face runs no auto-restore (no shouldAutoRestore, no history rewind)',
    !repl.includes('shouldAutoRestore(') && !repl.includes('removeLastFromHistory'),
  )
  // The composer-holds-text arm of check 26 lives inside the pending-input
  // owner (S27 seam) behind shouldAutoRestore; the REPL side passes the
  // other three gates — receipt-noted as a seam split.

  check(
    '29. a single stop hook names its event, no counter',
    repl.includes("latest.hookEvent === 'SubagentStop' ? 'running subagent stop hook' : 'running stop hook'"),
  )
  check(
    '29. several stop hooks use the generic plural line with completed/total',
    // The count rides the status line's ' · ' grammar (a UX sweep
    // — parens beside the row's own (…) HUD group jammed.
    repl.includes('running stop hooks · ${completed}/${total}'),
  )
}

// ── 28: combined validation walks the user entries, never the merged list ───
{
  const merged = parseBindings(DEFAULT_BINDINGS)
  const userBlocks = [{ context: 'Global', bindings: { 'ctrl+c': 'user.rebound' } }]
  const warnings = validateBindings(userBlocks, merged)
  const reserved = warnings.filter(w => w.type === 'reserved')
  check(
    "28. the user's ctrl+c re-bind reports reserved",
    reserved.length > 0 && reserved.every(w => (w.key ?? '').includes('ctrl+c')),
    JSON.stringify(reserved.map(w => w.key)),
  )
  check(
    '28. the merged default list is not walked (no ctrl+d / ctrl+m noise)',
    warnings.every(w => !(w.key ?? '').includes('ctrl+d') && !(w.key ?? '').includes('ctrl+m')),
    JSON.stringify(warnings.map(w => `${w.type}:${w.key}`)),
  )
  check(
    '28. validate.ts deliberately ignores its merged-bindings parameter',
    src('src/keybindings/validate.ts').includes('void parsedBindings'),
  )
}

console.log(`\nS31 acceptance: ${failures === 0 ? 'green' : `${failures} FAILURE(S)`} (${skips} named skip(s))`)
if (existsSync(SCRATCH_HOME)) {
  // Scratch dirs live under tmpdir; leave removal to the OS (matching the
  // sibling provers) so a red run keeps its evidence inspectable.
}
process.exit(failures === 0 ? 0 : 1)
