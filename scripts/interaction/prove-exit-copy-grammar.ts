#!/usr/bin/env bun


let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('== 1 · key-map identity: \\x03 and CSI-u decode to ONE ctrl+c ==')
{
  const { parseMultipleKeypresses, INITIAL_STATE } = await import(
    '../../src/screen/renderer/input/input-decoder.js'
  )
  const { InputEvent } = await import('../../src/screen/renderer/events/input-event.js')
  type KeyAtom = { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean }
  const decodeOne = (wire: string): KeyAtom | null => {
    const [atoms] = parseMultipleKeypresses({ ...INITIAL_STATE }, wire)
    const keys = (atoms as KeyAtom[]).filter(a => typeof a.name === 'string')
    return keys.length === 1 ? keys[0]! : null
  }
  const legacy = decodeOne(String.fromCharCode(3))
  const csiU = decodeOne(`${String.fromCharCode(27)}[99;5u`)
  check('the C0 byte decodes to exactly one key atom', legacy !== null, 'change parseMultipleKeypresses in src/screen/renderer/input/input-decoder.ts so byte 3 decodes to one named key')
  check('the kitty CSI-u form decodes to exactly one key atom', csiU !== null, 'change parseMultipleKeypresses in src/screen/renderer/input/input-decoder.ts so ESC [99;5u decodes to one named key')
  if (legacy && csiU) {
    check(
      "both wires land as {name:'c', ctrl, no shift}",
      legacy.name === 'c' && legacy.ctrl === true && !legacy.shift &&
        csiU.name === 'c' && csiU.ctrl === true && !csiU.shift,
      `legacy=${JSON.stringify(legacy)} csiU=${JSON.stringify(csiU)} — change parseMultipleKeypresses in src/screen/renderer/input/input-decoder.ts so both wires give name c with ctrl and no shift`,
    )
    const evLegacy = new InputEvent(legacy as never)
    const evCsiU = new InputEvent(csiU as never)
    check(
      "both project to key.ctrl && input==='c' (the raw guard's exact read)",
      evLegacy.key.ctrl && evLegacy.input === 'c' && !evLegacy.key.shift && !evLegacy.key.meta &&
        evCsiU.key.ctrl && evCsiU.input === 'c' && !evCsiU.key.shift && !evCsiU.key.meta,
      `legacy={input:${JSON.stringify(evLegacy.input)}} csiU={input:${JSON.stringify(evCsiU.input)}} — change InputEvent in src/screen/renderer/events/input-event.ts so both wires project to key.ctrl with input c`,
    )
  }
}

console.log('== 2 · resolution law: the ctrl+c/ctrl+d rows ==')
{
  const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.js')
  const block = (ctx: string): Record<string, string> => {
    const rows: Record<string, string> = {}
    for (const b of DEFAULT_BINDINGS) {
      if (b.context !== ctx) continue
      Object.assign(rows, b.bindings)
    }
    return rows
  }
  const global = block('Global')
  check("Global ctrl+c → app:interrupt (platform-invariant row)", global['ctrl+c'] === 'app:interrupt', 'restore the Global ctrl+c row to app:interrupt in src/screen/keys/defaultBindings.ts')
  check("Global ctrl+d → app:exit (platform-invariant row)", global['ctrl+d'] === 'app:exit', 'restore the Global ctrl+d row to app:exit in src/screen/keys/defaultBindings.ts')
  check(
    'the Scroll context holds NO ctrl+c row — plain-ctrl+c copy is the raw chord-exact guard, never an action row (an action row would either starve app:interrupt or leak the chord)',
    block('Scroll')['ctrl+c'] === undefined,
    'remove the ctrl+c row from the Scroll context in src/screen/keys/defaultBindings.ts',
  )
  check(
    "Scroll keeps its explicit copy chords (cmd+c is darwin's — declared unconditionally it won the end-first display walk everywhere and the Windows footer taught 'super+c', a chord no console there can deliver; TASK-017 supplement, SURVIVED)",
    block('Scroll')['ctrl+shift+c'] === 'selection:copy' &&
      (process.platform === 'darwin'
        ? block('Scroll')['cmd+c'] === 'selection:copy'
        : block('Scroll')['cmd+c'] === undefined),
    'restore the Scroll copy chords in src/screen/keys/defaultBindings.ts: ctrl+shift+c everywhere, cmd+c on darwin only',
  )
  check(
    "the Transcript pager keeps ctrl+c → transcript:exit (the named modal carve-out: drag-release copy-on-select serves copying there)",
    block('Transcript')['ctrl+c'] === 'transcript:exit',
    'restore the Transcript ctrl+c row to transcript:exit in src/screen/keys/defaultBindings.ts',
  )

  const { parseMultipleKeypresses, INITIAL_STATE } = await import(
    '../../src/screen/renderer/input/input-decoder.js'
  )
  const { InputEvent } = await import('../../src/screen/renderer/events/input-event.js')
  const { resolveKey } = await import('../../src/screen/keys/resolver.js')
  const { parseChord } = await import('../../src/screen/keys/parser.js')
  const [atoms] = parseMultipleKeypresses({ ...INITIAL_STATE }, String.fromCharCode(3))
  const ev = new InputEvent(atoms[0] as never)
  const parsed = DEFAULT_BINDINGS.flatMap(b =>
    Object.entries(b.bindings).map(([chord, action]) => ({
      context: b.context,
      chord: parseChord(chord),
      action,
    })),
  )
  const inGlobal = resolveKey(ev.input, ev.key, ['Global'], parsed as never)
  check(
    'decoded ctrl+c resolves to app:interrupt in the Global context',
    inGlobal.type === 'match' && (inGlobal as { action?: string }).action === 'app:interrupt',
    JSON.stringify(inGlobal) + ' — check the Global ctrl+c row in src/screen/keys/defaultBindings.ts and resolveKey in src/screen/keys/resolver.ts',
  )
  const inScroll = resolveKey(ev.input, ev.key, ['Scroll', 'Global'], parsed as never)
  check(
    'with Scroll active it STILL resolves app:interrupt (no shadow row)',
    inScroll.type === 'match' && (inScroll as { action?: string }).action === 'app:interrupt',
    JSON.stringify(inScroll) + ' — a Scroll row is shadowing ctrl+c; check the Scroll rows in src/screen/keys/defaultBindings.ts and resolveKey in src/screen/keys/resolver.ts',
  )
}

console.log('== 3 · the exit chord window: 3000 ms, Esc keeps 800 ms ==')
{
  const { DOUBLE_PRESS_TIMEOUT_MS, EXIT_CHORD_WINDOW_MS } = await import(
    '../../src/screen/keys/useDoublePress.js'
  )
  check('EXIT_CHORD_WINDOW_MS === 3000', EXIT_CHORD_WINDOW_MS === 3000, 'set EXIT_CHORD_WINDOW_MS to 3000 in src/screen/keys/useDoublePress.ts')
  check('DOUBLE_PRESS_TIMEOUT_MS === 800 (the Esc rhythm, unchanged)', DOUBLE_PRESS_TIMEOUT_MS === 800, 'set DOUBLE_PRESS_TIMEOUT_MS to 800 in src/screen/keys/useDoublePress.ts')

}




console.log('== 6 · the busy fall-through ==')
{
  const { openKeysPart } = await import('../ui/chatScenarios.ts')
  const keys = await openKeysPart('exit-copy-grammar-keys')
  check(
    'the scroll handler mounts before the cancel handler among the keys of the chat screen (listener order is mount order)',
    keys.mounted.includes('scroll') && keys.mounted.indexOf('scroll') < keys.mounted.indexOf('cancel'),
    keys.mounted.join(' ') + ' — the chat screen must mount the scroll key handler before the cancel handler; this is the mount order openKeysPart saw (scripts/ui/chatScenarios.ts)',
  )
  await keys.plant({ focusedInputDialog: 'cost-threshold' })
  const whileFocused = keys.handed.cancel?.isInputDialogFocused
  await keys.plant({ focusedInputDialog: undefined })
  check(
    'the chat screen feeds the dialog-focus truth into the handler: true while a dialog has the focus, false when none has',
    whileFocused === true && keys.handed.cancel?.isInputDialogFocused === false,
    `${String(whileFocused)} then ${String(keys.handed.cancel?.isInputDialogFocused)} — the chat screen must pass isInputDialogFocused to the cancel handler: true while a dialog is focused, false when none is`,
  )
  await keys.close()
}

console.log(failures === 0 ? '✅ exit-copy-grammar GREEN' : `❌ exit-copy-grammar RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
