#!/usr/bin/env bun
import { join } from 'node:path'
import { formsMissing, rowsBinding, shippedKeyForms } from '../lib/shippedKeyForms.ts'

let failures = 0
const hint = (name: string): string => {
  if (name.startsWith('cmd+c') || name.startsWith('the running platform') || name.startsWith('ctrl+shift+c')) return '; fix the Scroll rows of DEFAULT_BINDINGS in src/screen/keys/defaultBindings.ts'
  if (name.startsWith('the display walk') || name.startsWith('both chords')) return '; fix getBindingDisplayText in src/screen/keys/resolver.ts (or parseBindings in src/screen/keys/parser.ts)'
  return '; fix WINDOWS_RESERVED / reservedShortcutsFor in src/screen/keys/reservedShortcuts.ts'
}
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}${hint(name)}`)
  }
}

console.log('§1 the reserved tables carry the chords the Windows hosts actually eat')
{
  const { WINDOWS_RESERVED, reservedShortcutsFor } = await import('../../src/screen/keys/reservedShortcuts.ts')
  const ctrlV = WINDOWS_RESERVED.find(s => s.key === 'ctrl+v')
  check(
    'ctrl+v has its Windows row (`windows-reserved-omits-ctrl-v`): the chord BOTH hosts eat, as a warning',
    ctrlV !== undefined && ctrlV.severity === 'warning',
  )
  const win = reservedShortcutsFor('windows')
  check('the Windows set carries it', win.some(s => s.key === 'ctrl+v'))
  check(
    "ctrl+\\ sheds its POSIX quit-signal fiction on Windows (`ctrl-backslash-keeps-posix-quit-reason-on-windows`): no SIGQUIT there, neither host spends the chord",
    !win.some(s => s.key === 'ctrl+\\'),
  )
  check('…while POSIX platforms keep the real signal row as an error', reservedShortcutsFor('linux').some(s => s.key === 'ctrl+\\' && s.severity === 'error'))
  check('every Windows row stays a warning (the law)', WINDOWS_RESERVED.every(s => s.severity === 'warning'))
}


console.log('§4 the Scroll copy chord is platform-forked (no more super+c on Windows)')
{
  const shipped = shippedKeyForms()
  const darwinWithoutCopy = formsMissing(shipped.filter(form => form.form.startsWith('darwin')), 'Scroll', 'cmd+c', 'selection:copy')
  const cmdCopyElsewhere = rowsBinding(shipped, (action, chord, context) => chord === 'cmd+c' && !(context === 'Scroll' && action === 'selection:copy'))
    .concat(rowsBinding(shipped.filter(form => !form.form.startsWith('darwin')), (_action, chord) => chord === 'cmd+c'))
  check(
    "cmd+c is darwin's (the IMAGE_PASTE_KEY idiom): declared unconditionally it won the end-first display walk everywhere and the Windows footer taught super+c, deliverable by no console there",
    darwinWithoutCopy.length === 0 && cmdCopyElsewhere.length === 0,
    [...darwinWithoutCopy.map(form => `${form} lacks Scroll cmd+c`), ...cmdCopyElsewhere].join(' · '),
  )
  const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.ts')
  const scroll = DEFAULT_BINDINGS.find(b => b.context === 'Scroll')?.bindings ?? {}
  check(
    'the running platform sees the truthful row set',
    process.platform === 'darwin' ? scroll['cmd+c'] === 'selection:copy' : !('cmd+c' in scroll),
  )
  check('ctrl+shift+c copy stays on every platform', scroll['ctrl+shift+c'] === 'selection:copy')
}

console.log('§5 the display walk teaches the chord declared last — the portable one when a shift chord and a prefix chord are authored for one action')
{
  const { parseBindings } = await import('../../src/screen/keys/parser.ts')
  const { getBindingDisplayText } = await import('../../src/screen/keys/resolver.ts')
  const parsed = parseBindings([{ context: 'Global', bindings: { 'ctrl+shift+o': 'app:toggleTerminal', 'ctrl+x o': 'app:toggleTerminal' } }] as never)
  const display = getBindingDisplayText('app:toggleTerminal', 'Global', parsed, 'windows')
  check(
    "the display walk teaches the prefix chord declared last, never the shift one conhost collapses onto ctrl+o (`help-advertises-the-non-portable-crewmate-chord`)",
    display !== undefined && /x\s*o/i.test(display) && !/shift/i.test(display) && !/⇧/.test(display),
    String(display),
  )
  check(
    'both chords still fire (the precedence is display order, not a rebind)',
    parsed.filter(b => b.action === 'app:toggleTerminal' && b.context === 'Global').length === 2,
  )
}

process.exit(failures === 0 ? 0 : 1)
