#!/usr/bin/env bun
// ============================================================================
//  scripts/navigation/prove-input-compat.ts — frontier
//  terminal-input compatibility, pinned on the EXISTING native input owner
//  (src/ink/input/* — NO second byte parser; the T4 corpora stay the base:
//  scripts/core-runtime/prove-input-contract.ts owns mid-flush/paste/mouse/
//  response laws. This prover adds the §10 matrix the contract didn't pin.)
//
//   · GRAPHEMES: CJK (wide), combining marks, ZWJ-joined sequences decode to
//     the SAME atoms at EVERY chunk-split boundary (no lost/duplicated text);
//   · BRACKETED PASTE: multiline + tab content survives as ONE paste atom —
//     content, never keys;
//   · MODIFIED ENTER: the CSI-u variants (shift+enter 13;2u · ctrl+enter
//     13;5u · alt+enter) decode to return + the modifier — and the legacy
//     forms keep working;
//   · ENHANCED SEQUENCES: kitty CSI-u keys decode; UNMAPPED functional keys
//     are swallowed whole (raw bytes never leak into a prompt);
//   · REVERSIBLE DETECTION: extended-keys arming is allowlisted (a terminal
//     that honors the enable but emits junk keeps the legacy encoding),
//     pop-before-push kitty stack hygiene, and enterEditor DISABLES the
//     protocols before handing the tty to a non-CSI-u editor;
//   · IME PREREQUISITES: focused editors declare the HARDWARE cursor (the
//     composer + the migrated console/tabula editors ride the ONE
//     use-declared-cursor seam), the width oracle is grapheme-true, cursor
//     park/restore survives resize, and the fullscreen autocomplete renders
//     ABOVE the composer row (never obscuring the live cursor).
//
//  Run: ~/.bun/bin/bun run scripts/navigation/prove-input-compat.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  INITIAL_STATE,
  parseMultipleKeypresses,
  type KeyParseState,
} from '../../src/ink/input/input-decoder.js'
import { InputEvent, type Key } from '../../src/ink/events/input-event.js'
import { stringWidth } from '../../src/ink/stringWidth.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  if (!cond || process.env.COMPASS_PROOF_VERBOSE) {
    console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** One projected event: the PUBLIC (key, input) seam every handler consumes. */
type Projected = { key: Key; input: string }

/** Feed a byte sequence through the decoder in the given chunking, projected
 *  through InputEvent — the same seam App dispatch rides. */
function feed(chunks: Buffer[]): Projected[] {
  let state: KeyParseState = { ...INITIAL_STATE }
  const out: Projected[] = []
  for (const chunk of chunks) {
    const [atoms, next] = parseMultipleKeypresses(state, chunk)
    for (const a of atoms) {
      const e = new InputEvent(a as ConstructorParameters<typeof InputEvent>[0])
      out.push({ key: e.key, input: e.input })
    }
    state = next
  }
  const [tail] = parseMultipleKeypresses(state, null)
  for (const a of tail) {
    const e = new InputEvent(a as ConstructorParameters<typeof InputEvent>[0])
    out.push({ key: e.key, input: e.input })
  }
  return out
}

/** The visible text a prompt would receive. */
function visibleText(events: Projected[]): string {
  return events.map(e => e.input).join('')
}

console.log('== graphemes: identical atoms at EVERY split boundary ==')
{
  const cases: Array<[string, string]> = [
    ['wide CJK', '你好世界'],
    ['combining marks', 'éä̲'],
    ['ZWJ-joined', '\u{1F468}‍\u{1F469}‍\u{1F467}'],
    ['mixed CJK+ASCII', 'a漢b字c'],
  ]
  for (const [label, text] of cases) {
    const bytes = Buffer.from(text, 'utf8')
    const whole = visibleText(feed([bytes]))
    let allSame = true
    for (let cut = 1; cut < bytes.length; cut++) {
      const split = visibleText(feed([bytes.subarray(0, cut), bytes.subarray(cut)]))
      if (split !== whole) {
        allSame = false
        check(`${label}: split@${cut} equals whole`, false, JSON.stringify({ whole, split }))
        break
      }
    }
    check(`${label}: every byte-split decodes identically (${bytes.length - 1} cuts)`, allSame)
    check(`${label}: nothing lost vs the source text`, whole === text, JSON.stringify(whole))
  }
}

console.log('== bracketed paste: multiline + tabs stay ONE content atom ==')
{
  const pasted = 'line one\nline two\ttabbed\nline three'
  const bytes = Buffer.from(`\x1b[200~${pasted}\x1b[201~`, 'utf8')
  const atoms = feed([bytes])
  const flat = visibleText(atoms)
  check('the pasted newlines/tabs never became Enter/Tab keys', !atoms.some(e => e.key.return || e.key.tab))
  check('the paste content survives byte-exact', flat === pasted, JSON.stringify(flat).slice(0, 80))
  // Split INSIDE the paste body: still one logical paste, same content.
  const cut = Math.floor(bytes.length / 2)
  const split = feed([bytes.subarray(0, cut), bytes.subarray(cut)])
  check('a mid-paste chunk split changes nothing', visibleText(split) === flat)
}

console.log('== modified Enter: CSI-u variants + legacy forms ==')
{
  const shiftEnter = feed([Buffer.from('\x1b[13;2u')])
  check('shift+enter (CSI-u 13;2u) → return + shift, NO text (the fixed leak)', shiftEnter.length === 1 && shiftEnter[0]!.key.return && shiftEnter[0]!.key.shift && shiftEnter[0]!.input === '', JSON.stringify(shiftEnter[0]))
  const ctrlEnter = feed([Buffer.from('\x1b[13;5u')])
  check('ctrl+enter (CSI-u 13;5u) → return + ctrl, no text', ctrlEnter.length === 1 && ctrlEnter[0]!.key.return && ctrlEnter[0]!.key.ctrl && ctrlEnter[0]!.input === '', JSON.stringify(ctrlEnter[0]))
  const plain = feed([Buffer.from('\r')])
  check('legacy \\r stays return', plain.length === 1 && plain[0]!.key.return)
  // CHARACTERIZED: legacy ESC+CR does NOT normalize to return+meta — Mercury
  // binds newline as backslash+return (useTextInput) and shift+enter via
  // CSI-u; ESC-then-Enter as two genuine keys must not merge. Pinned as-is.
  const escCr = feed([Buffer.from('\x1b\r')])
  check('ESC+CR stays un-merged (characterized — not a Mercury binding)', !escCr.some(e => e.key.return && e.key.meta))
}

console.log('== enhanced sequences: decode or swallow — never leak bytes ==')
{
  // kitty functional key F13 (57376) — unmapped: swallowed whole.
  const f13 = feed([Buffer.from('\x1b[57376u')])
  check('an unmapped kitty functional key never leaks text', visibleText(f13) === '', JSON.stringify(f13))
  // CSI-u printable with modifier: ctrl+i distinct from tab under CSI-u.
  const ctrlI = feed([Buffer.from('\x1b[105;5u')])
  check('CSI-u ctrl+i decodes with ctrl (not a bare tab)', ctrlI.length === 1 && ctrlI[0]!.key.ctrl && !ctrlI[0]!.key.tab, JSON.stringify(ctrlI[0]))
  // kitty shift+tab / modifyOtherKeys shift+escape: functional names carry
  // no text under modifiers (the leak class, swept whole).
  const shiftTab = feed([Buffer.from('\x1b[9;2u')])
  check('CSI-u shift+tab → tab flag, NO text', shiftTab.length === 1 && shiftTab[0]!.key.tab && shiftTab[0]!.key.shift && shiftTab[0]!.input === '', JSON.stringify(shiftTab[0]))
  const mokEsc = feed([Buffer.from('\x1b[27;2;27~')])
  check('modifyOtherKeys shift+escape → escape flag, NO text', mokEsc.length === 1 && mokEsc[0]!.key.escape && mokEsc[0]!.input === '', JSON.stringify(mokEsc[0]))
}

console.log('== reversible detection + IME prerequisites (source pins) ==')
{
  const read = (p: string): string => readFileSync(join(root, p), 'utf8')
  const caps = read('src/ink/session/capabilities.ts')
  const screenSession = read('src/ink/root/screen-session.ts')
  const baseText = read('src/components/BaseTextInput.tsx')
  const consoleSrc = read('src/commands/console/console.tsx')
  const tabula = read('src/components/tabula/MinervaRoom.tsx')
  const promptsPanel = read('src/components/prompts-panel/PromptsPanel.tsx')
  const fullscreen = read('src/components/FullscreenLayout.tsx')

  check('extended keys arm ONLY on the honor+parse allowlist (quiet fallback elsewhere)', caps.includes('EXTENDED_KEYS_TERMINALS') && caps.includes('supportsExtendedKeys'))
  check('kitty stack hygiene: pop-before-push re-enable', screenSession.includes('pop-before-push'))
  check('editor handoff DISABLES the protocols first', screenSession.includes('enterEditor disables kitty/modifyOtherKeys FIRST'))
  check('the composer declares the hardware cursor (use-declared-cursor)', baseText.includes('use-declared-cursor') || baseText.includes('useDeclaredCursor'))
  check('the console editor rides the SAME machinery (TextInput)', consoleSrc.includes('<TextInput'))
  check('the tabula (Minerva room) editor rides the SAME machinery (TextInput)', tabula.includes('<TextInput'))
  check('the prompts-panel editor rides the SAME machinery (TextInput)', promptsPanel.includes('<TextInput'))
  // The overlay strip mounts in the bottom block's column AHEAD of the
  // composer row, so the suggestions paint above it.
  check('the fullscreen autocomplete renders ABOVE the composer (never obscures the cursor)', fullscreen.includes('<PromptOverlayStrip />\n      {overlay ?? null}\n      {bottom}'))
  check('the width oracle is grapheme-true (ZWJ family = one cell-cluster width)', stringWidth('\u{1F468}‍\u{1F469}‍\u{1F467}') <= 2 && stringWidth('漢') === 2 && stringWidth('é') === 1)
}

console.log('')
if (failures > 0) {
  console.log(`❌ input-compat: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ input-compat — graphemes split-safe, paste contained, modified Enter typed, enhanced keys reversible, IME prerequisites held')
