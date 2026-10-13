#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, handoffTurn, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { askNobodyAnswered } from '../../src/services/run/unansweredAsk.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`); if (!ok) failures++ }
const j = (value: unknown): string => JSON.stringify(value)?.slice(0, 400) ?? ''

type Run = { code: number | null; out: string; err: string }
type Outcome = { status?: string; answer?: string; error?: { message?: string; class?: string; detail?: string[] }; denials?: Array<{ tool?: string }> }

function spawnDist(args: string[], cwd: string, env: Record<string, string>, budgetMs: number): Promise<Run> {
  const child = spawn('node', [dist, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', d => { out += String(d) })
  child.stderr.on('data', d => { err += String(d) })
  const guard = setTimeout(() => child.kill('SIGKILL'), budgetMs)
  return new Promise<Run>(done => child.on('close', code => { clearTimeout(guard); done({ code, out, err }) }))
}

async function mercuryRun(args: string[], turns: ScriptedTurn[]): Promise<Run & { outcome: Outcome | undefined; rows: Array<Record<string, unknown>> }> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'exit-truth-')))
  const cwd = join(home, 'project')
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, [cwd])
  const api = await startFixtureApi(turns)
  try {
    const run = await spawnDist(['run', ...args], cwd, {
      HOME: home, PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: api.url,
    }, 120_000)
    const rows = run.out.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as Record<string, unknown> } catch { return null } }).filter((row): row is Record<string, unknown> => row !== null)
    const outcome = rows.filter(row => row.type === 'outcome').at(-1) as Outcome | undefined
    return { ...run, rows, outcome }
  } finally {
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}

const STACK_FRAME = /\n\s+at (?:async )?\S|\.mjs:\d+:\d+/
const writeTurn: ScriptedTurn = { kind: 'tool_use', name: 'Write', input: { file_path: 'made-by-run.txt', content: 'hello\n' } }
const afterRefusal: ScriptedTurn = { kind: 'text', text: 'The write was refused, so the file does not exist.' }

console.log('§1 RUN-03 — an ask nobody could answer ends the turn blocked and exits 1; the operator\'s own deny rule does not')
for (const [label, modeArgs] of [['default mode, no host', []], ['dontAsk mode', ['--mode', 'dontAsk']]] as const) {
  const run = await mercuryRun(['--format', 'rows', ...modeArgs, 'create made-by-run.txt with hello in it'], [writeTurn, afterRefusal, handoffTurn()])
  const outcome = run.outcome
  check(`${label}: the outcome says blocked, not completed`, outcome?.status === 'blocked', j(outcome))
  check(`${label}: the error class is blocked and the message names the refused tool`, outcome?.error?.class === 'blocked' && String(outcome?.error?.message).startsWith('Blocked on the operator: Write'), j(outcome?.error))
  check(`${label}: the resume line names --allowed-tools Write`, (outcome?.error?.detail ?? []).some(line => line.includes('--allowed-tools Write')), j(outcome?.error?.detail))
  check(`${label}: the refused tool is listed in denials`, (outcome?.denials ?? []).some(denial => denial.tool === 'Write'), j(outcome?.denials))
  check(`${label}: the model's answer is kept on the row`, outcome?.answer === afterRefusal.text, j(outcome?.answer))
  check(`${label}: the exit code is 1`, run.code === 1, j({ code: run.code, err: run.err.slice(0, 200) }))
}
{
  const run = await mercuryRun(['--format', 'rows', '--mode', 'sovereign', 'create made-by-run.txt with hello in it', '--block-tools', 'Write(made-by-run.txt)'], [writeTurn, afterRefusal, handoffTurn()])
  const outcome = run.outcome
  const refusedByRule = run.rows.some(row => row.type === 'tool_result' && String(row.output).includes('denied by the rule Write(made-by-run.txt)'))
  check('a deny rule the operator wrote is the operator\'s own answer: the refused write leaves the turn completed', refusedByRule && outcome?.status === 'completed', j(outcome))
  check('…and exits 0', run.code === 0, j({ code: run.code }))
  const rule = { type: 'rule', rule: { source: 'cliArg', ruleBehavior: 'deny', ruleValue: { toolName: 'Write' } } } as never
  check('the boundary, decision by decision: an ask with nobody to answer blocks; a dontAsk refusal blocks; a headless auto-deny blocks; an expired host ask blocks', askNobodyAnswered({ behavior: 'ask', message: '' } as never) && askNobodyAnswered({ behavior: 'deny', message: '', decisionReason: { type: 'mode', mode: 'dontAsk' } } as never) && askNobodyAnswered({ behavior: 'deny', message: '', decisionReason: { type: 'asyncAgent', reason: 'This session cannot present a permission prompt' } } as never) && askNobodyAnswered({ behavior: 'deny', message: '', decisionReason: { type: 'permissionPromptTool', permissionPromptToolName: 'Write' }, unanswered: true } as never))
  check('…a rule, a hook, a host that said no, a safety floor and an allow never block', !askNobodyAnswered({ behavior: 'deny', message: '', decisionReason: rule } as never) && !askNobodyAnswered({ behavior: 'deny', message: '', decisionReason: { type: 'hook', hookName: 'policy' } } as never) && !askNobodyAnswered({ behavior: 'deny', message: '', decisionReason: { type: 'permissionPromptTool', permissionPromptToolName: 'Write', toolResult: { outcome: 'deny' } } } as never) && !askNobodyAnswered({ behavior: 'deny', message: '', decisionReason: { type: 'safetyCheck', reason: 'outside the project', operatorOnly: true } } as never) && !askNobodyAnswered({ behavior: 'allow' } as never) && !askNobodyAnswered(undefined))
}

console.log('§2 UPD-03 — an unknown slash command is refused with the cockpit\'s sentence and exits 1')
{
  const run = await mercuryRun(['--format', 'rows', '/update-notez'], [])
  const outcome = run.outcome
  check('rows: the outcome says refused', outcome?.status === 'refused', j(outcome))
  check('rows: the message is the cockpit\'s unknown-command sentence', String(outcome?.error?.message ?? '').startsWith('Unknown command: /update-notez') && String(outcome?.error?.message).endsWith('/help lists commands'), j(outcome?.error))
  check('rows: never the runner\'s skill spelling', !run.out.includes('Unknown skill'), run.out.slice(0, 300))
  check('rows: the exit code is 1', run.code === 1, j({ code: run.code }))
  const text = await mercuryRun(['--format', 'text', '/update-notez'], [])
  check('text: nothing on stdout, the sentence on stderr, exit 1', text.out === '' && text.err.trim().startsWith('Unknown command: /update-notez') && text.code === 1, j({ code: text.code, out: text.out.slice(0, 120), err: text.err.slice(0, 200) }))
}

console.log('§3 L02a — a model the provider does not serve fails in words, never a JavaScript stack')
{
  const run = await mercuryRun(['--format', 'rows', '--model', 'claude-banana-9', 'say hi'], [])
  const outcome = run.outcome
  check('the run exits 1 with a failed outcome', run.code === 1 && outcome?.status === 'failed', j({ code: run.code, status: outcome?.status }))
  check('the error keeps its words (a message and a one-line detail)', typeof outcome?.error?.message === 'string' && outcome.error.message.length > 0 && (outcome?.error?.detail?.length ?? 0) > 0, j(outcome?.error))
  check('no stack frame or bundle offset rides error.detail', (outcome?.error?.detail ?? []).every(line => !STACK_FRAME.test(line)), j(outcome?.error?.detail))
  check('no stack frame reaches stderr', !STACK_FRAME.test(run.err), run.err.slice(0, 400))
}

console.log('§4 UPD-02 — update --check --json writes its failure document to stdout')
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'exit-truth-upd-')))
  seedFirstRun(home, [home])
  const port = await new Promise<number>((done, fail) => {
    const probe = createServer()
    probe.once('error', fail)
    probe.listen(0, '127.0.0.1', () => { const address = probe.address(); probe.close(() => done(typeof address === 'object' && address !== null ? address.port : 0)) })
  })
  try {
    const run = await spawnDist(['update', '--check', '--json'], home, {
      HOME: home, PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_UPDATE_CHANNEL_REPO: 'fixture-owner/mercury-does-not-exist', MERCURY_UPDATE_API_BASE_URL: `http://127.0.0.1:${port}`, MERCURY_GH_CMD: JSON.stringify([join(home, 'absent', 'gh')]),
    }, 60_000)
    let parsed: Record<string, unknown> | null = null
    try { parsed = JSON.parse(run.out) as Record<string, unknown> } catch { parsed = null }
    check('the document lands on stdout and parses', parsed !== null, j({ out: run.out.slice(0, 160), err: run.err.slice(0, 160) }))
    check('it names the check\'s state', typeof parsed?.state === 'string' && parsed.state === 'access-unavailable', j(parsed?.state))
    check('stderr carries no JSON document', !run.err.trimStart().startsWith('{'), run.err.slice(0, 160))
    check('the exit code is 1 (a failed check)', run.code === 1, j({ code: run.code }))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
process.exit(failures === 0 ? 0 : 1)
