#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '0.0.0-prover' }

import { ACTION_GRAPH } from '../../src/keybindings/actionGraph.ts'
import { DEFAULT_BINDINGS } from '../../src/keybindings/defaultBindings.ts'
import { parseBindings } from '../../src/keybindings/parser.ts'
import { getBindingDisplayText, resolveKey } from '../../src/keybindings/resolver.ts'
import type { Key } from '../../src/ink/events/input-event.ts'
import type { KeybindingContextName } from '../../src/keybindings/types.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

function keyOf(flag: keyof Key | null, ctrl = false): Key {
  const key: Key = {
    upArrow: false, downArrow: false, leftArrow: false, rightArrow: false,
    pageDown: false, pageUp: false, wheelUp: false, wheelDown: false,
    home: false, end: false, return: false, escape: false,
    ctrl, shift: false, fn: false, tab: false, backspace: false, delete: false,
    meta: false, super: false, isPasted: false,
  }
  if (flag !== null) (key as Record<keyof Key, boolean>)[flag] = true
  return key
}

const bindings = parseBindings(DEFAULT_BINDINGS)
function action(flag: keyof Key | null, input: string, contexts: KeybindingContextName[], ctrl = false): string {
  const result = resolveKey(input, keyOf(flag, ctrl), contexts, bindings)
  return result.type === 'match' ? result.action : result.type
}
const graph = ACTION_GRAPH as Record<string, { description: string; contexts: readonly string[] }>

console.log('============================================================')
console.log(' selection lists and the settings list: Home, End and the mouse wheel')
console.log('============================================================')

section('controls: the rows that stood before this pin still stand')
check('down in a Select list moves to the next row', action('downArrow', '', ['Select']) === 'select:next', action('downArrow', '', ['Select']))
check('the wheel in the Scroll context scrolls the transcript', action('wheelUp', '', ['Scroll']) === 'scroll:lineUp', action('wheelUp', '', ['Scroll']))
check('bare home in the Scroll context stays unbound', action('home', '', ['Scroll']) === 'none', action('home', '', ['Scroll']))
check('ctrl+home in the Scroll context jumps the transcript to the top', action('home', '', ['Scroll'], true) === 'scroll:top', action('home', '', ['Scroll'], true))

for (const context of ['Select', 'Settings'] as const) {
  section(`the ${context} context`)
  const home = action('home', '', [context])
  const end = action('end', '', [context])
  const up = action('wheelUp', '', [context])
  const down = action('wheelDown', '', [context])
  console.log(`  observed: home → ${home} · end → ${end} · wheelup → ${up} · wheeldown → ${down}`)
  check(`Home moves to the first row in ${context}`, home === 'select:first', `nothing is bound: the key does nothing (${home})`)
  check(`End moves to the last row in ${context}`, end === 'select:last', `nothing is bound: the key does nothing (${end})`)
  check(`the wheel up moves to the previous row in ${context}`, up === 'select:previous', `the wheel goes to the transcript beneath (${up})`)
  check(`the wheel down moves to the next row in ${context}`, down === 'select:next', `the wheel goes to the transcript beneath (${down})`)
  check(`the wheel is never the taught chord of the row moves in ${context} (the hint rows keep their words)`,
    getBindingDisplayText('select:previous', context, bindings) === 'ctrl+p' && getBindingDisplayText('select:next', context, bindings) === 'ctrl+n',
    `${getBindingDisplayText('select:previous', context, bindings)} · ${getBindingDisplayText('select:next', context, bindings)}`)
  check(`Home and End resolve from the ${context} block itself (not a borrowed context)`,
    bindings.some(b => b.context === context && b.action === 'select:first') && bindings.some(b => b.context === context && b.action === 'select:last'))
}

section('the action graph names the two edge moves for both list contexts')
for (const id of ['select:first', 'select:last']) {
  const meta = graph[id]
  check(`${id} exists in the graph`, meta !== undefined)
  check(`${id} declares the Select and Settings contexts`, (meta?.contexts ?? []).includes('Select') && (meta?.contexts ?? []).includes('Settings'), JSON.stringify(meta?.contexts))
  check(`${id} carries a description`, (meta?.description ?? '').trim().length >= 8, meta?.description)
}

section('the navigation reducer: first and last land on the enabled edges and move the window')
{
  const nav = await import('../../src/components/CustomSelect/use-select-navigation.ts')
  const reduce = (nav as Record<string, unknown>).reduceNavigation as
    | ((state: unknown, action: { type: string }) => { focusedValue: unknown; visibleFromIndex: number; visibleToIndex: number })
    | undefined
  const create = (nav as Record<string, unknown>).createNavigationState as
    | ((input: { options: Array<{ label: string; value: string; disabled?: boolean }>; visibleOptionCount?: number; initialFocusValue?: string }) => unknown)
    | undefined
  check('the reducer and its state constructor are readable by a proof', typeof reduce === 'function' && typeof create === 'function')
  if (reduce && create) {
    const options = Array.from({ length: 12 }, (_, i) => ({ label: `row ${i}`, value: `r${i}` }))
    const start = create({ options, visibleOptionCount: 5 }) as { focusedValue: unknown; visibleFromIndex: number; visibleToIndex: number }
    check('the list opens on the first row with the window at the head', start.focusedValue === 'r0' && start.visibleFromIndex === 0 && start.visibleToIndex === 5)
    const last = reduce(start, { type: 'focus-last-option' })
    check('focus-last-option lands on the last row', last.focusedValue === 'r11', String(last.focusedValue))
    check('…and the window shows the tail', last.visibleFromIndex === 7 && last.visibleToIndex === 12, `${last.visibleFromIndex}..${last.visibleToIndex}`)
    const first = reduce(last, { type: 'focus-first-option' })
    check('focus-first-option lands back on the first row', first.focusedValue === 'r0', String(first.focusedValue))
    check('…and the window shows the head', first.visibleFromIndex === 0 && first.visibleToIndex === 5, `${first.visibleFromIndex}..${first.visibleToIndex}`)
    const again = reduce(first, { type: 'focus-first-option' })
    check('first on the first row is a no-op (the same state)', again === first)
    const disabledEdges = [
      { label: 'head', value: 'h', disabled: true },
      ...options.slice(0, 6),
      { label: 'tail', value: 't', disabled: true },
    ]
    const s2 = create({ options: disabledEdges, visibleOptionCount: 4, initialFocusValue: 'r2' }) as { focusedValue: unknown }
    const l2 = reduce(s2, { type: 'focus-last-option' })
    check('a disabled tail row is skipped: last lands on the last ENABLED row', l2.focusedValue === 'r5', String(l2.focusedValue))
    const f2 = reduce(l2, { type: 'focus-first-option' })
    check('a disabled head row is skipped: first lands on the first ENABLED row', f2.focusedValue === 'r0', String(f2.focusedValue))
    const single = create({ options: options.slice(0, 1), visibleOptionCount: 5 }) as { focusedValue: unknown }
    check('a one-row list answers both moves with the same row', reduce(single, { type: 'focus-last-option' }).focusedValue === 'r0' && reduce(single, { type: 'focus-first-option' }).focusedValue === 'r0')
  }
}

section('the select hook consumes the edge moves; the transcript scroller yields the wheel to a list on top')
{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const ROOT = join(import.meta.dir, '..', '..')
  const hook = readFileSync(join(ROOT, 'src/components/CustomSelect/use-select-input.ts'), 'utf8')
  check('the select hook registers select:first and select:last beside next and previous', hook.includes("'select:first'") && hook.includes("'select:last'"))
  check('the hook still gates the row moves off while an input row has focus', hook.includes("{ context: 'Select', isActive: !isDisabled && !state.isInInput }"))
  const scroller = await import('../../src/components/ScrollKeybindingHandler.tsx')
  const yields = (scroller as Record<string, unknown>).wheelYieldsToTopOverlay as (() => boolean) | undefined
  check('the scroller exposes its wheel-yield rule', typeof yields === 'function')
  if (yields) {
    const stack = await import('../../src/context/overlayStack.ts')
    stack.resetOverlayStackForTests()
    check('no overlay ⇒ the transcript keeps the wheel', !yields())
    const dialog = stack.pushOverlay({ id: 'settings', modal: true })
    check('a plain dialog on top ⇒ the transcript keeps the wheel', !yields())
    const list = stack.pushOverlay({ id: 'select', modal: true })
    check('a select list on top ⇒ the transcript yields the wheel', yields())
    stack.popOverlay(list)
    check('the list closed ⇒ the transcript takes the wheel again', !yields())
    const picker = stack.pushOverlay({ id: 'model-picker', modal: true })
    check('the model picker on top ⇒ the transcript yields the wheel', yields())
    stack.popOverlay(picker)
    for (const id of ['command-palette', 'quick-open', 'file-open', 'content-search', 'files-menu']) {
      const token = stack.pushOverlay({ id, modal: true })
      check(`the ${id} list over the transcript ⇒ the transcript yields the wheel`, yields())
      stack.popOverlay(token)
    }
    for (const id of ['search', 'input-atlas', 'compact-work', 'multi-select', 'board', 'list']) {
      const token = stack.pushOverlay({ id, modal: true })
      check(`the ${id} overlay on top ⇒ the transcript keeps the wheel as before`, !yields())
      stack.popOverlay(token)
    }
    stack.popOverlay(dialog)
    stack.resetOverlayStackForTests()
  }
  const { decodeNavKey } = await import('../../src/components/mercury-ui/navSemantics.ts')
  check('the raw-grammar lists (the model picker) read the wheel as a row move on the vertical axis',
    decodeNavKey('', keyOf('wheelUp'), { orientation: 'vertical' }) === 'movePrevious' && decodeNavKey('', keyOf('wheelDown'), { orientation: 'vertical' }) === 'moveNext')
  check('a horizontal control (the effort strip) gives the wheel no meaning',
    decodeNavKey('', keyOf('wheelUp'), { orientation: 'horizontal' }) === null && decodeNavKey('', keyOf('wheelDown'), { orientation: 'horizontal' }) === null)
  check('Home and End on the raw-grammar lists are unchanged (first and last)',
    decodeNavKey('', keyOf('home'), { orientation: 'vertical' }) === 'first' && decodeNavKey('', keyOf('end'), { orientation: 'vertical' }) === 'last')
  const clears = (scroller as Record<string, unknown>).shouldClearSelectionOnKey as ((key: Key) => boolean) | undefined
  check('the scroller exposes its selection-clear rule', typeof clears === 'function')
  if (clears) {
    check('a wheel notch that reaches the clear listener (the scroller yielded it) never clears a transcript selection', !clears(keyOf('wheelUp')) && !clears(keyOf('wheelDown')))
    check('a bare key still clears; a shifted or meta key still does not', clears(keyOf('downArrow')) && !clears({ ...keyOf('downArrow'), shift: true }) && !clears({ ...keyOf('downArrow'), meta: true }))
  }
  const text = readFileSync(join(ROOT, 'src/components/ScrollKeybindingHandler.tsx'), 'utf8')
  const sites = (text.match(/if \(wheelYieldsToTopOverlay\(\)\) return/g) ?? []).length
  check('the two line actions and the raw wheel handler all stand down under the rule (three sites)', sites === 3, String(sites))
  check('the page-key yield the estate already had is untouched (six sites)', (text.match(/if \(topOverlayOwnsPageKeys\(\)\) return false/g) ?? []).length === 6)
}

console.log(failures === 0 ? '\nGREEN: Home, End and the wheel act in the lists' : `\nRED: ${failures} check(s) show keys that do nothing in the lists`)
process.exit(failures === 0 ? 0 : 1)
