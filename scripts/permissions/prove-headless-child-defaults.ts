#!/usr/bin/env bun
// gate-watch: src/utils/subprocessEnv.ts src/bootstrap/state.ts src/bootstrap/runtime/posture.ts
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

const state = await import('../../src/bootstrap/state.ts')
const subEnv = await import('../../src/utils/subprocessEnv.ts')
const defaults = (subEnv as { HEADLESS_CHILD_DEFAULTS?: Record<string, string> }).HEADLESS_CHILD_DEFAULTS ?? {}
const owed = (subEnv as { headlessChildDefaultsOwed?: (env: NodeJS.ProcessEnv) => string[] }).headlessChildDefaultsOwed ?? (() => [] as string[])

for (const name of ['GIT_TERMINAL_PROMPT', 'PAGER', 'GIT_PAGER', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SUBPROCESS_ENV_SCRUB', 'MERCURY_SUBPROCESS_CREDENTIAL_ISOLATION']) delete process.env[name]
for (const key of Object.keys(process.env)) if (key.startsWith('OTEL_') || key.startsWith('MERCURY_BROWSER_SECRET_')) delete process.env[key]

section('§1 the defaults a headless child is owed')
{
  check('three stamps: GIT_TERMINAL_PROMPT=0, PAGER=cat, GIT_PAGER=cat', defaults.GIT_TERMINAL_PROMPT === '0' && defaults.PAGER === 'cat' && defaults.GIT_PAGER === 'cat' && Object.keys(defaults).length === 3, JSON.stringify(defaults))
}

section('§2 a headless session (no interactive posture) stamps them on every child env')
{
  state.setIsInteractive(false)
  const env = subEnv.subprocessEnv()
  check('the child env is a copy, never the live process env', env !== process.env)
  check('GIT_TERMINAL_PROMPT=0 so git fails fast instead of waiting on a prompt nobody can answer', env.GIT_TERMINAL_PROMPT === '0', String(env.GIT_TERMINAL_PROMPT))
  check('PAGER=cat and GIT_PAGER=cat so no child opens a pager', env.PAGER === 'cat' && env.GIT_PAGER === 'cat', `${env.PAGER}/${env.GIT_PAGER}`)
  check('the live process env is untouched', process.env.GIT_TERMINAL_PROMPT === undefined && process.env.PAGER === undefined && process.env.GIT_PAGER === undefined)
  check('everything else rides through', env.PATH === process.env.PATH && env.HOME === process.env.HOME)
  const languageServer = subEnv.languageServerEnv()
  check('a language server child gets the same stamps', languageServer.GIT_TERMINAL_PROMPT === '0' && languageServer.PAGER === 'cat')
}

section('§3 the operator\'s own values win: a stamp never overrides what is set')
{
  state.setIsInteractive(false)
  process.env.PAGER = 'less -R'
  process.env.GIT_TERMINAL_PROMPT = '1'
  const env = subEnv.subprocessEnv()
  check('PAGER as set stays', env.PAGER === 'less -R', String(env.PAGER))
  check('GIT_TERMINAL_PROMPT as set stays', env.GIT_TERMINAL_PROMPT === '1', String(env.GIT_TERMINAL_PROMPT))
  check('the one missing stamp is still added', env.GIT_PAGER === 'cat', String(env.GIT_PAGER))
  check('only the missing name is owed', JSON.stringify(owed(process.env)) === JSON.stringify(['GIT_PAGER']), JSON.stringify(owed(process.env)))
  process.env.GIT_PAGER = 'delta'
  check('with all three set the hot path returns the live env by reference again', subEnv.subprocessEnv() === process.env)
  delete process.env.PAGER
  delete process.env.GIT_TERMINAL_PROMPT
  delete process.env.GIT_PAGER
}

section('§4 an interactive session\'s own shell is never stamped')
{
  state.setIsInteractive(true)
  check('nothing is owed', owed(process.env).length === 0)
  const env = subEnv.subprocessEnv()
  check('the hot path returns the live env by reference', env === process.env)
  check('no pager or prompt stamp reaches the shell', env.GIT_TERMINAL_PROMPT === undefined && env.PAGER === undefined && env.GIT_PAGER === undefined)
  process.env.MERCURY_OAUTH_TOKEN = 'a-session-token'
  const scrubbed = subEnv.subprocessEnv()
  check('a scrub for other reasons still adds no stamp in an interactive session', scrubbed !== process.env && scrubbed.MERCURY_OAUTH_TOKEN === undefined && scrubbed.PAGER === undefined && scrubbed.GIT_TERMINAL_PROMPT === undefined)
  delete process.env.MERCURY_OAUTH_TOKEN
  state.setIsInteractive(false)
}

section('§5 the stamps ride with the scrubs, never instead of them')
{
  state.setIsInteractive(false)
  process.env.MERCURY_OAUTH_TOKEN = 'a-session-token'
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'bearer x'
  const env = subEnv.subprocessEnv()
  check('the session token and the exporter header are stripped', env.MERCURY_OAUTH_TOKEN === undefined && env.OTEL_EXPORTER_OTLP_HEADERS === undefined)
  check('and the headless stamps are present', env.GIT_TERMINAL_PROMPT === '0' && env.PAGER === 'cat' && env.GIT_PAGER === 'cat')
  delete process.env.MERCURY_OAUTH_TOKEN
  delete process.env.OTEL_EXPORTER_OTLP_HEADERS
}

console.log('\n' + '═'.repeat(76))
console.log(`${failures === 0 ? 'PASS' : 'FAIL'} — prove-headless-child-defaults (${checks} checks, ${failures} failures)`)
process.exit(failures === 0 ? 0 : 1)
