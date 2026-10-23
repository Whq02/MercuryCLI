#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { handoffTurn, startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const proofHome = mkdtempSync(join(tmpdir(), 'docs-automation-home-'))
process.env.MERCURY_CONFIG_DIR = proofHome
delete process.env.MERCURY_HOME
process.on('exit', () => rmSync(proofHome, { recursive: true, force: true }))
const { hostRunner } = await import('../lib/runnerHost.ts')
const dist = join(ROOT, 'dist', 'mercury.mjs')
const docPath = join(ROOT, 'docs', 'AUTOMATION.md')
const indexPath = join(ROOT, 'docs', 'README.md')
const nodeBin = Bun.which('node') ?? process.execPath
const pythonBin = Bun.which('python3') ?? 'python3'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const j = (value: unknown): string => JSON.stringify(value)

if (!existsSync(dist)) {
  console.error(`FAIL dist/mercury.mjs absent: ${dist}`)
  process.exit(1)
}
if (!existsSync(docPath)) {
  console.error(`FAIL docs/AUTOMATION.md absent: ${docPath}`)
  process.exit(1)
}

section('§1 the page: indexed, four runnable blocks, the laws in its words')
const doc = readFileSync(docPath, 'utf8')
const index = readFileSync(indexPath, 'utf8')
check('docs/README.md indexes AUTOMATION.md', index.includes('[AUTOMATION.md](AUTOMATION.md)'))

const blocks = [...doc.matchAll(/```(ts|py)\n([\s\S]*?)\n```/g)].map(m => ({
  lang: m[1] as 'ts' | 'py',
  code: m[2]!,
}))
check(
  'docs/AUTOMATION.md carries four runnable code blocks (ts, py, ts, py)',
  blocks.length === 4 && blocks[0]?.lang === 'ts' && blocks[1]?.lang === 'py' && blocks[2]?.lang === 'ts' && blocks[3]?.lang === 'py',
  blocks.map(b => b.lang).join(','),
)
if (blocks.length !== 4) process.exit(1)
check("the page says a prompt argument's close row precedes the outcome and an --input rows close follows it", /`close` precedes\s+that turn's `outcome`/.test(doc) && /follows the last `outcome` once `stdin`\s+closes/.test(doc))
check('the page says a one-shot ask nobody answers ends the turn blocked with the answer kept', /ends `blocked`\s+with its `answer` kept/.test(doc))
check('the page says session/set_mode applies at once and the three held verbs answer at turn_end then session/applied', /`session\/set_mode` changes\s+the permission mode at once/.test(doc) && /`session\/set_spawn_switch` answer `at: "now"`/.test(doc) && /answer `at: "turn_end"` and a `session\/applied` notification/.test(doc))
check('the page tells a reply from a request by method', /A reply\s+carries `result` or `error` and no `method`/.test(doc))

type RunResult = { status: number | null; stdout: string; stderr: string }
function execAsync(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }): Promise<RunResult> {
  return new Promise(resolveExec => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      resolveExec({ status: code, stdout, stderr })
    })
  })
}

type Tap = { stdin: Record<string, unknown>[]; stdout: Record<string, unknown>[] }
function readTap(dir: string): Tap {
  const parse = (name: string): Record<string, unknown>[] => {
    const file = join(dir, name)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim() !== '')
      .flatMap(line => {
        try {
          return [JSON.parse(line) as Record<string, unknown>]
        } catch {
          return []
        }
      })
  }
  return { stdin: parse('stdin.jsonl'), stdout: parse('stdout.jsonl') }
}

async function runBlock(
  block: { lang: 'ts' | 'py'; code: string },
  turnsOf: (home: string) => ScriptedTurn[],
  body: (res: RunResult, home: string, tap: Tap) => void,
): Promise<void> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'docs-auto-')))
  seedFirstRun(home, [home])
  writeFileSync(join(home, 'README.md'), '# Example project\n\nA folder the one-shot example reads.\n')
  const binDir = join(home, 'bin')
  const tapDir = join(home, 'tap')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(tapDir, { recursive: true })
  const shim = join(binDir, 'mercury')
  writeFileSync(shim, `#!/bin/bash\nset -o pipefail\ntee -a "${tapDir}/stdin.jsonl" | "${nodeBin}" "${dist}" "$@" | tee -a "${tapDir}/stdout.jsonl"\n`)
  chmodSync(shim, 0o755)
  const api = await startFixtureApi(turnsOf(home))
  try {
    const scriptFile = join(home, `example.${block.lang}`)
    writeFileSync(scriptFile, `${block.code}\n`)
    const runtime = block.lang === 'ts' ? nodeBin : pythonBin
    const res = await execAsync(runtime, [scriptFile], {
      cwd: home,
      timeoutMs: 90_000,
      env: {
        HOME: home,
        PATH: `${binDir}:/usr/bin:/bin:${dirname(nodeBin)}:${dirname(pythonBin)}`,
        TMPDIR: tmpdir(),
        MERCURY_CONFIG_DIR: home,
        MERCURY_CREDENTIAL_STORE: 'file',
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
        ANTHROPIC_API_KEY: 'fixture-key-000',
        ANTHROPIC_BASE_URL: api.url,
      },
    })
    body({ status: res.status, stdout: res.stdout.trim(), stderr: res.stderr.trim() }, home, readTap(tapDir))
  } finally {
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}

const detailOf = (res: RunResult): string => `rc=${res.status} stdout=${j(res.stdout.slice(0, 200))} stderr=${j(res.stderr.slice(0, 300))}`
const rowsOf = (tap: Tap): string[] => tap.stdout.map(row => String(row.type))
const SUMMARY = 'Repository summary ready.'
const BLOCKED_ANSWER = 'Summary without the self-check.'

for (const [label, block] of [['TypeScript', blocks[0]!], ['Python', blocks[1]!]] as const) {
  section(`§2 the one-shot example (${label})`)
  await runBlock(
    block,
    home => [{ kind: 'tool_use', name: 'Read', input: { file_path: join(home, 'README.md') } }, { kind: 'text', text: SUMMARY }, handoffTurn()],
    (res, _home, tap) => {
      check(`${label}: a read-only tool call goes ahead, the answer is printed and the exit is 0`, res.status === 0 && res.stdout === SUMMARY, detailOf(res))
      const types = rowsOf(tap)
      const outcomeAt = types.indexOf('outcome')
      const closeAt = types.indexOf('close')
      check(`${label}: with --input rows the close row follows the outcome once stdin closes`, outcomeAt >= 0 && closeAt > outcomeAt, types.join(','))
    },
  )
  await runBlock(
    block,
    () => [{ kind: 'tool_use', name: 'Bash', input: { command: 'python3 -c "print(1)"' } }, { kind: 'text', text: BLOCKED_ANSWER }, handoffTurn()],
    (res, _home, tap) => {
      const outcome = tap.stdout.find(row => row.type === 'outcome') as { status?: string; answer?: string; error?: { message?: string } } | undefined
      check(`${label}: the product's law — an ask nobody answered with no later tool success ends blocked, the answer kept (the field rows 2C-01, 2S-06)`, outcome?.status === 'blocked' && outcome.answer === BLOCKED_ANSWER && (outcome.error?.message ?? '').includes('Bash asked for an answer nobody could give'), j(outcome))
      check(`${label}: a blocked outcome exits 1 and the example prints the answer on stdout`, res.status === 1 && res.stdout === BLOCKED_ANSWER, detailOf(res))
      check(`${label}: the example prints the blocker's words on stderr`, res.stderr.includes('Blocked on the operator: Bash asked for an answer nobody could give'), detailOf(res))
    },
  )
}

section('§3 a prompt given as an argument: the close row precedes the outcome row')
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'docs-auto-arg-')))
  seedFirstRun(home, [home])
  const api = await startFixtureApi([{ kind: 'text', text: 'DONE' }, handoffTurn()])
  try {
    const res = await execAsync(nodeBin, [dist, 'run', '--format', 'rows', 'reply with exactly DONE'], {
      cwd: home,
      timeoutMs: 90_000,
      env: {
        HOME: home,
        PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
        TMPDIR: tmpdir(),
        MERCURY_CONFIG_DIR: home,
        MERCURY_CREDENTIAL_STORE: 'file',
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
        ANTHROPIC_API_KEY: 'fixture-key-000',
        ANTHROPIC_BASE_URL: api.url,
      },
    })
    const types = res.stdout
      .split('\n')
      .filter(line => line.trim() !== '')
      .map(line => String((JSON.parse(line) as { type: string }).type))
    const outcomeAt = types.indexOf('outcome')
    const closeAt = types.indexOf('close')
    check('the note is asked inside the last turn: close, then outcome, and the stream ends in outcome', res.status === 0 && closeAt >= 0 && outcomeAt > closeAt && types.at(-1) === 'outcome', `rc=${res.status} ${types.join(',')}`)
  } finally {
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}

const RUNNER_ANSWER = 'Runner turn complete.'
for (const [label, block] of [['TypeScript', blocks[2]!], ['Python', blocks[3]!]] as const) {
  section(`§4 the runner example (${label}): three asks, one prompt`)
  await runBlock(
    block,
    home => [
      { kind: 'tool_use', name: 'Write', input: { file_path: join(home, 'note.txt'), content: 'approved\n' }, preText: 'Writing note.' },
      { kind: 'tool_use', name: 'Write', input: { file_path: join(home, 'note-2.txt'), content: 'approved\n' } },
      { kind: 'tool_use', name: 'Write', input: { file_path: join(home, 'note-3.txt'), content: 'approved\n' } },
      { kind: 'text', text: RUNNER_ANSWER },
      handoffTurn(),
    ],
    (res, home, tap) => {
      check(`${label}: exits 0 and prints the answer once`, res.status === 0 && res.stdout === RUNNER_ANSWER, detailOf(res))
      const written = ['note.txt', 'note-2.txt', 'note-3.txt'].filter(name => existsSync(join(home, name)) && readFileSync(join(home, name), 'utf8') === 'approved\n')
      check(`${label}: every permission/request was answered allow and every Write landed`, written.length === 3, written.join(','))
      const queued = tap.stdin.filter(msg => msg.method === 'queue/add')
      check(`${label}: the prompt is queued once — the runner's own first request (id 1) is not mistaken for the initialize reply (the field rows 2C-05, 2C-06)`, queued.length === 1, `${queued.length} queue/add: ${j(queued).slice(0, 300)}`)
      check(`${label}: the queued prompt carries an id so a resend would answer duplicate`, queued.length > 0 && queued.every(msg => typeof (msg.params as { id?: unknown })?.id === 'string'), j(queued[0]?.params))
      const leaves = tap.stdin.filter(msg => msg.method === 'session/leave')
      const asks = tap.stdout.filter(msg => msg.method === 'permission/request')
      check(`${label}: the runner's three asks carried ids 1, 2, 3 and the host left once, after the outcome (a runner request with id 3 is not the leave reply)`, asks.map(msg => msg.id).join(',') === '1,2,3' && leaves.length === 1, `asks=${j(asks.map(msg => msg.id))} leaves=${leaves.length}`)
    },
  )
}

section('§5 the setters on the wire: set_mode at once, set_model held to the turn end then session/applied')
{
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'docs-auto-wire-')))
  seedFirstRun(home, [home])
  const api = await startFixtureApi([{ kind: 'paced', deltas: ['Holding', ' the turn', ' open.'], gapMs: 1500 }, handoffTurn()])
  const host = hostRunner({
    node: nodeBin,
    dist,
    cwd: home,
    home,
    env: {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TMPDIR: tmpdir(),
      MERCURY_CONFIG_DIR: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
    },
  })
  const killer = setTimeout(() => host.child.kill('SIGKILL'), 90_000)
  try {
    await host.initialize()
    const accepted = await host.prompt('hold the turn open', { id: 'wire-1' })
    check('queue/add with an id is accepted', (accepted as { accepted: boolean }).accepted === true, j(accepted))
    const again = await host.prompt('hold the turn open', { id: 'wire-1' })
    check('the same id again answers duplicate', j(again) === j({ accepted: false, reason: 'duplicate' }), j(again))
    await host.waitFor('the turn started', row => row.type === 'turn', 30_000)
    const mode = (await host.request('session/set_mode', { mode: 'flow' })) as Record<string, unknown>
    check('session/set_mode mid-turn answers the mode and no at (the field row 2C-08)', mode.mode === 'flow' && !('at' in mode), j(mode))
    const model = (await host.request('session/set_model', { model: 'default' })) as Record<string, unknown>
    check('session/set_model mid-turn answers at: turn_end', model.at === 'turn_end', j(model))
    await host.waitFor('the turn ended', row => row.type === 'outcome', 60_000)
    const applied = await new Promise<unknown>(resolveApplied => {
      const seen = host.notifications.find(n => n.method === 'session/applied')
      if (seen !== undefined) return resolveApplied(seen.params)
      const started = Date.now()
      const poll = setInterval(() => {
        const found = host.notifications.find(n => n.method === 'session/applied')
        if (found !== undefined || Date.now() - started > 20_000) {
          clearInterval(poll)
          resolveApplied(found?.params)
        }
      }, 50)
    })
    const appliedVerbs = host.notifications.filter(n => n.method === 'session/applied').map(n => (n.params as { verb?: string }).verb)
    check('session/applied follows for set_model when the turn ends, and never for set_mode', (applied as { verb?: string } | undefined)?.verb === 'set_model' && !appliedVerbs.includes('set_mode' as never), j(host.notifications))
  } finally {
    clearTimeout(killer)
    host.end()
    await host.exited
    await api.close()
    rmSync(home, { recursive: true, force: true })
  }
}

if (failures > 0) {
  console.error(`\nFAIL prove-automation-examples: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nPASS prove-automation-examples: the four examples ran against the built mercury as the page says, and the page says what the product does')
