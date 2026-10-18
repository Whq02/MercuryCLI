#!/usr/bin/env bun
import { plugin } from 'bun'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

plugin({
  name: 'tool-shell-defaults-native-stub',
  setup(build) {
    build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
  },
})

const ROOT = resolve(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tool-shell-defaults-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.HOME = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.HOME, { recursive: true })
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const state = await import('../../src/bootstrap/state.ts')
const owner = await import('../../src/utils/subprocessEnv.ts') as {
  TOOL_SHELL_DEFAULTS?: Readonly<Record<string, string>>
  toolShellEnv?: (env: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv, platform?: string) => NodeJS.ProcessEnv
  subprocessEnv: () => NodeJS.ProcessEnv
}
const defaults = owner.TOOL_SHELL_DEFAULTS ?? {}
const compose = owner.toolShellEnv ?? ((env: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}) => ({ ...env, ...overrides }))
const windows = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }
const names = [...new Set([...Object.keys(defaults), ...Object.keys(windows), 'GH_PAGER', 'EDITOR', 'GIT_EDITOR', 'PAGER', 'CI', 'TERM'])]
for (const name of names) delete process.env[name]
state.setIsInteractive(true)
if (process.platform !== 'win32') process.env.SHELL = '/bin/bash'
const { exec, setCwd } = await import('../../src/utils/Shell.ts')
const { endEngineSession, resolveShellEngine } = await import('../../src/utils/shell/engineSession.ts')
const { quote } = await import('../../src/utils/bash/shellQuote.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { applyConfigEnvironmentVariables } = await import('../../src/utils/managedEnv.ts')
const probe = join(scratch, 'environment.cjs')
writeFileSync(probe, `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))))`)
setCwd(scratch)
async function readChild(): Promise<NodeJS.ProcessEnv> {
  const handle = await exec(quote([process.execPath, probe]), new AbortController().signal, 'bash', { timeout: 30_000, shouldAutoBackground: false })
  const result = await handle.result
  check('the environment probe exits normally', result.code === 0 && !result.interrupted, `rc=${result.code}`)
  try { return JSON.parse(result.stdout.trim()) as NodeJS.ProcessEnv } catch { check('the probe returned its JSON', false, JSON.stringify(result)); return {} }
}

try {
  console.log('defaults')
  check('one table owns pager, editor and package prompt defaults', defaults.GH_PAGER === 'cat' && defaults.EDITOR === 'true' && defaults.npm_config_yes === 'true')
  for (const platform of ['darwin', 'linux', 'win32']) {
    const input: NodeJS.ProcessEnv = { PATH: 'staged-path', UNRELATED: 'unchanged' }
    const child = compose(input, {}, platform)
    check(`${platform}: every table entry reaches an empty tool environment`, Object.entries(defaults).every(([key, value]) => child[key] === value))
    check(`${platform}: input and unrelated bytes stay untouched`, JSON.stringify(input) === JSON.stringify({ PATH: 'staged-path', UNRELATED: 'unchanged' }) && child.PATH === input.PATH && child.UNRELATED === input.UNRELATED)
    check(`${platform}: CI and TERM remain absent`, child.CI === undefined && child.TERM === undefined)
    check(`${platform}: UTF-8 defaults are Windows-only`, Object.entries(windows).every(([key, value]) => platform === 'win32' ? child[key] === value : child[key] === undefined))
  }
  check('an interactive non-tool child gets no tool defaults', owner.subprocessEnv().GH_PAGER === undefined && owner.subprocessEnv().EDITOR === undefined)

  for (const engine of process.platform === 'win32' ? ['brush'] : ['system', 'brush']) {
    await endEngineSession()
    process.env.MERCURY_SHELL_ENGINE = engine
    check(`${engine}: the requested road is available`, resolveShellEngine().engine === engine)
    const child = await readChild()
    check(`${engine}: pagers and editors are non-interactive on an interactive session`, child.GH_PAGER === 'cat' && child.EDITOR === 'true', JSON.stringify({ GH_PAGER: child.GH_PAGER, EDITOR: child.EDITOR }))
    check(`${engine}: the real shell inherits the entire table`, Object.entries(defaults).every(([key, value]) => child[key] === value), Object.entries(defaults).filter(([key, value]) => child[key] !== value).map(([key]) => key).join(', '))
  }

  console.log('refusals')
  for (const platform of ['darwin', 'linux', 'win32']) {
    const table = platform === 'win32' ? { ...defaults, ...windows } : defaults
    for (const value of ['', 'operator value']) {
      const user = Object.fromEntries(Object.keys(table).map(key => [key, value]))
      const child = compose(user, {}, platform)
      check(`${platform}: all user-set keys survive (${JSON.stringify(value)})`, Object.keys(table).every(key => child[key] === value))
      const settings = Object.fromEntries(Object.keys(table).map(key => [key, `settings ${value}`]))
      const configured = compose(user, settings, platform)
      check(`${platform}: every explicit override survives`, Object.keys(table).every(key => configured[key] === settings[key]))
    }
    const exact = compose({ CI: 'operator-ci', TERM: 'operator-term' }, {}, platform)
    check(`${platform}: CI and TERM retain their exact values`, exact.CI === 'operator-ci' && exact.TERM === 'operator-term')
  }
  const folded = compose({ pager: '', git_editor: 'custom editor', pythonutf8: '0' }, {}, 'win32')
  check('Windows: differently cased user keys are not shadowed', folded.pager === '' && folded.PAGER === undefined && folded.git_editor === 'custom editor' && folded.GIT_EDITOR === undefined && folded.pythonutf8 === '0' && folded.PYTHONUTF8 === undefined)
  const layered = compose({ PAGER: 'parent' }, { pager: 'settings' }, 'win32')
  check('Windows: an explicit override replaces the same key without a case twin', layered.pager === 'settings' && layered.PAGER === undefined)

  const settings = { GIT_EDITOR: 'settings-editor', GH_PAGER: '', PAGER: 'settings-pager', NO_COLOR: 'settings-colour', FORCE_COLOR: '0', CI: 'keep-ci', TERM: 'keep-term' }
  writeFileSync(join(process.env.MERCURY_CONFIG_DIR!, 'settings.json'), JSON.stringify({ environment: { values: settings } }))
  resetSettingsCache()
  applyConfigEnvironmentVariables()
  check('the real settings loader applied the scratch environment values', Object.entries(settings).every(([key, value]) => process.env[key] === value))
  for (const engine of process.platform === 'win32' ? ['brush'] : ['system', 'brush']) {
    await endEngineSession()
    process.env.MERCURY_SHELL_ENGINE = engine
    const child = await readChild()
    check(`${engine}: user settings survive shell defaults, including empty values`, Object.entries(settings).every(([key, value]) => child[key] === value), JSON.stringify(Object.fromEntries(Object.keys(settings).map(key => [key, child[key]]))))
  }
} finally {
  await endEngineSession()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? 'PASS tool shell defaults and refusals' : `FAIL tool shell defaults and refusals (${failures})`)
process.exit(failures === 0 ? 0 : 1)
