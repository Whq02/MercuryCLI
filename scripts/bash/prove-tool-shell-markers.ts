#!/usr/bin/env bun
import { plugin } from 'bun'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

plugin({
  name: 'tool-shell-markers-native-stub',
  setup(build) {
    build.module('color-diff-napi', () => ({ loader: 'object', exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) } }))
  },
})

const ROOT = resolve(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tool-shell-markers-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
process.env.HOME = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
mkdirSync(process.env.HOME, { recursive: true })
process.chdir(ROOT)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const markers = { MERCURY: '1', AGENT: '1', AI_AGENT: 'mercury' }
for (const key of Object.keys(markers)) delete process.env[key]
if (process.platform !== 'win32') process.env.SHELL = '/bin/bash'
let failures = 0
function check(label: string, ok: boolean, detail = '', hint = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!ok && hint ? ` — ${hint}` : ''}`)
}
const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
setIsInteractive(true)
const owner = await import('../../src/platform/processes/subprocessEnv.ts') as {
  toolShellEnv?: (env: NodeJS.ProcessEnv, overrides?: NodeJS.ProcessEnv, platform?: string) => NodeJS.ProcessEnv
}
const compose = owner.toolShellEnv ?? ((env: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv = {}) => ({ ...env, ...overrides }))
const { exec, setCwd } = await import('../../src/platform/shell/shellExec.ts')
const { endEngineSession, resolveShellEngine } = await import('../../src/platform/shell/engineSession.ts')
const { quote } = await import('../../src/platform/shell/bash/shellQuote.ts')
const { resetSettingsCache } = await import('../../src/platform/settings/settingsCache.ts')
const { applyConfigEnvironmentVariables } = await import('../../src/platform/environment/settingsEnv.ts')
const probe = join(scratch, 'markers.cjs')
writeFileSync(probe, `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(markers))}.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))))`)
setCwd(scratch)
async function childMarkers(): Promise<NodeJS.ProcessEnv> {
  const handle = await exec(quote([process.execPath, probe]), new AbortController().signal, 'bash', { timeout: 30_000, shouldAutoBackground: false })
  const result = await handle.result
  check('marker probe exits normally', result.code === 0 && !result.interrupted, `rc=${result.code}`, 'the marker probe is a plain node child run through exec in src/platform/shell/shellExec.ts; fix why that call fails')
  try { return JSON.parse(result.stdout.trim()) as NodeJS.ProcessEnv } catch { check('marker probe returned JSON', false, JSON.stringify(result), 'the child printed no JSON; exec in src/platform/shell/shellExec.ts must pass the child its stdout'); return {} }
}

try {
  console.log('markers')
  for (const platform of ['darwin', 'linux', 'win32']) {
    const env = compose({}, {}, platform)
    check(`${platform}: the three markers identify a tool shell`, Object.entries(markers).every(([key, value]) => env[key] === value), '', 'toolShellEnv in src/platform/processes/subprocessEnv.ts must add MERCURY=1, AGENT=1 and AI_AGENT=mercury on every platform')
  }
  const engines = process.platform === 'win32' ? ['brush'] : (resolveShellEngine('brush').engine === 'brush' ? ['system', 'brush'] : ['system'])
  for (const engine of engines) {
    await endEngineSession()
    process.env.MERCURY_SHELL_ENGINE = engine
    const env = await childMarkers()
    check(`${engine}: a real child sees all three agent markers`, Object.entries(markers).every(([key, value]) => env[key] === value), JSON.stringify(env), 'the tool shell env (toolShellEnv in src/platform/processes/subprocessEnv.ts) must reach the shell that exec in src/platform/shell/shellExec.ts starts on this engine')
  }

  console.log('refusals')
  for (const platform of ['darwin', 'linux', 'win32']) {
    for (const value of ['', 'outer-agent']) {
      const user = Object.fromEntries(Object.keys(markers).map(key => [key, value]))
      const env = compose(user, {}, platform)
      check(`${platform}: markers never replace a user's ${JSON.stringify(value)}`, Object.keys(markers).every(key => env[key] === value), '', 'toolShellEnv in src/platform/processes/subprocessEnv.ts must keep a marker the user already set, even an empty one')
    }
  }
  const folded = compose({ agent: 'outer-agent', ai_agent: '', mercury: 'parent' }, {}, 'win32')
  check('Windows: casing never creates a competing marker', folded.agent === 'outer-agent' && folded.ai_agent === '' && folded.mercury === 'parent' && folded.AGENT === undefined && folded.AI_AGENT === undefined && folded.MERCURY === undefined, '', 'toolShellEnv in src/platform/processes/subprocessEnv.ts must match marker names case-insensitively on win32 and add none')
  process.env.AI_AGENT = 'outer-agent'
  for (const engine of engines) {
    await endEngineSession()
    process.env.MERCURY_SHELL_ENGINE = engine
    const env = await childMarkers()
    check(`${engine}: a surrounding agent's AI_AGENT survives in a real child`, env.AI_AGENT === 'outer-agent' && env.MERCURY === '1' && env.AGENT === '1', JSON.stringify(env), 'toolShellEnv in src/platform/processes/subprocessEnv.ts must keep an AI_AGENT set in the surrounding environment')
  }
  const configured = { MERCURY: 'parent', AGENT: '0', AI_AGENT: '' }
  writeFileSync(join(process.env.MERCURY_CONFIG_DIR!, 'settings.json'), JSON.stringify({ environment: { values: configured } }))
  resetSettingsCache()
  applyConfigEnvironmentVariables()
  for (const engine of engines) {
    await endEngineSession()
    process.env.MERCURY_SHELL_ENGINE = engine
    const env = await childMarkers()
    check(`${engine}: the real settings values win, including an empty marker`, Object.entries(configured).every(([key, value]) => env[key] === value), JSON.stringify(env), 'settings environment values (applyConfigEnvironmentVariables in src/platform/environment/settingsEnv.ts) must win over the markers, including an empty value')
  }
} finally {
  await endEngineSession()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? 'PASS tool shell markers and refusals' : `FAIL tool shell markers and refusals (${failures})`)
process.exit(failures === 0 ? 0 : 1)
