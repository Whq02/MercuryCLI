#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const count = (hay: string, needle: string): number => hay.split(needle).length - 1

let failures = 0
const check = (name: string, ok: boolean, detail?: string): void => {
  if (ok) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 PD-1 — the confirm chord disarms while a feedback field owns focus')
{
  const { interpretKey } = await import('../../src/ink/input/interpreter.ts')
  const { matchesKeystroke } = await import('../../src/keybindings/match.ts')
  const { parseKeystroke } = await import('../../src/keybindings/parser.ts')
  const parsed = interpretKey('N')
  check("the decoder names a typed 'N' as shift+n (shift synthesised from case)", parsed.name === 'n' && parsed.shift === true)
  const key = { ctrl: false, meta: false, shift: true, super: false } as unknown as Parameters<typeof matchesKeystroke>[1]
  check("the matcher accepts that keystroke for the 'shift+n' binding — why the gate must exist", matchesKeystroke('N', key, parseKeystroke('shift+n')))
  const prompt = read('src/components/permissions/PermissionPrompt.tsx')
  check(
    "PermissionPrompt's option chords carry the same gate while a feedback field owns focus",
    /useKeybindings\(keybindingHandlers, \{ context: 'Confirmation', isActive: [^}]*!inputOwnsFocus \}\)/.test(prompt) &&
      prompt.includes("(focusedFeedbackType === 'accept' && acceptInputMode) ||") &&
      prompt.includes("(focusedFeedbackType === 'reject' && rejectInputMode)"),
  )
  check("the Select's own accept/next/previous stay gated on isInInput (the owner's precedent)", read('src/components/CustomSelect/use-select-input.ts').includes("{ context: 'Select', isActive: !isDisabled && !state.isInInput },"))
}

console.log('§2 PD-2 — the digit fence and the ordinal paint read one predicate')
{
  const select = read('src/components/CustomSelect/select.tsx')
  check('the one predicate exists (expanded layout ∨ hideIndexes)', select.includes("const ordinalsHidden = layout === 'expanded' || hideIndexes"))
  check("the digit fence reads it ('numeric' — Enter and scrolling stay live)", select.includes("disableSelection === false && ordinalsHidden ? 'numeric' : disableSelection"))
  check('the row paint reads the same predicate', select.includes("const prefix = ordinalsHidden ? '' : rowPrefix(option, option.index + 1, textRowReserved)"))
  check('POISON: the flag-only fence is gone', !select.includes("disableSelection === false && hideIndexes ? 'numeric' : disableSelection"))
  check("the owner's digit branch still honours 'numeric'", read('src/components/CustomSelect/use-select-input.ts').includes("disableSelection !== 'numeric'"))
  const tree = read('src/components/ui/TreeSelect.tsx')
  check('TreeSelect mounts the Select in the expanded layout by default', tree.includes("layout = 'expanded',") && tree.includes('layout={layout}'))
  check('the /resume picker always takes the tree branch (isCustomTitleEnabled is constant true)', /export function isCustomTitleEnabled\(\): boolean \{\s*\n\s*return true/.test(read('src/utils/sessionStorage/paths.ts')) && read('src/components/LogSelector.tsx').includes('const renaming = isCustomTitleEnabled()'))
}


console.log('§3 MGR-2 — a prompt handed isDisabled owns no key')
{
  const prompt = read('src/components/permissions/PermissionPrompt.tsx')
  check('PermissionPrompt takes isDisabled and hands it to its Select', prompt.includes('isDisabled?: boolean') && prompt.includes('isDisabled = false,') && prompt.includes('isDisabled={isDisabled}'))
  check('its option chords are gated on the same fact', prompt.includes("{ context: 'Confirmation', isActive: !isDisabled && !inputOwnsFocus }"))
  check("the Select's raw path honours isDisabled (why the fact settles every key)", read('src/components/CustomSelect/use-select-input.ts').includes('{ isActive: !isDisabled },'))
}

console.log('§4 PD-8 — cap-offer: one hint line, the dead enter never advertised')
{
  const card = read('src/components/CapOfferCard.tsx')
  check('the card rides the inputGuide seam (Dialog default guide replaced)', card.includes('inputGuide={() => ('))
  check("esc's spelling rides the resolver (the same one Dialog reads)", card.includes("useShortcutDisplay('confirm:no', 'Confirmation', 'esc')"))
  const guide = card.slice(card.indexOf('inputGuide={'), card.indexOf('    >', card.indexOf('inputGuide={')))
  const unusableArm = guide.slice(guide.indexOf(' : '))
  check('the guide was found with both arms', guide.includes('usable') && guide.includes(' : ') && unusableArm.length > 10, `guide ${guide.length}b`)
  check('the usable arm advertises enter; the unusable arm only esc', guide.includes('`enter opens the transition preview') && !/enter/.test(unusableArm))
  check('POISON: the body no longer paints its own second hint line', !card.includes('? `enter opens the transition preview ${GLYPH.dot} esc stays put`'))
}

console.log('§5 PD-9 — inline model picker: keys advertised')
{
  const picker = read('src/components/ModelPicker.tsx')
  check('POISON: the bare inline return (no guide) is gone', !/if \(!isStandaloneCommand\) return body/.test(picker))
  check("the inline guide prints '↑↓ move · pgup/pgdn page · ↵ confirm · esc close' under the press-again gate", picker.includes("'↑↓ move · pgup/pgdn page · ↵ confirm · esc close'") && /if \(!isStandaloneCommand\) \{[^]{0,600}exitState\.pending/.test(picker))
  check('the standalone keeps its own line (esc exit)', picker.includes("'↑↓ move · pgup/pgdn page · ↵ confirm · esc exit'"))
}

console.log('§6 PD-5 — the more-below count rides the painted window')
{
  const select = read('src/components/CustomSelect/select.tsx')
  check('the Select carries the render-state seam', select.includes('onVisibleWindowChange?: (visibleFromIndex: number, visibleToIndex: number) => void'))
  check('the effect keys on the window bounds themselves', /useEffect\(\(\) => \{\s*\n\s*onVisibleWindowChange\?\.\(visibleFromIndex, visibleToIndex\)\s*\n\s*\}, \[onVisibleWindowChange, visibleFromIndex, visibleToIndex\]\)/.test(select))
  const picker = read('src/components/ModelPicker.tsx')
  check('the picker derives the count from the reported window', picker.includes('onVisibleWindowChange={(_, to) => setVisibleTo(to)}') && picker.includes('Math.max(0, options.length - visibleTo)'))
  check('POISON: the fixed mount-time count is gone', !picker.includes('Math.max(0, options.length - VISIBLE_OPTIONS)'))
}

process.exit(failures === 0 ? 0 : 1)
