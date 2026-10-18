#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const command = (await import('../../src/commands/keybindings/keybindings.ts')) as { openKeybindings?: (io: { edit?: (path: string) => Promise<{ content: string | null; error?: string }>; editor?: () => string | undefined }) => Promise<{ type: string; value: string }> }

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

  section('§2 /keybindings says what the editor did and never pretends an editor opened')
  {
    const path = getKeybindingsPath()
    rmSync(path, { force: true })
    const none = await command.openKeybindings?.({ editor: () => undefined })
    check('with no editor configured the command creates the file and says so, naming EDITOR and VISUAL and the by-hand road', none !== undefined && none.value.startsWith(`Created ${path}; no editor is configured`) && none.value.includes('set EDITOR or VISUAL') && none.value.includes('/keys') && existsSync(path), j(none))
    const atOnce = await command.openKeybindings?.({ editor: () => 'true', edit: async p => ({ content: readFileSync(p, 'utf8') }) })
    check('an editor that returns at once without a change is named, not reported as opened', atOnce !== undefined && atOnce.value.startsWith(`Found ${path}; the editor (true) returned at once without opening it`), j(atOnce))
    const failed = await command.openKeybindings?.({ editor: () => 'vim', edit: async () => ({ content: null, error: 'vim exited with code 1' }) })
    check('an editor that fails is reported with its words', failed !== undefined && failed.value.includes('the editor failed to open it: vim exited with code 1'), j(failed))
    const edited = await command.openKeybindings?.({ editor: () => 'vim', edit: async p => { const next = readFileSync(p, 'utf8').replace('"$docs"', '"$edited"'); writeFileSync(p, next); await new Promise(r => setTimeout(r, 10)); return { content: next } } })
    check('a real edit is reported as saved and read', edited !== undefined && edited.value.startsWith(`Opened ${path} — the change is saved and read`), j(edited))
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
