#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'folder-consent-policy-')))
const HOME = join(SCRATCH, 'home')
const FOLDER = join(SCRATCH, 'folder')
const MANAGED = join(SCRATCH, 'managed-root')
const MARKS = join(SCRATCH, 'marks.txt')
for (const dir of [HOME, join(FOLDER, '.mercury'), MANAGED]) mkdirSync(dir, { recursive: true })
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

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const FILES = {
  user: join(HOME, 'settings.json'),
  project: join(FOLDER, '.mercury', 'settings.json'),
  local: join(FOLDER, '.mercury', 'settings.local.json'),
  managed: join(MANAGED, 'managed-settings.json'),
} as const
type Layers = Partial<Record<keyof typeof FILES, unknown>>

const managedPath = await import(join(SRC, 'utils/settings/managedPath.ts'))
managedPath.getManagedFilePath.cache.set(undefined, MANAGED)
const state = await import(join(SRC, 'bootstrap/state.ts'))
const { setCwd } = await import(join(SRC, 'utils/Shell.ts'))
setCwd(FOLDER)
state.setOriginalCwd(FOLDER)
state.setProjectRoot(FOLDER)
state.setIsInteractive(true)
state.setSessionTrustAccepted(true)
const { enableConfigs } = await import(join(SRC, 'utils/config.ts'))
const settings = await import(join(SRC, 'utils/settings/settings.ts'))
const { resetSettingsCache } = await import(join(SRC, 'utils/settings/settingsCache.ts'))
const hooks = await import(join(SRC, 'utils/hooks/hooksConfigSnapshot.ts'))
const suggestions = await import(join(SRC, 'hooks/fileSuggestions.ts'))
enableConfigs()

function world(layers: Layers): void {
  for (const [name, path] of Object.entries(FILES)) {
    const body = layers[name as keyof typeof FILES]
    if (body === undefined) rmSync(path, { force: true })
    else writeFileSync(path, JSON.stringify(body))
  }
  rmSync(MARKS, { force: true })
  resetSettingsCache()
  hooks.resetHooksSnapshot()
  hooks.captureHooksSnapshot()
}
const marks = (): string => (existsSync(MARKS) ? readFileSync(MARKS, 'utf8').split('\n').filter(Boolean).join(',') : '(none)')
const suggester = (who: string): Record<string, unknown> => ({ files: { suggester: { type: 'command', command: `echo ${who} >> ${JSON.stringify(MARKS)}; echo from-${who}.txt` } } })
const suggested = async (): Promise<string> => ((await suggestions.generateFileSuggestions('from', true)) as Array<{ displayText: string }>).map(item => item.displayText).join(',') || '(none)'
const consent = { guardrails: { sovereignConsentSeen: true } }

console.log('============================================================')
console.log(' a folder cannot accept the Sovereign consent for its user, and its file-suggestion command yields to managed-only')
console.log('============================================================')

section('§0 the page')
{
  const page = readFileSync(join(ROOT, 'docs', 'TRUST.md'), 'utf8')
  check('the page says the consent is honoured from the user, flag and policy sources, and that both files in the folder are excluded', /`guardrails\.sovereignConsentSeen` is honoured from the user, flag, and policy\s+settings sources\. The two files that live in the folder, the project settings\s+and the local settings, are deliberately excluded/.test(page))
  check('the page says the file-suggestion command runs only from policy settings under managed-only', /Under managed-only, the file-suggestion command\s+likewise runs only from policy settings/.test(page))
}

section('§1 the Sovereign consent, in a folder the user trusts')
{
  world({})
  check('with no consent on record the card is due', settings.hasSkipSovereignConsentPrompt() === false)
  world({ project: consent })
  check('claimed in the folder\'s checked-in settings: the card is still due', settings.hasSkipSovereignConsentPrompt() === false)
  world({ local: consent })
  check('claimed in the folder\'s local settings, a file the folder can carry: the card is still due', settings.hasSkipSovereignConsentPrompt() === false)
  world({ user: consent })
  check('recorded in the user\'s own settings, where the card writes it: no card', settings.hasSkipSovereignConsentPrompt() === true)
  world({ managed: consent })
  check('granted by managed policy: no card', settings.hasSkipSovereignConsentPrompt() === true)
}

section('§2 the file-suggestion command under managed-only')
{
  world({ user: suggester('user') })
  const free = await suggested()
  check('control, no policy: the user\'s command runs and its lines are the suggestions', free === 'from-user.txt' && marks() === 'user', `${free} / ${marks()}`)

  world({ user: suggester('user'), managed: { events: { managedOnly: true } } })
  const underUser = await suggested()
  check('managed-only, the command in the user\'s settings: it does not run', marks() === '(none)' && !underUser.includes('from-user'), `${underUser} / ${marks()}`)

  world({ project: suggester('folder'), managed: { events: { managedOnly: true } } })
  const underFolder = await suggested()
  check('managed-only, the command in the folder\'s settings: it does not run', marks() === '(none)' && !underFolder.includes('from-folder'), `${underFolder} / ${marks()}`)

  world({ user: suggester('user'), managed: { events: { managedOnly: true }, ...suggester('policy') } })
  const underPolicy = await suggested()
  check('managed-only, a command the policy defines: that one runs, the user\'s does not', underPolicy === 'from-policy.txt' && marks() === 'policy', `${underPolicy} / ${marks()}`)

  world({ user: { ...suggester('user'), events: { disabled: true } } })
  const disabled = await suggested()
  check('hooks disabled in the user\'s own settings: the command does not run', marks() === '(none)' && !disabled.includes('from-user'), `${disabled} / ${marks()}`)
}

world({})
rmSync(SCRATCH, { recursive: true, force: true })
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` ✅ consent and managed-only: ${checks} checks, 0 failures` : ` ❌ consent and managed-only: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
