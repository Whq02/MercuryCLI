#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'trust-card-keys-')))
const HOME = join(SCRATCH, 'home')
const FOLDER = join(SCRATCH, 'folder')
for (const dir of [HOME, join(FOLDER, '.mercury')]) mkdirSync(dir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
for (const key of ['MERCURY_HOME', 'MERCURY_BARE']) delete process.env[key]
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const SRC = join(import.meta.dir, '..', '..', 'src')
const DECLINING_KEYS: ReadonlyArray<readonly [context: string, keys: string, action: string]> = [
  ['Select', 'escape', 'select:accept'],
  ['Select', 'n', 'select:accept'],
  ['Select', 'down', 'select:accept'],
  ['Select', '2', 'select:accept'],
  ['Select', 'ctrl+c', 'select:accept'],
  ['Confirmation', 'escape', 'confirm:yes'],
  ['Confirmation', 'n', 'confirm:yes'],
]
const blocksOf = (rows: ReadonlyArray<readonly [string, string, string]>): Array<{ context: string; bindings: Record<string, string> }> => {
  const byContext = new Map<string, Record<string, string>>()
  for (const [context, keys, action] of rows) byContext.set(context, { ...(byContext.get(context) ?? {}), [keys]: action })
  return [...byContext].map(([context, bindings]) => ({ context, bindings }))
}
writeFileSync(join(FOLDER, '.mercury', 'keybindings.json'), JSON.stringify({ bindings: blocksOf(DECLINING_KEYS) }))
writeFileSync(join(HOME, 'keybindings.json'), JSON.stringify({ bindings: blocksOf([['Select', 'x', 'select:accept']]) }))

const state = await import(join(SRC, 'bootstrap/state.ts'))
const { setCwd } = await import(join(SRC, 'utils/Shell.ts'))
setCwd(FOLDER)
state.setOriginalCwd(FOLDER)
state.setProjectRoot(FOLDER)
const { enableConfigs } = await import(join(SRC, 'utils/config.ts'))
const { resetTrustDialogAcceptedCacheForTesting, checkHasTrustDialogAccepted } = await import(join(SRC, 'utils/config/trust.ts'))
const loader = await import(join(SRC, 'keybindings/loadUserBindings.ts'))
const { parseBindings } = await import(join(SRC, 'keybindings/parser.ts'))
const { DEFAULT_BINDINGS } = await import(join(SRC, 'keybindings/defaultBindings.ts'))
enableConfigs()

type Bound = { context: string; chord: unknown; action: string | null }
const chordOf = (context: string, keys: string): string => JSON.stringify((parseBindings([{ context, bindings: { [keys]: 'select:accept' } }]) as Bound[])[0]!.chord)
const actionOf = (table: Bound[], context: string, keys: string): string => {
  const chord = chordOf(context, keys)
  let found: string | null | undefined
  for (const binding of table) if (binding.context === context && JSON.stringify(binding.chord) === chord) found = binding.action
  return found === undefined ? '(not bound)' : String(found)
}
const defaults = parseBindings(DEFAULT_BINDINGS) as Bound[]
const reading = (table: Bound[]): string => DECLINING_KEYS.map(([context, keys]) => `${context} ${keys} → ${actionOf(table, context, keys)}`).join(' · ')

console.log('============================================================')
console.log(' the keys of the trust card are never the folder\'s own')
console.log('============================================================')

section('§1 a window in a folder nobody trusted, while the trust card stands')
state.setSessionTrustAccepted(false)
resetTrustDialogAcceptedCacheForTesting()
state.setIsInteractive(true)
{
  const table = loader.loadKeybindingsSyncWithWarnings().bindings as Bound[]
  check('the folder has no grant and the control is live: the planted file would rebind seven keys that decline', checkHasTrustDialogAccepted() === false && DECLINING_KEYS.every(([context, keys, action]) => actionOf(defaults, context, keys) !== action), reading(defaults))
  check('the folder\'s keybindings file is not a layer before the grant', loader.getProjectKeybindingsPath() === null, String(loader.getProjectKeybindingsPath()))
  check('each of esc, n, ↓, 2 and ctrl+c does on the card what the defaults say, never what the folder says', DECLINING_KEYS.every(([context, keys]) => actionOf(table, context, keys) === actionOf(defaults, context, keys)), reading(table))
  check('the user\'s own keybindings file still applies there', actionOf(table, 'Select', 'x') === 'select:accept', actionOf(table, 'Select', 'x'))
  const watched = (await loader.loadKeybindings()).bindings as Bound[]
  check('the reload a file change triggers holds the folder\'s layer back as well', DECLINING_KEYS.every(([context, keys]) => actionOf(watched, context, keys) === actionOf(defaults, context, keys)), reading(watched))
}

section('§2 the same window once the card is answered yes')
state.setSessionTrustAccepted(true)
{
  const table = loader.loadKeybindingsSyncWithWarnings().bindings as Bound[]
  check('the folder is trusted and its file is a layer', checkHasTrustDialogAccepted() === true && loader.getProjectKeybindingsPath() === join(FOLDER, '.mercury', 'keybindings.json'), String(loader.getProjectKeybindingsPath()))
  check('the table is read again at the grant, with no reload asked for, and the folder\'s bindings apply', DECLINING_KEYS.every(([context, keys, action]) => actionOf(table, context, keys) === action), reading(table))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` ✅ trust card keys: ${checks} checks, 0 failures` : ` ❌ trust card keys: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
