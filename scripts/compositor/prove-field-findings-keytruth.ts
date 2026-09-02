#!/usr/bin/env bun
// ============================================================================
//  scripts/compositor/prove-field-findings-keytruth.ts — the keybinding
// surfaces tell the Windows truth (TASK-017 supplement,
//  SURVIVED findings, the L6 class: hosts that own keys first).
//
//  Run: ~/.bun/bin/bun run scripts/compositor/prove-field-findings-keytruth.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  RED ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('§1 the reserved tables carry the chords the Windows hosts actually eat')
{
  const { WINDOWS_RESERVED, reservedShortcutsFor } = await import('../../src/keybindings/reservedShortcuts.ts')
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

console.log('§2 the bundled keybindings skill renders the Windows table it used to drop')
{
  const skill = readFileSync(join(ROOT, 'src/skills/bundled/keybindings.ts'), 'utf8')
  check(
    'reservedTable() renders WINDOWS_RESERVED (`skill-reserved-table-drops-every-windows-row`)',
    skill.includes('Windows-reserved (warnings on Windows') && skill.includes('for (const { key, reason } of WINDOWS_RESERVED)'),
  )
  check('…imported from the one table owner', /import \{[\s\S]{0,200}WINDOWS_RESERVED,[\s\S]{0,100}\} from '\.\.\/\.\.\/keybindings\/reservedShortcuts\.js'/.test(skill))
}

console.log('§3 /terminal-setup no longer lists the host it just refused')
{
  const ts = readFileSync(join(ROOT, 'src/commands/terminalSetup/terminalSetup.tsx'), 'utf8')
  check(
    "win32 contributes NO 'Supported terminals' row (three lenses filed the contradiction independently)",
    !ts.includes("' - Windows Terminal\\n'") && ts.includes("process.platform === 'darwin' ? ' - Apple Terminal\\n' : ''"),
  )
}

console.log('§4 the Scroll copy chord is platform-forked (no more super+c on Windows)')
{
  const db = readFileSync(join(ROOT, 'src/keybindings/defaultBindings.ts'), 'utf8')
  check(
    "cmd+c is darwin's (the IMAGE_PASTE_KEY idiom): declared unconditionally it won the end-first display walk everywhere and the Windows footer taught super+c, deliverable by no console there",
    db.includes("...(process.platform === 'darwin' ? { 'cmd+c': 'selection:copy' } : {})"),
  )
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
  const scroll = DEFAULT_BINDINGS.find(b => b.context === 'Scroll')?.bindings ?? {}
  check(
    'the running platform sees the truthful row set',
    process.platform === 'darwin' ? scroll['cmd+c'] === 'selection:copy' : !('cmd+c' in scroll),
  )
  check('ctrl+shift+c copy stays on every platform', scroll['ctrl+shift+c'] === 'selection:copy')
}

console.log('§5 every display surface teaches the PORTABLE teammate-preview chord')
{
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.ts')
  const { parseBindings } = await import('../../src/keybindings/parser.ts')
  const { getBindingDisplayText } = await import('../../src/keybindings/resolver.ts')
  const parsed = parseBindings(DEFAULT_BINDINGS)
  // The end-first walk now lands on 'ctrl+x o' — the chord that works on
  // every wire — instead of ctrl+shift+o, which conhost collapses onto
  // ctrl+o (the transcript toggle). /help's shortcuts tab reads this walk.
  const display = getBindingDisplayText('app:toggleTeammatePreview', 'Global', parsed, 'windows')
  check(
    "the display walk teaches the prefix chord, never the shift one (`help-advertises-the-non-portable-teammate-chord`)",
    display !== undefined && /x\s*o/i.test(display) && !/shift/i.test(display) && !/⇧/.test(display),
    String(display),
  )
  check(
    'both chords still fire (the swap is display precedence, not a rebind)',
    parsed.filter(b => b.action === 'app:toggleTeammatePreview' && b.context === 'Global').length === 2,
  )
}

process.exit(failures === 0 ? 0 : 1)
