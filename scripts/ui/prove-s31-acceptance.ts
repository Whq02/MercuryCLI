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
} from '../../src/ink/termio/csi.js'
import {
  parseOSC,
  parseOscColor,
  setClipboardWithReceipt,
  supportsTabStatus,
  wrapForMultiplexer,
} from '../../src/ink/termio/osc.js'
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
import { setSessionTrustAccepted as trustTheProjects } from '../../src/bootstrap/state.js'
import type { Key } from '../../src/ink/events/input-event.js'

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
)

check(
  '2. cursorMove horizontal component first',
  cursorMove(3, 2) === `${cursorForward(3)}${cursorDown(2)}` &&
    cursorMove(-1, -4) === `${cursorBack(1)}${cursorUp(4)}` &&
    cursorMove(0, 1) === cursorDown(1) &&
    cursorMove(2, 0) === cursorForward(2),
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
  )
  check('3. screen uses the bare DCS form', screenWrapped === `${ESC}P${seq}${ESC}\\`)
  check('3. neither variable set returns the input unchanged', bare === seq)
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
  )
  check('4. unknown keys are ignored', unknownKey.type === 'tabStatus' && !('bogus' in unknownKey.action))
  check('4. \\; inside a value does not split the pair', escaped.action.status === 'a;b')
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
  )
  check('5. rgb:0/0/0 parses to (0,0,0)', black !== null && black.r === 0 && black.g === 0 && black.b === 0)
  check('5. unparseable spec yields null', parseOscColor('definitely-not-a-colour') === null)
}

{
  const chord = parseChord(' ')
  check('6. parseChord(" ") is the space key, not empty', chord.length === 1 && chord[0]!.key === ' ')
}

check(
  '7. escape binding matches despite the event meta flag',
  matchesKeystroke('', makeKey({ escape: true, meta: true }), parseKeystroke('escape')),
)

{
  const event = makeKey({ meta: true })
  check(
    '8. alt+k and meta+k both match a meta-flagged k',
    matchesKeystroke('k', event, parseKeystroke('alt+k')) &&
      matchesKeystroke('k', event, parseKeystroke('meta+k')),
  )
  check('8. cmd+k does not match it', !matchesKeystroke('k', event, parseKeystroke('cmd+k')))
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

{
  const blocks = [{ context: 'Settings', bindings: { 'ctrl+j': 'command:model' } }]
  const warnings = validateUserConfig(blocks)
  check(
    '12. non-Chat command binding warns without erroring',
    warnings.length === 1 && warnings[0]!.severity === 'warning',
  )
  check('12. the config still loads', parseBindings(blocks).length === 1)
  check(
    '12. a Global command binding is the shipped shape (the chat handler resolves Global) and raises nothing',
    validateUserConfig([{ context: 'Global', bindings: { 'ctrl+j': 'command:model' } }]).length === 0,
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
    check('13. invalid user JSON does not throw on the sync (first-render) path', !thrown)
    check(
      '13. it degrades to defaults plus exactly one parse-error warning',
      result13 !== null &&
        result13.bindings.length === defaultCount &&
        result13.warnings.filter(w => w.type === 'parse_error').length === 1,
      result13 ? `bindings ${result13.bindings.length}/${defaultCount}, warnings ${JSON.stringify(result13.warnings.map(w => w.type))}` : 'load threw',
    )

    writeFileSync(userFile, '{"bindings":{"context":"Chat"}}')
    const result32 = runWithCwdOverride(plain2, () => loadKeybindingsSyncWithWarnings())
    check(
      '32. bindings-not-an-array degrades to absent with one parse-error warning',
      result32.bindings.length === defaultCount &&
        result32.warnings.filter(w => w.type === 'parse_error').length === 1,
      `bindings ${result32.bindings.length}/${defaultCount}, warnings ${JSON.stringify(result32.warnings.map(w => w.type))}`,
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
      JSON.stringify({ a: actionsA.filter(x => String(x).startsWith('project')), b: actionsB.filter(x => String(x).startsWith('project')) }),
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
  )
  check('15. template has no $schema field', !template.includes('"$schema"'))
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
    JSON.stringify({ settled: receipt.settled, confirmation: receipt.confirmation }),
  )
}

{
  check('21/31. tab-status output is unsupported', supportsTabStatus() === false)
}


{

  {
    const { openStatusPart } = await import('./chatScenarios.ts')
    const { IDLE_LIVE } = await import('../../src/services/engine-connector/seatLive.ts')
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
      `${single} · ${singleDone}`,
    )
    check(
      '29. several stop hooks use the generic plural line with completed/total',
      severalAtStart === 'running answer hooks · 0/3' && severalAfterOne === 'running answer hooks · 1/3',
      `${severalAtStart} · ${severalAfterOne}`,
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
    JSON.stringify(reserved.map(w => w.key)),
  )
  check(
    '28. the merged default list is not walked (no ctrl+d / ctrl+m noise)',
    warnings.every(w => !(w.key ?? '').includes('ctrl+d') && !(w.key ?? '').includes('ctrl+m')),
    JSON.stringify(warnings.map(w => `${w.type}:${w.key}`)),
  )
}

console.log(`\nS31 acceptance: ${failures === 0 ? 'green' : `${failures} FAILURE(S)`}`)
if (existsSync(SCRATCH_HOME)) {
}
process.exit(failures === 0 ? 0 : 1)
