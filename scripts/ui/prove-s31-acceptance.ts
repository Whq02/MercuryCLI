#!/usr/bin/env bun

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
} from '../../src/screen/renderer/termio/csi.js'
import {
  parseOSC,
  parseOscColor,
  setClipboardWithReceipt,
  supportsTabStatus,
  wrapForMultiplexer,
} from '../../src/screen/renderer/termio/osc.js'
import { parseChord, parseKeystroke, parseBindings } from '../../src/screen/keys/parser.js'
import { matchesKeystroke } from '../../src/screen/keys/match.js'
import {
  resolveKey,
  resolveKeyWithChordState,
  unboundConsumes,
} from '../../src/screen/keys/resolver.js'
import {
  checkDuplicateKeysInJson,
  validateBindings,
  validateUserConfig,
} from '../../src/screen/keys/validate.js'
import {
  NON_REBINDABLE,
  normalizeKeyForComparison,
} from '../../src/screen/keys/reservedShortcuts.js'
import { DEFAULT_BINDINGS } from '../../src/screen/keys/defaultBindings.js'
import { generateKeybindingsTemplate } from '../../src/screen/keys/template.js'
import {
  disposeKeybindingWatcher,
  loadKeybindingsSyncWithWarnings,
} from '../../src/screen/keys/loadUserBindings.js'
import { runWithCwdOverride } from '../../src/platform/files/cwd.js'
import { setSessionTrustAccepted as trustTheProjects } from '../../src/boot/process-state/processState.js'
import type { Key } from '../../src/screen/renderer/events/input-event.js'

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}
const ESC = '\x1b'

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
  'change src/screen/renderer/termio/csi.ts so cursorUp, cursorDown, cursorForward, cursorBack, scrollUp, scrollDown and eraseLines return an empty string for a count of 0 and cursorUp(2) returns ESC[2A',
)

check(
  '2. cursorMove horizontal component first',
  cursorMove(3, 2) === `${cursorForward(3)}${cursorDown(2)}` &&
    cursorMove(-1, -4) === `${cursorBack(1)}${cursorUp(4)}` &&
    cursorMove(0, 1) === cursorDown(1) &&
    cursorMove(2, 0) === cursorForward(2),
  'change cursorMove in src/screen/renderer/termio/csi.ts so it emits the horizontal move (cursorForward or cursorBack) before the vertical one and skips a zero component',
)

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
    'change wrapForMultiplexer in src/screen/renderer/termio/osc.ts so a set TMUX wraps the sequence in ESC Ptmux; with every inner ESC doubled and ends with ESC backslash',
  )
  check('3. screen uses the bare DCS form', screenWrapped === `${ESC}P${seq}${ESC}\\`, 'change wrapForMultiplexer in src/screen/renderer/termio/osc.ts so a set STY wraps the sequence as ESC P, the sequence, ESC backslash')
  check('3. neither variable set returns the input unchanged', bare === seq, 'change wrapForMultiplexer in src/screen/renderer/termio/osc.ts so it returns the sequence untouched when neither TMUX nor STY is set')
}

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
    'change the 21337 tab-status branch of parseOSC in src/screen/renderer/termio/osc.ts so a bare key and key= give status null and key=value gives the value',
  )
  check('4. unknown keys are ignored', unknownKey.type === 'tabStatus' && !('bogus' in unknownKey.action), 'change the 21337 tab-status branch of parseOSC in src/screen/renderer/termio/osc.ts so keys it does not know are dropped from the action')
  check('4. \\; inside a value does not split the pair', escaped.action.status === 'a;b', 'change the 21337 tab-status branch of parseOSC in src/screen/renderer/termio/osc.ts so a backslash-semicolon inside a value is kept in the value and does not split the pair')
}

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
    'change parseOscColor in src/screen/renderer/termio/osc.ts so rgb:f/f/f and #ffffff both give r, g and b of 255',
  )
  check('5. rgb:0/0/0 parses to (0,0,0)', black !== null && black.r === 0 && black.g === 0 && black.b === 0, 'change parseOscColor in src/screen/renderer/termio/osc.ts so rgb:0/0/0 gives r, g and b of 0')
  check('5. unparseable spec yields null', parseOscColor('definitely-not-a-colour') === null, 'change parseOscColor in src/screen/renderer/termio/osc.ts so a spec it cannot parse returns null')
}

{
  const chord = parseChord(' ')
  check('6. parseChord(" ") is the space key, not empty', chord.length === 1 && chord[0]!.key === ' ', 'change parseChord in src/screen/keys/parser.ts so a lone space gives one keystroke whose key is a space, not an empty chord')
}

check(
  '7. escape binding matches despite the event meta flag',
  matchesKeystroke('', makeKey({ escape: true, meta: true }), parseKeystroke('escape')),
  'change matchesKeystroke in src/screen/keys/match.ts so the escape binding matches an escape event even when the meta flag is set',
)

{
  const event = makeKey({ meta: true })
  check(
    '8. alt+k and meta+k both match a meta-flagged k',
    matchesKeystroke('k', event, parseKeystroke('alt+k')) &&
      matchesKeystroke('k', event, parseKeystroke('meta+k')),
    'change matchesKeystroke in src/screen/keys/match.ts (or the alt and meta names in parseKeystroke in src/screen/keys/parser.ts) so alt+k and meta+k both match a meta-flagged k',
  )
  check('8. cmd+k does not match it', !matchesKeystroke('k', event, parseKeystroke('cmd+k')), 'change matchesKeystroke in src/screen/keys/match.ts so cmd+k does not match an event that carries only the meta flag')
}

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
    `change resolveKeyWithChordState in src/screen/keys/resolver.ts so a chord unbound with a null action no longer arms its prefix and the prefix resolves to its single-key binding (got ${resolved.type})`,
  )
  const control = resolveKeyWithChordState(
    'x',
    makeKey({ ctrl: true }),
    ['Global'],
    withUnbind.slice(0, 2),
    null,
  )
  check('9. control: without the unbind the prefix arms the chord', control.type === 'chord_started', `change resolveKeyWithChordState in src/screen/keys/resolver.ts so a key that prefixes a longer bound chord returns chord_started (got ${control.type})`)
}

{
  const midChord = resolveKeyWithChordState('q', makeKey(), ['Global'], [], [parseKeystroke('ctrl+x')])
  check(
    '10. mid-chord unmatched printable cancels (interceptor consumes the cancel)',
    midChord.type === 'chord_cancelled',
    `change resolveKeyWithChordState in src/screen/keys/resolver.ts so a printable key that matches nothing mid-chord returns chord_cancelled (got ${midChord.type})`,
  )
  const unbound = resolveKey('q', makeKey(), ['Chat'], [
    { chord: parseChord('q'), action: null, context: 'Chat' },
  ])
  check(
    '10. no chord pending: a null-unbound printable reaches the editor',
    unbound.type === 'unbound' && unboundConsumes('q', makeKey()) === false,
    `change resolveKey or unboundConsumes in src/screen/keys/resolver.ts so a null-unbound printable returns unbound and is not consumed (got ${unbound.type})`,
  )
  check(
    '10. modifier and named keys stay consumed when unbound',
    unboundConsumes('c', makeKey({ ctrl: true })) === true && unboundConsumes('', makeKey({ home: true })) === true,
    'change unboundConsumes in src/screen/keys/resolver.ts so a key with a modifier or a named key stays consumed when it is unbound',
  )
}

{
  const triple =
    '{"bindings":[{"context":"Chat","bindings":{"ctrl+j":"a","ctrl+j":"b","ctrl+j":"c"}}]}'
  const twoContexts =
    '{"bindings":[{"context":"Chat","bindings":{"ctrl+j":"a"}},{"context":"Global","bindings":{"ctrl+j":"b"}}]}'
  check(
    '11. a key three times in one block reports exactly once',
    checkDuplicateKeysInJson(triple).length === 1,
    `change checkDuplicateKeysInJson in src/screen/keys/validate.ts so a key repeated three times in one block is reported once (got ${checkDuplicateKeysInJson(triple).length})`,
  )
  check(
    '11. the same key in two contexts reports nothing',
    checkDuplicateKeysInJson(twoContexts).length === 0,
    `change checkDuplicateKeysInJson in src/screen/keys/validate.ts so duplicates are tracked per block and the same key in two contexts reports nothing (got ${checkDuplicateKeysInJson(twoContexts).length})`,
  )
}

{
  const blocks = [{ context: 'Settings', bindings: { 'ctrl+j': 'command:model' } }]
  const warnings = validateUserConfig(blocks)
  check(
    '12. non-Chat command binding warns without erroring',
    warnings.length === 1 && warnings[0]!.severity === 'warning',
    `change validateUserConfig in src/screen/keys/validate.ts so a command binding outside Chat and Global gives exactly one warning-severity entry (got ${JSON.stringify(warnings.map(w => w.severity))})`,
  )
  check('12. the config still loads', parseBindings(blocks).length === 1, 'change parseBindings in src/screen/keys/parser.ts so a block that validateUserConfig warns about still loads its binding')
  check(
    '12. a Global command binding is the shipped shape (the chat handler resolves Global) and raises nothing',
    validateUserConfig([{ context: 'Global', bindings: { 'ctrl+j': 'command:model' } }]).length === 0,
    'change validateUserConfig in src/screen/keys/validate.ts so a command binding in the Global context raises no warning',
  )
}

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
    writeFileSync(userFile, '{ this is not json')
    let thrown = false
    let result13: ReturnType<typeof loadKeybindingsSyncWithWarnings> | null = null
    try {
      result13 = runWithCwdOverride(plain, () => loadKeybindingsSyncWithWarnings())
    } catch {
      thrown = true
    }
    check('13. invalid user JSON does not throw on the sync (first-render) path', !thrown, 'change loadKeybindingsSyncWithWarnings in src/screen/keys/loadUserBindings.ts so it catches a JSON parse failure and returns the defaults with a parse_error warning')
    check(
      '13. it degrades to defaults plus exactly one parse-error warning',
      result13 !== null &&
        result13.bindings.length === defaultCount &&
        result13.warnings.filter(w => w.type === 'parse_error').length === 1,
      result13 ? `bindings ${result13.bindings.length}/${defaultCount}, warnings ${JSON.stringify(result13.warnings.map(w => w.type))}; change loadKeybindingsSyncWithWarnings in src/screen/keys/loadUserBindings.ts to return defaults plus exactly one parse_error warning` : 'load threw; change loadKeybindingsSyncWithWarnings in src/screen/keys/loadUserBindings.ts to catch the parse failure',
    )

    writeFileSync(userFile, '{"bindings":{"context":"Chat"}}')
    const result32 = runWithCwdOverride(plain2, () => loadKeybindingsSyncWithWarnings())
    check(
      '32. bindings-not-an-array degrades to absent with one parse-error warning',
      result32.bindings.length === defaultCount &&
        result32.warnings.filter(w => w.type === 'parse_error').length === 1,
      `bindings ${result32.bindings.length}/${defaultCount}, warnings ${JSON.stringify(result32.warnings.map(w => w.type))}; change loadKeybindingsSyncWithWarnings in src/screen/keys/loadUserBindings.ts so a bindings value that is not an array is treated as absent with one parse_error warning`,
    )

    writeFileSync(userFile, '{"bindings":[]}')
    trustTheProjects(true)
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
      JSON.stringify({ a: actionsA.filter(x => String(x).startsWith('project')), b: actionsB.filter(x => String(x).startsWith('project')) }) + '; change loadKeybindingsSyncWithWarnings in src/screen/keys/loadUserBindings.ts so each call reads the project layer of the current working directory and caches nothing across directories',
    )
  } finally {
    disposeKeybindingWatcher()
  }
}

{
  const template = generateKeybindingsTemplate()
  const nonRebindable = new Set(NON_REBINDABLE.map(entry => normalizeKeyForComparison(entry.key)))
  const parsed = JSON.parse(template) as { bindings: Array<{ context: string; bindings: Record<string, unknown> }> }
  const keys = parsed.bindings.flatMap(block => Object.keys(block.bindings))
  check(
    '15. template contains no non-rebindable chord',
    keys.length > 0 && keys.every(key => !nonRebindable.has(normalizeKeyForComparison(key))),
    'change generateKeybindingsTemplate in src/screen/keys/template.ts so it lists at least one key and none that NON_REBINDABLE in src/screen/keys/reservedShortcuts.ts names',
  )
  check('15. template has no $schema field', !template.includes('"$schema"'), 'change generateKeybindingsTemplate in src/screen/keys/template.ts so the output has no $schema field')
}


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
    JSON.stringify({ settled: receipt.settled, confirmation: receipt.confirmation }) + '; change setClipboardWithReceipt in src/screen/renderer/termio/osc.ts so an SSH session without a settled route returns settled [], a non-empty sequence, osc52Emitted true and an offer-worded confirmation that does not start with copied',
  )
}

{
  check('21/31. tab-status output is unsupported', supportsTabStatus() === false, 'change supportsTabStatus in src/screen/renderer/termio/osc.ts so it returns false')
}


{

  {
    const { openStatusPart } = await import('./chatScenarios.ts')
    const { IDLE_LIVE } = await import('../../src/engine/connector/seatLive.ts')
    const status = await openStatusPart('s31-stop-hooks', { keepHome: true })
    const hook = (state: 'running' | 'ran', count: number): never => ({ type: 'progress', data: { type: 'hook_progress', event: 'turn.answer', state, count } }) as never
    const suffixOf = async (messages: never[]): Promise<string> => {
      await status.plant({ seatLive: { ...IDLE_LIVE, inFlight: true, phase: 'responding' }, messages })
      return String(status.handed.spinner?.spinnerSuffix)
    }
    const single = await suffixOf([hook('running', 1)])
    const singleDone = await suffixOf([hook('running', 1), hook('ran', 1)])
    const severalAtStart = await suffixOf([hook('running', 3), hook('running', 3), hook('running', 3)])
    const severalAfterOne = await suffixOf([hook('running', 3), hook('running', 3), hook('running', 3), hook('ran', 3)])
    await status.close()
    check(
      '29. a single stop hook names its event, no counter',
      single === 'running answer hook' && singleDone === 'null',
      `${single} · ${singleDone}; change stopHookSuffix in src/screen/chat/useChatStatus.tsx so one running turn.answer hook gives running answer hook and a finished one gives no suffix`,
    )
    check(
      '29. several stop hooks use the generic plural line with completed/total',
      severalAtStart === 'running answer hooks · 0/3' && severalAfterOne === 'running answer hooks · 1/3',
      `${severalAtStart} · ${severalAfterOne}; change stopHookSuffix in src/screen/chat/useChatStatus.tsx so several turn.answer hooks give running answer hooks with the ran/total count`,
    )
  }
}

{
  const merged = parseBindings(DEFAULT_BINDINGS)
  const userBlocks = [{ context: 'Global', bindings: { 'ctrl+c': 'user.rebound' } }]
  const warnings = validateBindings(userBlocks, merged)
  const reserved = warnings.filter(w => w.type === 'reserved')
  check(
    "28. the user's ctrl+c re-bind reports reserved",
    reserved.length > 0 && reserved.every(w => (w.key ?? '').includes('ctrl+c')),
    JSON.stringify(reserved.map(w => w.key)) + '; change validateBindings in src/screen/keys/validate.ts so a user ctrl+c binding in Global is reported with type reserved',
  )
  check(
    '28. the merged default list is not walked (no ctrl+d / ctrl+m noise)',
    warnings.every(w => !(w.key ?? '').includes('ctrl+d') && !(w.key ?? '').includes('ctrl+m')),
    JSON.stringify(warnings.map(w => `${w.type}:${w.key}`)) + '; change validateBindings in src/screen/keys/validate.ts so it checks only the user blocks and does not walk the merged default list',
  )
}

console.log(`\nS31 acceptance: ${failures === 0 ? 'green' : `${failures} FAILURE(S)`}`)
if (existsSync(SCRATCH_HOME)) {
}
process.exit(failures === 0 ? 0 : 1)
