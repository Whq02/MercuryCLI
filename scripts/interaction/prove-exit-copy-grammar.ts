#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8')

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

console.log('== 1 · key-map identity: \\x03 and CSI-u decode to ONE ctrl+c ==')
{
  const { parseMultipleKeypresses, INITIAL_STATE } = await import(
    '../../src/ink/input/input-decoder.js'
  )
  const { InputEvent } = await import('../../src/ink/events/input-event.js')
  type KeyAtom = { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean }
  const decodeOne = (wire: string): KeyAtom | null => {
    const [atoms] = parseMultipleKeypresses({ ...INITIAL_STATE }, wire)
    const keys = (atoms as KeyAtom[]).filter(a => typeof a.name === 'string')
    return keys.length === 1 ? keys[0]! : null
  }
  const legacy = decodeOne(String.fromCharCode(3))
  const csiU = decodeOne(`${String.fromCharCode(27)}[99;5u`)
  check('the C0 byte decodes to exactly one key atom', legacy !== null)
  check('the kitty CSI-u form decodes to exactly one key atom', csiU !== null)
  if (legacy && csiU) {
    check(
      "both wires land as {name:'c', ctrl, no shift}",
      legacy.name === 'c' && legacy.ctrl === true && !legacy.shift &&
        csiU.name === 'c' && csiU.ctrl === true && !csiU.shift,
      `legacy=${JSON.stringify(legacy)} csiU=${JSON.stringify(csiU)}`,
    )
    const evLegacy = new InputEvent(legacy as never)
    const evCsiU = new InputEvent(csiU as never)
    check(
      "both project to key.ctrl && input==='c' (the raw guard's exact read)",
      evLegacy.key.ctrl && evLegacy.input === 'c' && !evLegacy.key.shift && !evLegacy.key.meta &&
        evCsiU.key.ctrl && evCsiU.input === 'c' && !evCsiU.key.shift && !evCsiU.key.meta,
      `legacy={input:${JSON.stringify(evLegacy.input)}} csiU={input:${JSON.stringify(evCsiU.input)}}`,
    )
  }
  for (const rel of [
    'src/ink/input/byte-decoder.ts',
    'src/ink/input/interpreter.ts',
    'src/ink/input/scanner.ts',
  ]) {
    const src = read(rel)
    check(
      `${rel} carries no platform branch`,
      !src.includes('process.platform') && !src.includes('getPlatform('),
    )
  }
  {
    const src = read('src/ink/input/input-decoder.ts')
    const sites = src.match(/process\.platform/g) ?? []
    check(
      'src/ink/input/input-decoder.ts: the ONE platform read is the burst-CR default arg (no second site, no fork in the key path)',
      sites.length === 1 && src.includes('platform: string = process.platform') && !src.includes('getPlatform('),
    )
  }
}

console.log('== 2 · resolution law: the ctrl+c/ctrl+d rows ==')
{
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.js')
  const block = (ctx: string): Record<string, string> => {
    const rows: Record<string, string> = {}
    for (const b of DEFAULT_BINDINGS) {
      if (b.context !== ctx) continue
      Object.assign(rows, b.bindings)
    }
    return rows
  }
  const global = block('Global')
  check("Global ctrl+c → app:interrupt (platform-invariant row)", global['ctrl+c'] === 'app:interrupt')
  check("Global ctrl+d → app:exit (platform-invariant row)", global['ctrl+d'] === 'app:exit')
  check(
    'the Scroll context holds NO ctrl+c row — plain-ctrl+c copy is the raw chord-exact guard, never an action row (an action row would either starve app:interrupt or leak the chord)',
    block('Scroll')['ctrl+c'] === undefined,
  )
  check(
    "Scroll keeps its explicit copy chords (cmd+c is darwin's — declared unconditionally it won the end-first display walk everywhere and the Windows footer taught 'super+c', a chord no console there can deliver; TASK-017 supplement, SURVIVED)",
    block('Scroll')['ctrl+shift+c'] === 'selection:copy' &&
      (process.platform === 'darwin'
        ? block('Scroll')['cmd+c'] === 'selection:copy'
        : block('Scroll')['cmd+c'] === undefined),
  )
  check(
    "the Transcript pager keeps ctrl+c → transcript:exit (the named modal carve-out: drag-release copy-on-select serves copying there)",
    block('Transcript')['ctrl+c'] === 'transcript:exit',
  )

  const { parseMultipleKeypresses, INITIAL_STATE } = await import(
    '../../src/ink/input/input-decoder.js'
  )
  const { InputEvent } = await import('../../src/ink/events/input-event.js')
  const { resolveKey } = await import('../../src/keybindings/resolver.js')
  const { parseChord } = await import('../../src/keybindings/parser.js')
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
    JSON.stringify(inGlobal),
  )
  const inScroll = resolveKey(ev.input, ev.key, ['Scroll', 'Global'], parsed as never)
  check(
    'with Scroll active it STILL resolves app:interrupt (no shadow row)',
    inScroll.type === 'match' && (inScroll as { action?: string }).action === 'app:interrupt',
    JSON.stringify(inScroll),
  )
}

console.log('== 3 · the exit chord window: 3000 ms, Esc keeps 800 ms ==')
{
  const { DOUBLE_PRESS_TIMEOUT_MS, EXIT_CHORD_WINDOW_MS } = await import(
    '../../src/hooks/useDoublePress.js'
  )
  check('EXIT_CHORD_WINDOW_MS === 3000', EXIT_CHORD_WINDOW_MS === 3000)
  check('DOUBLE_PRESS_TIMEOUT_MS === 800 (the Esc rhythm, unchanged)', DOUBLE_PRESS_TIMEOUT_MS === 800)

  const uti = read('src/hooks/useTextInput.ts')
  const ctrlC = uti.slice(uti.indexOf('const handleCtrlC'), uti.indexOf('const handleCtrlD'))
  const ctrlD = uti.slice(uti.indexOf('const handleCtrlD'), uti.indexOf('const handleEscape'))
  const esc = uti.slice(uti.indexOf('const handleEscape'), uti.indexOf('function upOrHistory'))
  check('composer ctrl+c chord rides EXIT_CHORD_WINDOW_MS', ctrlC.includes('EXIT_CHORD_WINDOW_MS'))
  check('composer ctrl+d chord rides EXIT_CHORD_WINDOW_MS', ctrlD.includes('EXIT_CHORD_WINDOW_MS'))
  check("Esc's double-tap does NOT (keeps the 800 ms default)", !esc.includes('EXIT_CHORD_WINDOW_MS'))

  const hook = read('src/hooks/useExitOnCtrlCD.ts')
  check(
    'useExitOnCtrlCD (dialog exit chords) rides EXIT_CHORD_WINDOW_MS on both chords',
    (hook.match(/EXIT_CHORD_WINDOW_MS/g) ?? []).length >= 3,
  )
}

console.log('== 4 · the severed exit loop stays closed ==')
{
  const pi = read('src/components/PromptInput/PromptInput.tsx')
  check('PromptInput no longer voids onExit', !pi.includes('void onExit'))
  const props = pi.slice(pi.indexOf('const textInputProps'), pi.indexOf('onHistoryUp:'))
  check('textInputProps carries onExit (double press CLOSES Mercury)', /\bonExit,/.test(props))
}

console.log('== 5 · one receipt · truthful footer ==')
{
  const skh = read('src/components/ScrollKeybindingHandler.tsx')
  check(
    'the receipt copy is "Copied to clipboard" (where-clause only off the native path)',
    skh.includes('`Copied to clipboard${where}`') && !skh.includes('characters} →'),
  )
  check(
    'the native receipt holds ~2 s; the mux/escape paths keep the longer read window',
    skh.includes("timeoutMs: path === 'native' ? 2000 : 4000"),
  )
  const guardAt = skh.indexOf("if (!key.ctrl || key.shift || key.meta || key.super) return")
  check('the plain-ctrl+c guard exists, chord-exact', guardAt !== -1 && skh.includes("if (input !== 'c') return"))
  check('…gated on a live selection', skh.slice(guardAt, guardAt + 400).includes('selection.hasSelection()'))
  check(
    '…consumes the press when it copies (stopImmediatePropagation)',
    skh.slice(guardAt, guardAt + 500).includes('event.stopImmediatePropagation()'),
  )
  const clearAt = skh.indexOf('key-driven selection clear')
  check('…and registers BEFORE the key-driven clear listener', guardAt !== -1 && clearAt !== -1 && guardAt < clearAt)
  const repl = read('src/screens/REPL.tsx')
  check(
    'ScrollKeybindingHandler mounts before CancelRequestHandler in the permanent JSX (listener order is mount order)',
    repl.indexOf('<ScrollKeybindingHandler') !== -1 &&
      repl.indexOf('<ScrollKeybindingHandler') < repl.indexOf('{cancelHandler}', repl.indexOf('<ScrollKeybindingHandler')),
  )

  const footer = read('src/components/PromptInput/PromptInputFooterLeftSide.tsx')
  const notice = read('src/components/PromptInput/ExitChordNotice.tsx')
  check(
    'the armed notice reads "press ctrl+c twice to close mercury" (ctrl+d variant beside it) at its ONE owner',
    notice.includes("press ${keyName === 'Ctrl-D' ? 'ctrl+d' : 'ctrl+c'} twice to close Mercury"),
  )
  check(
    'and the footer mounts that owner (the composer wears the same words)',
    footer.includes('<ExitChordNotice keyName={exitKeyName} />'),
  )
  check(
    'the busy resting hint names Esc — chat:cancel, not the ctrl+c spelling',
    footer.includes("useShortcutDisplay('chat:cancel', 'Chat', 'esc')") &&
      !footer.includes("useShortcutDisplay('app:interrupt'"),
  )
  const notif = read('src/components/PromptInput/Notifications.tsx')
  check(
    'the receipt slot stays bottom-right (the notifications column is right-aligned, transient row LAST)',
    notif.includes("alignItems={alignStart ? 'flex-start' : 'flex-end'}") && notif.includes('alignStart = false,'),
  )
}

console.log('== 4b · Mercury owns ctrl+c at the root (the S33 regression pin) ==')
{
  const main = read('src/main.tsx')
  check(
    'the interactive root boots with getRenderContext(false)',
    main.includes('getRenderContext(false)') && !main.includes('getRenderContext(true)'),
  )
}

console.log('== 6 · the busy fall-through ==')
{
  const cancel = read('src/hooks/useCancelRequest.ts')
  const at = cancel.indexOf("'app:interrupt'")
  const body = cancel.slice(at, at + 1600)
  check(
    'CancelRequestHandler declines consumption after cancelling (the same press arms the composer chord)',
    body.includes('return false'),
  )
  check(
    '…except while a focused input dialog owns its own settlement',
    body.includes('!isInputDialogFocused'),
  )
  const repl = read('src/screens/REPL.tsx')
  check(
    'REPL feeds the dialog-focus truth into the handler',
    repl.includes('isInputDialogFocused: focusedInputDialog !== undefined'),
  )
}

console.log(failures === 0 ? '✅ exit-copy-grammar GREEN' : `❌ exit-copy-grammar RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
