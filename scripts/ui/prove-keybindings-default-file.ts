#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'keybindings-default-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_KEYBINDINGS
delete process.env.MERCURY_KEYBINDINGS_FILE

let failures = 0
let count = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  count++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)

const { generateKeybindingsTemplate } = await import('../../src/keybindings/template.ts')
const { validateBindings } = await import('../../src/keybindings/validate.ts')
const { parseBindings } = await import('../../src/keybindings/parser.ts')
const { getKeybindingsPath, loadKeybindingsSyncWithWarnings, invalidateKeybindingsCache } = await import('../../src/keybindings/loadUserBindings.ts')
const { resolveExternalEditor } = await import('../../src/utils/editor.ts')
const { toTildePath } = await import('../../src/utils/path.ts')
const command = (await import('../../src/commands/keybindings/keybindings.ts')) as { openKeybindings?: (io: { edit?: (path: string) => Promise<{ content: string | null; error?: string }>; editor?: () => ReturnType<typeof resolveExternalEditor> }) => Promise<{ type: string; value: string }> }

try {
  section('§1 the default file /keybindings writes passes the product\'s own checker (the field row M39-11, 1C-08)')
  {
    const template = JSON.parse(generateKeybindingsTemplate()) as { bindings: Array<{ context: string; bindings: Record<string, string | null> }> }
    const warnings = validateBindings(template.bindings, parseBindings(template.bindings))
    check('the shipped template carries the Global command bindings the product ships (workbench, sessions)', template.bindings.some(block => block.context === 'Global' && Object.values(block.bindings).includes('command:workbench')), j(template.bindings.map(b => b.context)))
    check('the checker raises no warning on the untouched default file', warnings.length === 0, j(warnings.map(w => w.message)))
    const path = getKeybindingsPath()
    writeFileSync(path, generateKeybindingsTemplate())
    invalidateKeybindingsCache()
    const loaded = loadKeybindingsSyncWithWarnings()
    check('the loader (what health and the footer count) reads the default file with no warnings', loaded.warnings.length === 0, j(loaded.warnings.map(w => w.message)))
    const elsewhere = validateBindings([{ context: 'Settings', bindings: { 'ctrl+x w': 'command:workbench' } }], parseBindings([{ context: 'Settings', bindings: { 'ctrl+x w': 'command:workbench' } }]))
    check('a command binding in a context that never runs commands is still flagged, naming Chat or Global as its home', elsewhere.length === 1 && elsewhere[0]!.message.includes('Settings') && elsewhere[0]!.suggestion === 'Move it into a "Chat" or "Global" block', j(elsewhere))
    rmSync(path, { force: true })
  }

  section('§2 /keybindings says what the editor did in one footer line and never pretends an editor opened (M39-11; the round-14 Windows blocker F39W-14C-12)')
  {
    const path = getKeybindingsPath()
    const shown = toTildePath(path)
    rmSync(path, { force: true })
    const none = await command.openKeybindings?.({ editor: () => ({ ok: false, reason: 'none' }) })
    check('with no editor configured the command creates the file and names the by-hand road', none !== undefined && none.value === `EDITOR is unset — edit ${shown} by hand` && existsSync(path), j(none))
    let spawned = 0
    const spy = async (p: string): Promise<{ content: string | null; error?: string }> => { spawned++; return { content: readFileSync(p, 'utf8') } }
    const noOp = await command.openKeybindings?.({ editor: () => resolveExternalEditor('true', 'VISUAL'), edit: spy })
    check('VISUAL=true (the shell no-op Mercury\'s own tool shell hands to its children) is refused in words before any editor call', noOp !== undefined && noOp.value === 'VISUAL=true is not an editor — set VISUAL to an editor' && spawned === 0, j({ noOp, spawned }))
    const missing = await command.openKeybindings?.({ editor: () => resolveExternalEditor('nosuch-editor-9000', 'EDITOR'), edit: spy })
    check('an executable that is nowhere on PATH is refused in words before any editor call, the value cut to fit the line', missing !== undefined && missing.value === 'EDITOR=nosuch-edito… is not on PATH — set EDITOR to an editor' && spawned === 0, j({ missing, spawned }))
    const win32 = resolveExternalEditor('true', 'VISUAL', { platform: 'win32', path: 'C:\\Windows\\System32' })
    check('under the win32 spelling of the walk `true` is refused by name, before the shell that answers "not recognized" is ever asked', !win32.ok && win32.reason === 'no-op', j(win32))
    const binDir = join(home, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'true.exe'), '')
    writeFileSync(join(binDir, 'notepad.exe'), '')
    const presentNoOp = resolveExternalEditor('true', 'EDITOR', { platform: 'win32', path: binDir })
    const notepad = resolveExternalEditor('notepad', 'default', { platform: 'win32', path: binDir })
    check('a true.exe that exists is still no editor (the name law outranks presence); notepad.exe on the win32 walk resolves', !presentNoOp.ok && presentNoOp.reason === 'no-op' && notepad.ok && notepad.executable === 'notepad', j({ presentNoOp, notepad }))
    for (const line of [noOp?.value ?? '', missing?.value ?? '', 'EDITOR=quick.sh returned at once; set an editor that waits']) {
      check(`the footer line stands whole at 80 columns (${line.length} ≤ 61): ${line}`, line.length <= 61 && !line.includes('\n'), String(line.length))
    }
    const quick = { ok: true as const, editor: 'quick.sh', variable: 'EDITOR' as const, executable: 'quick.sh', args: [] }
    const atOnce = await command.openKeybindings?.({ editor: () => quick, edit: async p => ({ content: readFileSync(p, 'utf8') }) })
    check('an editor that returns at once without a change is named by its variable, not reported as opened', atOnce !== undefined && atOnce.value === 'EDITOR=quick.sh returned at once; set an editor that waits', j(atOnce))
    const vim = { ok: true as const, editor: 'vim', variable: 'EDITOR' as const, executable: 'vim', args: [] }
    const failed = await command.openKeybindings?.({ editor: () => vim, edit: async () => ({ content: null, error: 'EDITOR=vim exited with code 1' }) })
    check('an editor that fails is reported with its words', failed !== undefined && failed.value === 'EDITOR=vim exited with code 1', j(failed))
    const edited = await command.openKeybindings?.({ editor: () => vim, edit: async p => { const next = readFileSync(p, 'utf8').replace('"$docs"', '"$edited"'); writeFileSync(p, next); await new Promise(r => setTimeout(r, 10)); return { content: next } } })
    check('a real edit is reported as saved and read', edited !== undefined && edited.value === `Saved ${shown} — the change is read now`, j(edited))
    const opened = await command.openKeybindings?.({ editor: () => vim, edit: async p => { await new Promise(r => setTimeout(r, 600)); return { content: readFileSync(p, 'utf8') } } })
    check('an editor that waited and changed nothing is reported as opened, with the /keys pointer', opened !== undefined && opened.value === `Opened ${shown} — /keys shows the map`, j(opened))
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('KEYBINDINGS DEFAULT FILE RED')
  process.exit(1)
}
console.log('KEYBINDINGS DEFAULT FILE GREEN')
