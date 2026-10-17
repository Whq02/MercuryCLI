#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, handoffTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
const j = (value: unknown): string => JSON.stringify(value)?.slice(0, 500) ?? ''

const home = realpathSync(mkdtempSync(join(tmpdir(), 'run-door-defects-')))
const cwd = join(home, 'project')
mkdirSync(cwd, { recursive: true })
seedFirstRun(home, [cwd])
const say = (text: string): ScriptedTurn => ({ kind: 'text', text })
const api = await startFixtureApi([say('OK'), handoffTurn(), say('7421'), handoffTurn(), say('7422'), handoffTurn(), say('7421 again'), handoffTurn()])
const env = {
  HOME: home, PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: api.url,
}
type Run = { code: number | null; out: string; err: string; rows: Array<Record<string, unknown>> }
const run = (args: string[]): Promise<Run> => new Promise(done => {
  const child = spawn('node', [dist, 'run', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', d => { out += String(d) })
  child.stderr.on('data', d => { err += String(d) })
  const guard = setTimeout(() => child.kill('SIGKILL'), 120_000)
  child.on('close', code => {
    clearTimeout(guard)
    const rows = out.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } }).filter((row): row is Record<string, unknown> => row !== null)
    done({ code, out, err, rows })
  })
})
const outcomeOf = (r: Run): Record<string, unknown> | undefined => r.rows.filter(row => row.type === 'outcome').at(-1)
const turnsOf = (r: Run): number[] => [...new Set(r.rows.filter(row => typeof row.turn === 'number').map(row => row.turn as number))]

try {
  console.log('§1 RUN-11 — a prompt the parser mistakes for an option gets the way out; --debug says when it ate the prompt')
  {
    const neg = await run(['--format', 'rows', '-1 is a negative number. Reply with exactly: NEG'])
    const lines = neg.err.trim().split('\n')
    check('a prompt beginning with - is still the parser\'s unknown-option error: exit 2, nothing on stdout', neg.code === 2 && neg.out === '' && lines[0]!.startsWith("error: unknown option '-1 is a negative number"), j({ code: neg.code, out: neg.out.slice(0, 80), err: neg.err.slice(0, 200) }))
    check('…followed by one line that says what it looks like and how to pass it: mercury run -- "…"', lines.length === 2 && /looks like a prompt that begins with "-"/.test(lines[1]!) && lines[1]!.includes('run -- "-1 is a negative number. Reply with exactly: NEG"'), neg.err.slice(0, 400))
    const dashes = await run(['--format', 'rows', '--help me understand git'])
    check('the same for a prompt that begins with --', dashes.code === 2 && dashes.out === '' && /run -- "--help me understand git"/.test(dashes.err), dashes.err.slice(0, 300))
    const control = await run(['--format', 'rows', '--frobnicate', 'hello'])
    check('control: a one-word unknown option is a plain parser error, no hint (the run-door seal\'s law stands)', control.code === 2 && control.out === '' && control.err.trim().split('\n').every(line => !/looks like a prompt/.test(line)) && control.err.startsWith("error: unknown option '--frobnicate'"), control.err.slice(0, 300))
    const eaten = await run(['--format', 'rows', '--debug', 'Reply with exactly: DBG'])
    const eatenOutcome = outcomeOf(eaten)
    check('--debug "prompt" is refused saying --debug took the words as its filter and how to pass the prompt', eaten.code === 2 && eatenOutcome?.status === 'refused' && /--debug took "Reply with exactly: DBG" as its category filter/.test(String((eatenOutcome?.error as { message?: string } | undefined)?.message)) && /Put the prompt before --debug, or use -d/.test(String((eatenOutcome?.error as { message?: string } | undefined)?.message)), j({ code: eaten.code, outcome: eatenOutcome }))
    const plain = await run(['--format', 'rows', '--debug'])
    check('control: a bare --debug with no prompt keeps the plain usage line', plain.code === 2 && /Usage: mercury run "<prompt>"/.test(String((outcomeOf(plain)?.error as { message?: string } | undefined)?.message)), j(outcomeOf(plain)))
  }

  console.log('§2 RUN-10 — the help says who can run apollo, and the refusal names the runner door')
  {
    const help = spawnSync('node', [dist, 'run', '--help'], { cwd, env, encoding: 'utf8' })
    const words = (help.stdout ?? '').replace(/\s+/g, ' ')
    check('run --help says apollo needs someone to answer its asks (the cockpit, or a host over mercury runner) and that run alone refuses it', /apollo requires the cockpit or a host serving the session over mercury runner; mercury run alone refuses it/.test(words), words.slice(words.indexOf('apollo'), words.indexOf('apollo') + 300))
    const apollo = await run(['--format', 'rows', '--mode', 'apollo', 'hello'])
    const message = String((outcomeOf(apollo)?.error as { message?: string } | undefined)?.message ?? '')
    check('run --mode apollo is refused (exit 2) naming the runner door\'s help and the cockpit', apollo.code === 2 && outcomeOf(apollo)?.status === 'refused' && /apollo needs a host that answers its asks/.test(message) && /mercury runner --help/.test(message) && /cockpit/.test(message), j({ code: apollo.code, message }))
  }

  console.log('§3 RUN-12 — a continued, resumed or forked run numbers its turn after the session\'s earlier turns')
  {
    const first = await run(['--format', 'rows', 'Remember this secret number: 7421. Reply with only OK.'])
    const sessionId = String(first.rows.find(row => row.type === 'session')?.session_id ?? '')
    check('the first run is turn 1', first.code === 0 && turnsOf(first).join(',') === '1', j({ code: first.code, turns: turnsOf(first), err: first.err.slice(0, 200) }))
    const continued = await run(['--format', 'rows', '--continue', 'What secret number did I ask you to remember?'])
    check('--continue keeps the session id and numbers its turn 2', continued.code === 0 && String(continued.rows.find(row => row.type === 'session')?.session_id) === sessionId && turnsOf(continued).join(',') === '2', j({ code: continued.code, turns: turnsOf(continued), err: continued.err.slice(0, 200) }))
    const resumed = await run(['--format', 'rows', '--resume', sessionId, 'Add 1 to the secret number.'])
    check('--resume <id> numbers its turn 3', resumed.code === 0 && turnsOf(resumed).join(',') === '3', j({ code: resumed.code, turns: turnsOf(resumed), err: resumed.err.slice(0, 200) }))
    const forked = await run(['--format', 'rows', '--resume', sessionId, '--fork', 'What was the secret number?'])
    const forkSession = forked.rows.find(row => row.type === 'session') as { session_id?: string; resume_of?: string } | undefined
    check('--fork is a new session id that names the one it forked from, and its turn follows the history it carries (turn 4)', forked.code === 0 && forkSession?.session_id !== undefined && forkSession.session_id !== sessionId && forkSession.resume_of === sessionId && turnsOf(forked).join(',') === '4', j({ code: forked.code, session: forkSession, turns: turnsOf(forked), err: forked.err.slice(0, 200) }))
  }
} finally {
  await api.close()
  rmSync(home, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
