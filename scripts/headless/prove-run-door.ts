#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'

const args = process.argv.slice(2)
const distAt = args.indexOf('--dist')
const dist = resolve(distAt >= 0 ? args[distAt + 1]! : join(import.meta.dir, '../../dist/mercury.mjs'))
if (!existsSync(dist)) {
  console.error(`FAIL run bundle exists: ${dist}`)
  process.exit(1)
}
const root = realpathSync(mkdtempSync(join(tmpdir(), 'run-door-')))
const api = await startFixtureApi(Array.from({ length: 24 }, () => ({ kind: 'text' as const, text: 'The run answered.' })))
const env = {
  HOME: root,
  PATH: process.env.PATH,
  MERCURY_CONFIG_DIR: root,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_DAEMON_DIR: join(root, 'daemon'),
  ANTHROPIC_BASE_URL: api.url,
  ANTHROPIC_API_KEY: 'fixture-key-run-door',
  TMPDIR: tmpdir(),
}
writeFileSync(join(root, '.config.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: ['fixture-key-run-door'.slice(-20)] }, projects: { [root]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
const uidPreload = join(root, 'uid.cjs')
writeFileSync(uidPreload, 'if (process.env.PROOF_UID !== undefined) process.getuid = () => Number(process.env.PROOF_UID)\n')
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`)
  if (!ok) failures++
}
async function run(argv: string[], input = '', stdin: 'close' | 'open' | 'late' = 'close', uid?: number): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn('node', ['--require', uidPreload, dist, ...argv], { cwd: root, env: { ...env, ...(uid === undefined ? {} : { PROOF_UID: String(uid) }) }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', data => { out += data; if (stdin === 'open') child.stdin.end() })
  child.stderr.on('data', data => { err += data })
  child.stdin.on('error', () => {})
  if (stdin === 'open' && input) child.stdin.write(input)
  if (stdin === 'late') setTimeout(() => child.stdin.end(input), 4_000)
  else if (stdin === 'close') child.stdin.end(input)
  const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000)
  return await new Promise(resolve => child.on('close', code => { clearTimeout(timeout); resolve({ code, out, err }) }))
}
try {
  const flags = ['-p', '--print', '--output-format', '--input-format', '--include-partial-messages', '--dangerously-bypass-permissions', '--allow-dangerously-bypass-permissions', '--permission-mode']
  for (const prefix of [[], ['run'], ['run', '--format', 'rows']]) {
    const control = await run([...prefix, '--frobnicate', 'hello'])
    check('an unknown option is a parser error on stderr', control.code !== 0 && control.out === '' && control.err.startsWith("error: unknown option '--frobnicate'"), JSON.stringify(control))
    for (const flag of flags) {
      const result = await run([...prefix, flag, 'hello'])
      check(`${flag} follows the ordinary unknown-option path`, result.code === control.code && result.out === '' && result.err === control.err.replaceAll('--frobnicate', flag), JSON.stringify(result))
    }
  }
  const beforeRefusals = api.messageRequests().length
  for (const mode of ['default', 'implement', 'flow', 'dontAsk', 'strategy']) {
    const result = await run(['run', 'hello', '--sovereign', '--mode', mode])
    check(`sovereign refuses the conflicting ${mode} posture`, result.code === 2 && result.out === '' && result.err.trim().split('\n').length === 1 && result.err.includes('--sovereign') && result.err.includes('--mode'), JSON.stringify(result))
  }
  const policy = await run(['run', 'hello', '--sovereign', '--config', JSON.stringify({ guardrails: { disableSovereignMode: true } })])
  check('the permissions policy refuses sovereign rather than changing its posture', policy.code === 2 && policy.out === '' && /policy/i.test(policy.err) && policy.err.trim().split('\n').length === 1, JSON.stringify(policy))
  const apollo = await run(['run', 'hello', '--mode', 'apollo'])
  check('apollo without a channel refuses with its reason', apollo.code === 2 && apollo.out === '' && /apollo.*channel/.test(apollo.err), JSON.stringify(apollo))
  check('permission refusals make no model requests', api.messageRequests().length === beforeRefusals)
  const help = await run(['run', '--help'])
  check('run help names its prompt and formats', help.code === 0 && /run.*\[prompt\]/.test(help.out) && help.out.includes('--format') && help.out.includes('rows') && !flags.some(flag => flag.startsWith('--') && help.out.includes(flag)), JSON.stringify(help))
  const empty = await run(['run'])
  check('run with empty input exits 2 without an answer', empty.code === 2 && empty.out === '' && /mercury run/.test(empty.err), JSON.stringify(empty))
  for (const format of ['text', 'json', 'rows']) {
    const result = await run(['run', 'hello', '--format', format])
    check(`run --format ${format} completes`, result.code === 0, JSON.stringify(result))
    if (format === 'text') check('text is the answer only', result.out.trim() === 'The run answered.', result.out)
    else {
      let rows: Array<Record<string, unknown>> = []
      try { rows = format === 'json' ? [JSON.parse(result.out)] : result.out.trim().split('\n').map(line => JSON.parse(line)) } catch {}
      const outcome = rows.find(row => row.type === 'result')
      check(`${format} carries the result fields`, outcome?.is_error === false && outcome.result === 'The run answered.' && typeof outcome.session_id === 'string' && typeof outcome.total_cost_usd === 'number', result.out)
      if (format === 'rows') check('rows carries init and assistant events', rows.some(row => row.type === 'system' && row.subtype === 'init') && rows.some(row => row.type === 'assistant'), result.out)
    }
  }
  for (const argv of [['run'], ['run', '-'], ['run', 'instruction']]) {
    const result = await run(argv, 'piped context')
    check(`${argv.join(' ')} accepts piped text`, result.code === 0 && result.out.trim() === 'The run answered.', JSON.stringify(result))
  }
  const measureStart = async (input: string, stdin: 'close' | 'open') => {
    const began = performance.now()
    let startMs: number | null = null
    void api.messageRequestStarted(api.messageRequests().length + 1).then(() => { startMs = performance.now() - began })
    const result = await run(['run', 'hello'], input, stdin)
    return { ...result, startMs: startMs as number | null }
  }
  const closed = await measureStart('', 'close')
  for (const input of ['', 'context on a held pipe']) {
    const open = await measureStart(input, 'open')
    check('a prompt argument starts while its input pipe stays open', open.code === 0 && open.out.trim() === 'The run answered.' && open.startMs !== null && closed.startMs !== null && open.startMs - closed.startMs < 1_200, JSON.stringify({ closedMs: closed.startMs, ...open }))
    console.log(`run start: closed=${closed.startMs}ms held=${open.startMs}ms inputBytes=${input.length}`)
    const request = JSON.stringify(api.messageRequests().at(-1)?.body)
    if (input) check('piped context is delimited after the argument', request.includes('hello\\n\\n<stdin>\\ncontext on a held pipe\\n</stdin>'), request)
  }
  const late = await run(['run', '-'], 'late input', 'late')
  check('explicit stdin waits for the prompt producer', late.code === 0 && late.out.trim() === 'The run answered.' && !late.err.includes('No stdin'), JSON.stringify(late))
  const literal = await run(['run', '--', '--print'])
  check('the option boundary admits literal prompt text', literal.code === 0, JSON.stringify(literal))
  const value = await run(['run', '--brief', '--print', 'hello'])
  check('a required option value is not an option', value.code === 0, JSON.stringify(value))
  const named = await run(['run', 'constructor'])
  check('ordinary object-property words stay prompt text', named.code === 0, JSON.stringify(named))
  const mcpText = await run(['run', 'mcp'], 'piped marker')
  check('a command-shaped prompt still carries its piped context', mcpText.code === 0 && JSON.stringify(api.messageRequests().at(-1)?.body).includes('piped marker'), JSON.stringify(mcpText))
  const input = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello rows' } }) + '\n'
  const rowsResult = await run(['run', '--input', 'rows', '--format', 'rows', '--partial'], input)
  let rows: Array<Record<string, unknown>> = []
  try { rows = rowsResult.out.trim().split('\n').map(line => JSON.parse(line)) } catch {}
  check('input rows completes through the event feed', rowsResult.code === 0 && rows.some(row => row.type === 'result' && row.is_error === false), JSON.stringify(rowsResult))
  check('partial includes stream events', rows.some(row => row.type === 'stream_event'), rowsResult.out)
  const mode = await run(['run', 'hello', '--mode', 'flow', '--allow-sovereign', '--format', 'json'])
  check('run accepts the mode and availability switches', mode.code === 0, JSON.stringify(mode))
  const sovereign = await run(['run', 'hello', '--sovereign'])
  check('run accepts sovereign', sovereign.code === 0, JSON.stringify(sovereign))
  const rootRun = await run(['run', 'hello', '--sovereign'], '', 'close', 0)
  const notice = 'Running as root in sovereign mode: the agent can change any file on this machine without asking.'
  check('root sovereign runs with one notice on stderr', rootRun.code === 0 && rootRun.out.trim() === 'The run answered.' && rootRun.err.trim() === notice, JSON.stringify(rootRun))
  const rootMode = await run(['run', 'hello', '--mode', 'sovereign'], '', 'close', 0)
  check('root sovereign selected by mode has the same notice and result', rootMode.code === 0 && rootMode.out.trim() === 'The run answered.' && rootMode.err.trim() === notice, JSON.stringify(rootMode))
  const userRun = await run(['run', 'hello', '--sovereign'], '', 'close', 1000)
  check('sovereign as a normal user has no root notice', userRun.code === 0 && !userRun.err.includes(notice), JSON.stringify(userRun))
  const rootDefault = await run(['run', 'hello', '--allow-sovereign'], '', 'close', 0)
  check('availability without sovereign has no root notice', rootDefault.code === 0 && !rootDefault.err.includes(notice), JSON.stringify(rootDefault))
} finally {
  await api.close()
  rmSync(root, { recursive: true, force: true })
}
console.log(`run door: ${failures === 0 ? 'all green' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
