#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi } from '../lib/fixtureApi.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at >= 0 ? process.argv[at + 1]! : join(import.meta.dir, '../../dist/mercury.mjs'))
const KEY = 'fixture-key-lean-stamp'
const ASK = 'printenv MERCURY_BARE || echo the-flag-is-unset'
const RUN_HINT = 'the run did not finish with done: check dist is built and that src/boot/entrypoints/cli.tsx and the Bash tool answer under mercury run --lean. '
const SCRUB_HINT = 'the flag stamped by --lean in src/boot/entrypoints/cli.tsx must be scrubbed from a shell child by sessionEnvStamps and scrubSessionEnvStamps in src/platform/substrate/envStamps.ts, and named in the notice from src/tools/kit/sessionEnvNotice.ts. '
const KEEP_HINT = 'an operator-set MERCURY_BARE must stay inherited and unnamed: see sessionEnvStamps in src/platform/substrate/envStamps.ts. '

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
  if (!ok) failures++
}
type Body = { messages?: Array<{ role: string; content: unknown }> }
const toolResults = (body: Body | undefined): string =>
  JSON.stringify((body?.messages ?? []).flatMap(m => (Array.isArray(m.content) ? (m.content as Array<{ type: string; content?: unknown }>).filter(b => b.type === 'tool_result').map(b => b.content) : [])))

async function shellChildSees(argv: string[], extra: Record<string, string>): Promise<{ code: number | null; out: string; result: string; requests: number }> {
  const home = mkdtempSync(join(tmpdir(), 'lean-stamp-'))
  const api = await startFixtureApi([
    { kind: 'tool_use', name: 'Bash', input: { command: ASK, description: 'Read the flag' } },
    { kind: 'text', text: 'done' },
  ])
  const env = { HOME: home, PATH: process.env.PATH, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: api.url, TMPDIR: tmpdir(), NO_COLOR: '1', ...extra }
  writeFileSync(join(home, '.config.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', customApiKeyResponses: { approved: [KEY.slice(-20)] }, projects: { [home]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }))
  try {
    const child = spawn('node', [dist, 'run', 'read the flag', ...argv, '--ephemeral', '--sovereign'], { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => {})
    child.stdin.end()
    const clock = setTimeout(() => child.kill('SIGKILL'), 120_000)
    const code = await new Promise<number | null>((resolveRun, reject) => {
      child.on('error', error => { clearTimeout(clock); reject(error) })
      child.on('close', closed => { clearTimeout(clock); resolveRun(closed) })
    })
    const requests = api.messageRequests()
    return { code, out, result: toolResults(requests[1]?.body as Body | undefined), requests: requests.length }
  } finally {
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}

console.log('§1 under --lean the flag is the session\'s own stamp: the session reads it and a shell child does not')
const lean = await shellChildSees(['--lean'], {})
check('the run answered', lean.code === 0 && lean.out.trim() === 'done', RUN_HINT + JSON.stringify({ code: lean.code, out: lean.out.slice(0, 120), requests: lean.requests }))
check('the shell child of a --lean session finds the flag unset: the session set it, so it is scrubbed', lean.result.includes('the-flag-is-unset'), SCRUB_HINT + lean.result)
const stamps = (result: string): string => /session env scrubbed: ([^—\]]*)/.exec(result)?.[1] ?? ''
check("the product names the flag among the session's own stamps it scrubbed", /(^|[ ,])MERCURY_BARE([ ,]|$)/.test(stamps(lean.result)), SCRUB_HINT + lean.result)

console.log('§2 set by the operator, the same flag is inherited: the shell child reads the operator\'s value')
const inherited = await shellChildSees([], { MERCURY_BARE: '1' })
check('the run answered', inherited.code === 0 && inherited.out.trim() === 'done', RUN_HINT + JSON.stringify({ code: inherited.code, out: inherited.out.slice(0, 120), requests: inherited.requests }))
check('the shell child reads 1 and is not told the flag is unset', !inherited.result.includes('the-flag-is-unset') && /(^|[^0-9])1([^0-9]|$)/.test(inherited.result), KEEP_HINT + inherited.result)
check("the product does not name the operator's flag among the session's own stamps", !stamps(inherited.result).includes('MERCURY_BARE'), KEEP_HINT + inherited.result)

console.log(`\nprove-lean-is-the-sessions-stamp: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
