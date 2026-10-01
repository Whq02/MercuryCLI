#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspectSessionArgs, readSessionOption } from '../../src/cli/sessionArgs.ts'

const unknownInputs = [
  ['--debug', '-to-stderr'], ['--d', '2e'], ['-d', '2e'], ['--debug', '-file'], ['--ba', 're'],
  ['--in', 'it'], ['--in', 'it-only'], ['--main', 'tenance'], ['--json', '-schema'], ['--think', 'ing'],
  ['--max-budget', '-usd'], ['--too', 'ls'], ['--disallowed', '-tools'], ['--mcp', '-config'], ['--strict-mcp', '-config'],
  ['--system', '-prompt'], ['--system', '-prompt-file'], ['--append-system', '-prompt'], ['--append-system', '-prompt-file'],
  ['--fork', '-session'], ['--from', '-pr'], ['--pre', 'fill'], ['--no-session', '-persistence'], ['--resume-session', '-at'],
  ['--rewind', '-files'], ['--be', 'tas'], ['--fallback', '-model'], ['--work', 'load'], ['--project', '-root'],
  ['--set', 'tings'], ['--i', 'de'], ['--na', 'me'], ['-', 'n'], ['--agen', 'ts'], ['--setting', '-sources'],
  ['--disable-slash', '-commands'], ['--t', 'mux'], ['--agent', '-id'], ['--agent', '-name'], ['--crew', '-name'],
  ['--agent', '-color'], ['--parent-session', '-id'], ['--agent', '-type'], ['--strategy-mode', '-required'],
].map(parts => parts.join(''))
import { startFixtureApi } from '../lib/fixtureApi.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at >= 0 ? process.argv[at + 1]! : join(import.meta.dir, '../../dist/mercury.mjs'))
const home = mkdtempSync(join(tmpdir(), 'session-words-'))
const api = await startFixtureApi(Array.from({ length: 8 }, () => ({ kind: 'text' as const, text: 'The words answered.' })))
const env = { HOME: home, PATH: process.env.PATH, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: 'fixture-key-session-words', ANTHROPIC_BASE_URL: api.url, TMPDIR: tmpdir(), NO_COLOR: '1' }
writeFileSync(join(home, '.config.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: ['fixture-key-session-words'.slice(-20)] }, projects: { [home]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`)
  if (!ok) failures++
}
async function run(argv: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn('node', [dist, ...argv], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', data => { out += data })
  child.stderr.on('data', data => { err += data })
  child.stdin.on('error', () => {})
  child.stdin.end()
  const clock = setTimeout(() => child.kill('SIGKILL'), 120_000)
  return new Promise((resolve, reject) => {
    child.on('error', error => { clearTimeout(clock); reject(error) })
    child.on('close', code => { clearTimeout(clock); resolve({ code, out, err }) })
  })
}
try {
  const unknown = await run(['run', '--frobnicate'])
  check('unknown options use the parser error', unknown.code !== 0 && unknown.out === '' && unknown.err.startsWith("error: unknown option '--frobnicate'"), JSON.stringify(unknown))
  for (const input of unknownInputs) {
    for (const form of [input, `${input}=shape`]) {
      const result = await run(['run', form])
      const normalize = (text: string) => text.split('\n')[0]?.replace(/'[^']*'/g, "'<option>'")
      const same = normalize(result.err) === normalize(unknown.err)
      check('an unregistered option has the ordinary parser result', result.code === unknown.code && result.out === unknown.out && same && !result.err.includes('Use mercury') && !result.err.includes('Use --'), JSON.stringify(result))
    }
    check('a required brief value is not an option', readSessionOption(['run', '--brief', input, 'hello'], input).present === false)
    check('a delimiter operand is not an option', readSessionOption(['run', '--', input], input).present === false)
  }
  const joined = await run(['run', '-nshape'])
  check('an unregistered short option has the parser result', joined.code === unknown.code && joined.out === '' && joined.err.startsWith("error: unknown option '-n"), JSON.stringify(joined))
  for (const [input, word] of [
    ['agents', 'roster'], ['daemon', 'steward'], ['show', 'image'], ['editor', 'bridge'],
    ['mcp add-json', 'mcp import'], ['mcp reset-project-choices', 'mcp trust-reset'], ['auth token', 'auth mint'],
    ['extensions check', 'extensions refresh'], ['extensions approve', 'extensions trust'], ['extensions block', 'extensions fence'],
    ['extensions unblock', 'extensions unfence'], ['extensions validate', 'extensions inspect'], ['extensions init', 'extensions scaffold'],
  ]) {
    const parts = input!.split(' ')
    const result = await run([...parts, '--help'])
    const control = await run([...parts.slice(0, -1), 'frobnicate', '--help'])
    check(`${word} is the registered command`, result.code === control.code && result.out === control.out && result.err.replaceAll(parts.at(-1)!, 'frobnicate') === control.err, JSON.stringify(result))
    const help = await run([...word!.split(' '), '--help'])
    check(`${word} serves its command help`, help.code === 0 && (help.out.includes(`Usage: mercury ${word}`) || (word === 'steward' && help.out.includes('usage: mercury steward'))), JSON.stringify(help))
  }
  const help = await run(['run', '--help'])
  for (const word of ['--log-file', '--lean', '--schema', '--budget', '--toolset', '--block-tools', '--mcp', '--only-mcp', '--brief', '--brief-add', '--fork', '--pr', '--ephemeral', '--provider-preview', '--backup-model', '--project', '--config', '--editor-link', '--title', '--agent-defs', '--config-layers', '--no-commands', '--multiplex']) {
    check(`${word} appears in the run grammar`, help.code === 0 && help.out.includes(word))
  }
  check('advisor help describes a run', help.out.includes('for this run at birth') && !help.out.includes('print run'))
  for (const [flag, value] of [['--reasoning-mode', 'disabled'], ['--budget', '2'], ['--schema', '{}'], ['--draft', 'x'], ['--replay-to', 'id'], ['--restore-files', 'id'], ['--backup-model', 'fixture'], ['--meter-tag', 'job'], ['--title', 'name'], ['--agent-defs', '{}'], ['--seat-id', 'id'], ['--seat', 'name'], ['--crew', 'name'], ['--seat-color', 'blue'], ['--parent', 'id'], ['--role', 'worker']]) {
    const parsed = await run(['run', flag!, value!, '--help'])
    check(`${flag} is accepted by the parser`, parsed.code === 0 && parsed.out.includes('Usage: mercury run'), JSON.stringify(parsed))
  }
  const rowInput = inspectSessionArgs(['--brief', 'instructions', 'run', '--format=rows', '--input', 'rows'])
  check('row input preserves the preflight signal boundary', rowInput.command === 'run' && rowInput.format === 'rows' && rowInput.input === 'rows' && !rowInput.outputRequest)
  check('help suppresses preflight result rows', inspectSessionArgs(['--brief-file', 'file', 'run', '--format', 'rows', '--help']).outputRequest)
  check('help-shaped brief text does not suppress result rows', !inspectSessionArgs(['run', '--brief', '--help', '--format', 'rows']).outputRequest)
  check('help after the option boundary stays prompt text', !inspectSessionArgs(['run', '--format', 'rows', '--', '--help']).outputRequest)
  check('prototype words are operands', inspectSessionArgs(['run', 'constructor']).command === 'run')
  check('standard session identity and effort stay admitted', inspectSessionArgs(['run', '--session-id', 'id', '--effort', 'max', 'hello']).command === 'run')
  check('repeated value options use the last occurrence', readSessionOption(['--log-file', 'first', '--log-file=second'], '--log-file').value === 'second')
  for (const flag of ['--config', '--config-layers', '--log-file', '--lean', '--prepare-only', '--multiplex']) check('a boot option inside a brief is only its value', !readSessionOption(['--brief', flag, 'run'], flag).present)
  const briefFile = join(home, 'brief.txt')
  const appendFile = join(home, 'append.txt')
  writeFileSync(briefFile, 'The file brief marker.')
  writeFileSync(appendFile, 'The appended file marker.')
  const answer = await run(['run', 'hello', '--lean', '--brief-file', briefFile, '--brief-add-file', appendFile, '--config', '{"effortLevel":"high"}', '--config-layers', 'user', '--title', 'Words', '--ephemeral', '--toolset', 'Read', '--block-tools', 'Write', '--only-mcp', '--mcp', '{"mcpServers":{}}', '--budget', '100', '--reasoning-mode', 'disabled', '--log-file', join(home, 'debug.log')])
  check('session words reach the real run', answer.code === 0 && answer.out.trim() === 'The words answered.', JSON.stringify(answer))
  const request = JSON.stringify(api.messageRequests().at(-1)?.body)
  check('both file briefs reach the fixture request', request.includes('The file brief marker.') && request.includes('The appended file marker.'), request)
  for (const value of [unknownInputs[0]!, '--config', '--config-layers', '--log-file']) {
    const raw = await run(['run', '--brief', value, 'literal', '--lean', '--ephemeral'])
    check('a flag-shaped brief reaches the fixture unchanged', raw.code === 0 && JSON.stringify(api.messageRequests().at(-1)?.body).includes(value), JSON.stringify(raw))
  }
  const project = await run(['--project', home, 'run', '--help'])
  check('project is resolved before the run grammar', project.code === 0 && project.out.includes('Usage: mercury run'), JSON.stringify(project))
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
console.log(`session words: ${failures === 0 ? 'all green' : `${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
