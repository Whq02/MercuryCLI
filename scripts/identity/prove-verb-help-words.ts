#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('  [FAIL] dist/mercury.mjs missing — run bun run build.ts first')
  process.exit(1)
}
const HOME = mkdtempSync(join(tmpdir(), 'verb-help-words-'))
const env = {
  ...process.env,
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
}
delete (env as Record<string, string | undefined>).MERCURY_HOME

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const mercury = (...args: string[]): { rc: number; out: string; err: string } => {
  const r = spawnSync('node', [DIST, ...args], { env, encoding: 'utf8', timeout: 60_000 })
  return { rc: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' }
}
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')
const helpLine = (help: string, verb: string): string => {
  const lines = help.split('\n')
  const start = lines.findIndex(l => new RegExp(`^\\s+${verb.replace(/[[\]<>|]/g, m => `\\${m}`)}(\\s|$)`).test(l))
  if (start < 0) return ''
  const column = lines[start]!.search(/\S/)
  const entry = [lines[start]!]
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '' || line.search(/\S/) <= column) break
    entry.push(line.trim())
  }
  return entry.join(' ').replace(/\s+/g, ' ')
}

console.log('§1 the root help describes each verb by what it does')
{
  const help = mercury('--help')
  check('mercury --help exits 0', help.rc === 0, `${help.rc} ${help.err.slice(0, 120)}`)
  check('acp: serves an editor over the Agent Client Protocol on stdio', /Serve an editor over the Agent Client Protocol on stdio/.test(helpLine(help.out, 'acp')), helpLine(help.out, 'acp'))
  check('daemon: the background daemon with its four verbs, restart among them', /The background daemon: run \| status \| stop \| restart/.test(helpLine(help.out, 'daemon [subcommand]')), helpLine(help.out, 'daemon [subcommand]'))
  check('bridge: installs, checks or removes the VS Code extension', /Install, check or remove the VS Code extension: install \| status \| uninstall/.test(helpLine(help.out, 'bridge <action>')), helpLine(help.out, 'bridge <action>'))
  check('no verb is described by a build detail', !/launcher fast path/.test(help.out))
  check('no verb is described by the editor link that is gone', !/\bIDE\b/.test(help.out), help.out.split('\n').filter(l => /\bIDE\b/.test(l)).join(' | '))
}

console.log('§2 the verbs\' own doors agree with the root help')
{
  const acp = mercury('acp', '--help')
  check('mercury acp --help says the same sentence', acp.rc === 0 && /Serve an editor over the Agent Client Protocol on stdio\./.test(acp.out), `${acp.rc} ${acp.out.slice(0, 120)}`)
  const bridge = mercury('bridge', 'frobnicate')
  check('mercury bridge <unknown> names the same three actions and exits 2', bridge.rc === 2 && /install \| status \| uninstall/.test(bridge.err + bridge.out), `${bridge.rc} ${(bridge.err + bridge.out).slice(0, 160)}`)
  const daemon = mercury('daemon', '--help')
  check('mercury daemon --help lists restart', /restart/.test(daemon.out + daemon.err), (daemon.out + daemon.err).slice(0, 200))
  const upgrade = mercury('--upgrade', '--check')
  check('--upgrade is an unknown option (the verb is mercury update|upgrade)', upgrade.rc !== 0 && /error: unknown option '--upgrade'/.test(upgrade.err), `${upgrade.rc} ${upgrade.err.slice(0, 120)}`)
  const update = mercury('--update')
  check('--update is an unknown option too', update.rc !== 0 && /error: unknown option '--update'/.test(update.err), `${update.rc} ${update.err.slice(0, 120)}`)
}

console.log('§3 the pages teach the verbs as the product has them')
{
  const readme = read('README.md')
  check('README names mercury daemon run|status|stop|restart', /`mercury daemon run\|status\|stop\|restart`/.test(readme))
  const runtime = read('docs/TERMINAL-RUNTIME.md')
  check('TERMINAL-RUNTIME.md teaches mercury daemon restart', /`mercury daemon restart`/.test(runtime))
  check('TERMINAL-RUNTIME.md teaches no --update or --upgrade flag', !/`--update`|`--upgrade`|--update\/--upgrade/.test(runtime), runtime.split('\n').filter(l => /--update|--upgrade/.test(l)).join(' | '))
  check('TERMINAL-RUNTIME.md calls a headless run a run, not a kind of print', !/\bprint, help and version runs\b/.test(runtime) && /`run`, help and version runs/.test(runtime))
  const trust = read('docs/TRUST.md')
  check('TRUST.md names the session kinds without a print kind', !/\bprint sessions\b/.test(trust) && /headless `run`/.test(trust), trust.split('\n').filter(l => /sessions alike/.test(l)).join(' | '))
  const sessions = read('docs/SESSIONS.md')
  check('SESSIONS.md says a local store from before is read once and moved', /read once and moved on its/.test(sessions) && !/\bmigrated\b/.test(sessions), sessions.split('\n').filter(l => /migrat/.test(l)).join(' | '))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-verb-help-words: ALL LAWS HOLD' : `\nprove-verb-help-words: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
