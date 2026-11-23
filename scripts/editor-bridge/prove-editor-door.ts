#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { nodeBinPath } from '../lib/nodeBin.ts'

const args = process.argv.slice(2)
const distAt = args.indexOf('--dist')
const dist = resolve(distAt >= 0 ? args[distAt + 1]! : join(import.meta.dir, '../../dist/mercury.mjs'))
if (!existsSync(dist)) {
  console.error(`FAIL bundle exists: ${dist}`)
  process.exit(1)
}
const NODE = nodeBinPath()
const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-door-')))
const cwd = join(root, 'cwd')
mkdirSync(cwd, { recursive: true })
writeFileSync(
  join(root, '.config.json'),
  JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }),
)
const env = {
  HOME: root,
  PATH: process.env.PATH,
  MERCURY_CONFIG_DIR: root,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DAEMON_DIR: join(root, 'daemon'),
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  TMPDIR: tmpdir(),
}
const OPTION_HINT = 'the root option table must hold no editor option: remove --ide and --editor-link from the root command so an unknown option takes the parser error path'
const COMMAND_HINT = 'the command table must hold no /ide: remove it so the unknown-command sentence in src/engine/user-input/processSlashCommand.tsx answers it'
const BRIDGE_HINT = 'fix the bridge status output in src/commands/verbs/editorBridge.ts (it must print vsix: and the manual install line when no editor CLI is on the path)'
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`)
  if (!ok) failures++
}
async function run(argv: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(NODE, [dist, ...argv], { cwd, env: { ...env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', data => { out += data })
  child.stderr.on('data', data => { err += data })
  child.stdin.end()
  const timeout = setTimeout(() => child.kill('SIGKILL'), 120_000)
  return await new Promise(resolvePromise => child.on('close', code => { clearTimeout(timeout); resolvePromise({ code, out, err }) }))
}

try {
  console.log('§1 the root option table')
  const control = await run(['--frobnicate', '--version'])
  check('an unknown root option is a parser error on stderr and nothing starts', control.code !== 0 && control.out === '' && control.err.startsWith("error: unknown option '--frobnicate'"), `an unknown root option must fail in the parser before anything starts; got ${JSON.stringify(control)}`)
  const hint = await run(['--chats', '--version'])
  const hintLine = hint.err.split('\n')[1] ?? ''
  check('a near-miss unknown option carries the parser\'s own one-line hint and nothing else', hint.code === control.code && hint.out === '' && hint.err.split('\n')[0] === control.err.split('\n')[0]!.replaceAll('--frobnicate', '--chats') && /^\(Did you mean --[a-z-]+\?\)$/.test(hintLine) && hint.err.split('\n').slice(2).join('') === '', `the parser error for a near-miss must be the first line plus one Did you mean line and nothing else; got ${JSON.stringify(hint)}`)
  for (const flag of ['--ide', '--editor-link']) {
    const result = await run([flag, '--version'])
    const lines = result.err.split('\n')
    const sameFirstLine = lines[0] === control.err.split('\n')[0]!.replaceAll('--frobnicate', flag)
    const restIsTheHint = lines.slice(1).join('\n') === '' || (/^\(Did you mean --[a-z-]+\?\)$/.test(lines[1] ?? '') && lines.slice(2).join('') === '')
    check(`${flag} takes the ordinary unknown-option path`, result.code === control.code && result.out === '' && sameFirstLine && restIsTheHint, `${OPTION_HINT}; got ${JSON.stringify(result)}`)
  }

  console.log('§2 the command table')
  const unknown = await run(['run', '/frobnicate'])
  check('an unknown slash command through run is refused with the cockpit\'s sentence on stderr and exit 1', unknown.code === 1 && unknown.out === '' && unknown.err.trim() === 'Unknown command: /frobnicate · /help lists commands', `fix the unknown-command sentence in src/engine/user-input/processSlashCommand.tsx or the run verb that prints it; got ${JSON.stringify(unknown)}`)
  const ide = await run(['run', '/ide'])
  const sansPointer = (text: string): string => text.replace(/ — closest: \/[\w:-]+/, '')
  check('/ide answers exactly as any unknown command does', ide.code === unknown.code && ide.out === unknown.out && sansPointer(ide.err) === unknown.err.replaceAll('frobnicate', 'ide'), `${COMMAND_HINT}; got ${JSON.stringify(ide)}`)

  console.log('§3 the door that stands')
  const status = await run(['bridge', 'status'], { PATH: '/usr/bin:/bin' })
  check('mercury bridge status answers from the bundle (no editor CLI on the path — the manual road)', status.code === 0 && status.out.includes('vsix:') && status.out.includes('manual install'), `${BRIDGE_HINT}; got ${JSON.stringify(status)}`)
  check('the ACP server module is product', existsSync(join(import.meta.dir, '../../src/integrations/acp/acpServer.ts')), 'restore src/integrations/acp/acpServer.ts, the ACP server module the editor door depends on')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('')
if (failures > 0) {
  console.error(`✗ ${failures} failure(s)`)
  process.exit(1)
}
console.log('✓ editor door proofs green')
process.exit(0)
