#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { startFixtureApi, handoffTurn, isHandoffRequest, type FixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { PYTHON } from '../sdk/runtime.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }
const sdk = await import('../../sdk/src/index.ts')

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`); if (!ok) failures++ }
const node = Bun.which('node') ?? 'node'
const REPLY = 'REPLY-AFTER-THE-TOOL.'
const UNWRITABLE = 'the session transcript store is unwritable ('
const ADVICE = 'Repair the directory, or run with --ephemeral to skip transcripts for this run.'
const WORK = "import { existsSync, writeFileSync } from 'node:fs'\nwriteFileSync('started', '')\nconst until = Date.now() + 90000\nwhile (!existsSync('go') && Date.now() < until) await new Promise(tick => setTimeout(tick, 50))\nconsole.log('WORK-DONE')\n"
const toolTurns: ScriptedTurn[] = [{ kind: 'tool_use', name: 'Bash', id: 'toolu_store_fails', input: { command: 'node work.mjs', description: 'Does the slow work' } }, { kind: 'text', text: REPLY }]

type World = { home: string; cwd: string; env: Record<string, string>; api: FixtureApi; close(): Promise<void> }
async function world(name: string, turns: ScriptedTurn[]): Promise<World> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), `store-fails-${name}-`)))
  const cwd = join(home, 'project')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, 'tmp'), { recursive: true })
  seedFirstRun(home, [cwd])
  writeFileSync(join(cwd, 'work.mjs'), WORK)
  const api = await startFixtureApi([...turns, handoffTurn(), handoffTurn(), handoffTurn()])
  const env = {
    HOME: home, PATH: process.env.PATH ?? '', TERM: 'dumb', TMPDIR: join(home, 'tmp'), MERCURY_TMPDIR: join(home, 'tmp'), MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: api.url,
  }
  return { home, cwd, env, api, close: async () => { await api.close(); rmSync(home, { recursive: true, force: true }) } }
}

const until = async (what: string, met: () => boolean, ms = 60_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!met()) {
    if (Date.now() > deadline) throw new Error(`${what} did not come within ${ms} ms`)
    await new Promise(tick => setTimeout(tick, 25))
  }
}
const recordsIn = (home: string): string[] => {
  const found: string[] = []
  const visit = (folder: string): void => { for (const entry of readdirSync(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) visit(path); else if (entry.name.endsWith('.jsonl') && path.includes(`${sep}projects${sep}`) && !path.includes(`${sep}lineage${sep}`)) found.push(path) } }
  if (existsSync(join(home, 'projects'))) visit(join(home, 'projects'))
  return found
}
const inside = (home: string, path: string): string => {
  const real = realpathSync(path)
  if (!real.startsWith(realpathSync(home) + sep)) throw new Error(`${real} lies outside this proof's own home ${home}: left alone`)
  return real
}
function swapForFolder(home: string, record: string): string {
  const real = inside(home, record)
  if (!statSync(real).isFile()) throw new Error(`${real} is no record file: left alone`)
  renameSync(real, `${real}.aside`)
  mkdirSync(real)
  return real
}
function putBack(home: string, record: string): void {
  const real = inside(home, record)
  if (!statSync(real).isDirectory() || readdirSync(real).length > 0 || !existsSync(`${real}.aside`)) throw new Error(`${real} is not the empty folder this proof put there: left alone`)
  rmdirSync(real)
  renameSync(`${real}.aside`, real)
}
const storeLines = (stderr: string): string[] => stderr.split('\n').filter(line => line.includes(UNWRITABLE))
const isStoreSentence = (text: unknown, record: string): boolean => typeof text === 'string' && text.startsWith(`${UNWRITABLE}${dirname(record)}): `) && text.endsWith(ADVICE)
const lastNoticeOf = (outcome: Row | null | undefined): Row => { const notices = outcome?.notices; return Array.isArray(notices) && notices.length > 0 ? notices.at(-1) as Row : {} }
const carries = (outcome: Row | null | undefined, record: string): boolean => lastNoticeOf(outcome).level === 'error' && isStoreSentence(lastNoticeOf(outcome).text, record)

type Row = Record<string, unknown>
type Ran = { code: number | null; out: string; err: string; rows: Row[]; record: string; swapped: boolean; requests: number; stored: string }
async function runOnce(name: string, format: 'rows' | 'json' | 'text', fail: boolean): Promise<Ran> {
  const w = await world(name, toolTurns)
  try {
    const child = spawn(node, [dist, 'run', 'Do the work.', '--model', 'claude-opus-4-8', '--mode', 'sovereign', '--format', format], { cwd: w.cwd, env: w.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', d => { err += String(d) })
    let code: number | null | undefined
    const guard = setTimeout(() => child.kill('SIGKILL'), 150_000)
    const exited = new Promise<number | null>(done => child.on('close', exit => { clearTimeout(guard); code = exit; done(exit) }))
    await until('the tool of the turn', () => existsSync(join(w.cwd, 'started')) || code !== undefined)
    await until("the session's record", () => recordsIn(w.home).length === 1 || code !== undefined)
    const record = recordsIn(w.home)[0] ?? ''
    let swapped = false
    if (fail && record !== '') { swapForFolder(w.home, record); swapped = true }
    writeFileSync(join(w.cwd, 'go'), '')
    await exited
    if (swapped) putBack(w.home, record)
    const rows = format === 'text' ? [] : out.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as Row)
    return { code: code ?? null, out, err, rows, record, swapped, requests: w.api.messageRequests().filter(request => !isHandoffRequest(request)).length, stored: record === '' ? '' : readFileSync(record, 'utf8') }
  } finally {
    await w.close()
  }
}

type Hosted = { w: World; host: ReturnType<typeof hostRunner>; record: string; before: string }
async function hosted(name: string, scene: (h: Hosted) => Promise<void>): Promise<void> {
  const w = await world(name, [{ kind: 'text', text: 'ONE' }, { kind: 'text', text: 'TWO' }, { kind: 'text', text: 'THREE' }])
  const host = hostRunner({ dist, node, cwd: w.cwd, home: w.home, env: w.env, argv: ['--model', 'claude-opus-4-8'] })
  try {
    await host.initialize({}, 90_000)
    await host.prompt('RUNNER_PROMPT_1')
    await host.waitFor('outcome 1', row => row.type === 'outcome' && row.turn === 1, 90_000)
    await until("the session's record", () => recordsIn(w.home).length === 1)
    const record = recordsIn(w.home)[0]!
    await scene({ w, host, record, before: readFileSync(record, 'utf8') })
  } finally {
    await host.stop().catch(() => null)
    await w.close()
  }
}
async function failingTurn(h: Hosted, turn: number): Promise<{ outcome: Row | null; notice: Row }> {
  swapForFolder(h.w.home, h.record)
  await h.host.prompt(`RUNNER_PROMPT_${turn}`)
  const outcome = await Promise.race([h.host.waitFor(`outcome ${turn}`, row => row.type === 'outcome' && row.turn === turn, 90_000).then(row => row as Row, () => null), h.host.exited.then(() => null)])
  const rows = [...h.host.rows] as Row[]
  const at = rows.findIndex(row => row.type === 'outcome' && row.turn === turn)
  return { outcome, notice: at > 0 ? rows[at - 1]! : {} }
}
const storeNotices = (h: Hosted): Row[] => ([...h.host.rows] as Row[]).filter(row => row.type === 'notice' && String(row.text).includes(UNWRITABLE))

try {
  console.log('\n§1 --format rows: the record cannot be written when the turn ends')
  {
    const ran = await runOnce('rows', 'rows', true)
    const outcome = ran.rows.at(-1) ?? {}
    const notice = ran.rows.at(-2) ?? {}
    check("the scene: the session's record stood, a folder took its place while the tool ran, and the turn went on to its reply", ran.swapped && ran.requests === 2, `swapped ${ran.swapped} · ${ran.requests} request(s)`)
    check('the run speaks its outcome row, as the turn ended: completed, with the answer', outcome.type === 'outcome' && outcome.status === 'completed' && outcome.answer === REPLY, `${ran.rows.map(row => String(row.type)).join(' ')} · ${JSON.stringify(outcome).slice(0, 200)}`)
    check("the row before it is an error notice with the store's own sentence: the folder it could not write and what to do", notice.type === 'notice' && notice.level === 'error' && isStoreSentence(notice.text, ran.record), JSON.stringify(notice).slice(0, 300))
    check("the notice belongs to the outcome's session and turn", notice.session_id === outcome.session_id && notice.turn === outcome.turn && outcome.turn === 1, JSON.stringify({ notice: [notice.session_id, notice.turn], outcome: [outcome.session_id, outcome.turn] }))
    check('it is said once', ran.rows.filter(row => row.type === 'notice' && String(row.text).includes(UNWRITABLE)).length === 1)
    check("the outcome's own notices carry it too, as they carry every notice of a turn: a reader of the outcome alone is told", carries(outcome, ran.record) && lastNoticeOf(outcome).text === notice.text && (outcome.notices as unknown[]).length === 1, JSON.stringify(outcome.notices ?? null).slice(0, 300))
    check('the run exits 1', ran.code === 1, `exit ${ran.code}`)
    check('stderr is that sentence and nothing else', ran.err === `Error: ${String(notice.text)}\n`, JSON.stringify(ran.err.slice(0, 300)))
  }

  console.log('\n§2 --format json: the one document is the outcome')
  {
    const ran = await runOnce('json', 'json', true)
    let document: Row = {}
    try { document = JSON.parse(ran.out) as Row } catch { document = {} }
    check('stdout is one JSON document, the outcome as the turn ended', ran.swapped && document.type === 'outcome' && document.status === 'completed' && document.answer === REPLY, ran.out.slice(0, 200))
    check("the document's notices carry the store's sentence", carries(document, ran.record), JSON.stringify(document.notices ?? null).slice(0, 300))
    check("the run exits 1, and stderr is the store's sentence and nothing else", ran.code === 1 && ran.err.endsWith('\n') && !ran.err.slice(0, -1).includes('\n') && isStoreSentence(ran.err.slice(0, -1).replace(/^Error: /, ''), ran.record), `exit ${ran.code} · ${JSON.stringify(ran.err.slice(0, 200))}`)
  }

  console.log('\n§3 --format text: the answer is printed')
  {
    const ran = await runOnce('text', 'text', true)
    check('stdout is the answer', ran.swapped && ran.out === `${REPLY}\n`, JSON.stringify(ran.out.slice(0, 200)))
    check("the run exits 1, and stderr is the store's sentence and nothing else", ran.code === 1 && ran.err.endsWith('\n') && !ran.err.slice(0, -1).includes('\n') && isStoreSentence(ran.err.slice(0, -1).replace(/^Error: /, ''), ran.record), `exit ${ran.code} · ${JSON.stringify(ran.err.slice(0, 200))}`)
  }

  console.log('\n§4 control: the same run with a record it can write')
  {
    const ran = await runOnce('control', 'rows', false)
    const outcome = ran.rows.at(-1) ?? {}
    check('the outcome is the last row, completed, and the run exits 0', outcome.type === 'outcome' && outcome.status === 'completed' && outcome.answer === REPLY && ran.code === 0, `exit ${ran.code} · ${ran.rows.map(row => String(row.type)).join(' ')}`)
    check('no notice speaks of the store, the outcome carries no notices, and stderr is empty', ran.rows.every(row => !(row.type === 'notice' && String(row.text).includes(UNWRITABLE))) && outcome.notices === undefined && ran.err === '', `${JSON.stringify(outcome.notices ?? null)} · ${JSON.stringify(ran.err.slice(0, 200))}`)
    check('the record holds the reply', ran.stored.includes(REPLY))
  }

  console.log("\n§5 the package's reading: the outcome resolves and the exit says 1")
  {
    const w = await world('package', toolTurns)
    try {
      const run = sdk.run({ prompt: 'Do the work.', mercury: [node, dist], cwd: w.cwd, env: w.env, mode: 'sovereign', model: 'claude-opus-4-8' })
      let settled = false
      void run.exit.then(() => { settled = true })
      await until('the tool of the turn', () => existsSync(join(w.cwd, 'started')) || settled)
      await until("the session's record", () => recordsIn(w.home).length === 1 || settled)
      const record = recordsIn(w.home)[0] ?? ''
      const swapped = record !== '' && !settled
      if (swapped) swapForFolder(w.home, record)
      writeFileSync(join(w.cwd, 'go'), '')
      const outcome = await run.outcome.then(row => row, (error: unknown) => error)
      const exit = await run.exit
      if (swapped) putBack(w.home, record)
      const resolved = (outcome instanceof Error ? {} : outcome) as Row
      check('the outcome promise resolves with the outcome row: completed, with the answer', swapped && !(outcome instanceof Error) && resolved.status === 'completed' && resolved.answer === REPLY, outcome instanceof Error ? `${outcome.name}: ${outcome.message.slice(0, 200)}` : JSON.stringify(resolved).slice(0, 200))
      check('no error is raised for the run', run.error === null, String(run.error))
      check("the outcome it resolves with carries the store's sentence in its notices", carries(resolved, record), JSON.stringify(resolved.notices ?? null).slice(0, 300))
      check("the exit carries code 1 and the store's sentence in its stderr, where the package's table gives a completed outcome 0", exit.code === 1 && storeLines(exit.stderr).length === 1 && sdk.OUTCOME_EXIT_CODES.completed === 0, `exit ${exit.code} · ${exit.stderr.slice(0, 200)}`)
      const notices = run.rows.filter(row => row.type === 'notice' && row.text.includes(UNWRITABLE))
      check('the rows the package delivered hold the notice once, before the outcome', notices.length === 1 && run.rows.at(-1)?.type === 'outcome' && run.rows.at(-2) === notices[0], run.rows.map(row => row.type).join(' '))
    } finally {
      await w.close()
    }
  }

  console.log('\n§6 the Python package reads the same')
  {
    const pythonEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: join(import.meta.dir, '../../sdk-py/src') }
    const importable = spawnSync(PYTHON, ['-c', 'import mercury_cli_sdk'], { env: pythonEnv, encoding: 'utf8', timeout: 60_000 })
    if (importable.status !== 0) {
      console.log(`SKIP ${PYTHON} cannot import the Python package on this machine: ${(importable.stderr ?? '').trim().split('\n').at(-1) ?? ''}`)
    } else {
      const w = await world('python', toolTurns)
      try {
        const script = [
          'import asyncio, json, sys',
          'from mercury_cli_sdk import run',
          'given = json.loads(sys.argv[1])',
          'async def main():',
          "    handle = await run('Do the work.', mercury=given['mercury'], cwd=given['cwd'], env=given['env'], mode='sovereign', model='claude-opus-4-8')",
          '    raised = None',
          '    outcome = None',
          '    try:',
          '        outcome = await handle.outcome',
          '    except Exception as error:',
          '        raised = type(error).__name__',
          '    exit = await handle.exit',
          "    print(json.dumps({'outcome': outcome, 'raised': raised, 'code': exit.code, 'stderr': exit.stderr}))",
          'asyncio.run(main())',
        ].join('\n')
        const child = spawn(PYTHON, ['-c', script, JSON.stringify({ mercury: [node, dist], cwd: w.cwd, env: w.env })], { env: pythonEnv, stdio: ['ignore', 'pipe', 'pipe'] })
        let out = '', err = ''
        child.stdout.on('data', d => { out += String(d) })
        child.stderr.on('data', d => { err += String(d) })
        let ended = false
        const guard = setTimeout(() => child.kill('SIGKILL'), 150_000)
        const exited = new Promise<void>(done => child.on('close', () => { clearTimeout(guard); ended = true; done() }))
        await until('the tool of the turn', () => existsSync(join(w.cwd, 'started')) || ended)
        await until("the session's record", () => recordsIn(w.home).length === 1 || ended)
        const record = recordsIn(w.home)[0] ?? ''
        const swapped = record !== '' && !ended
        if (swapped) swapForFolder(w.home, record)
        writeFileSync(join(w.cwd, 'go'), '')
        await exited
        if (swapped) putBack(w.home, record)
        let read: { outcome?: Row | null; raised?: string | null; code?: number | null; stderr?: string } = {}
        try { read = JSON.parse(out.trim().split('\n').at(-1) ?? '') as typeof read } catch { read = {} }
        check('its outcome resolves with the outcome row, completed, the answer and the notice, and nothing is raised', swapped && read.raised === null && read.outcome?.status === 'completed' && read.outcome?.answer === REPLY && carries(read.outcome, record), `${JSON.stringify(read).slice(0, 300)} · ${err.slice(-300)}`)
        check("its exit carries code 1 and the store's sentence in its stderr", read.code === 1 && storeLines(read.stderr ?? '').length === 1, `exit ${read.code} · ${(read.stderr ?? '').slice(0, 200)}`)
      } finally {
        await w.close()
      }
    }
  }

  console.log('\n§7 the runner door, a session of several turns: the store fails under one turn and answers again before the next')
  await hosted('runner', async h => {
    const failed = await failingTurn(h, 2)
    check('the turn whose record could not be written still speaks its outcome', failed.outcome !== null && failed.outcome.status === 'completed' && failed.outcome.answer === 'TWO', failed.outcome === null ? `the runner ended: ${h.host.stderr().slice(-300)}` : JSON.stringify(failed.outcome).slice(0, 200))
    check("…behind an error notice with the store's sentence, for that turn, and carries it in its notices", failed.notice.type === 'notice' && failed.notice.level === 'error' && isStoreSentence(failed.notice.text, h.record) && failed.notice.turn === 2 && carries(failed.outcome, h.record), JSON.stringify(failed.notice).slice(0, 300))
    putBack(h.w.home, h.record)
    if (failed.outcome !== null) await h.host.prompt('RUNNER_PROMPT_3')
    const third = failed.outcome === null ? null : await h.host.waitFor('outcome 3', row => row.type === 'outcome' && row.turn === 3, 90_000).then(row => row as Row, () => null)
    check('the runner takes the next turn', third !== null && third.status === 'completed' && third.answer === 'THREE', third === null ? h.host.stderr().slice(-300) : JSON.stringify(third).slice(0, 200))
    check('that turn carries no such notice, as a row or in its outcome: the store was said to fail once', third !== null && storeNotices(h).length === 1 && third.notices === undefined, `${storeNotices(h).length} · ${JSON.stringify(third?.notices ?? null).slice(0, 200)}`)
    const code = await h.host.stop(20_000)
    const after = readFileSync(h.record, 'utf8')
    check('what the failed turn could not write was held and is in the record now, with the turn after it', after.startsWith(h.before) && after.includes('RUNNER_PROMPT_2') && after.includes('TWO') && after.includes('RUNNER_PROMPT_3') && after.includes('THREE'), `${h.before.length} → ${after.length} bytes`)
    check('the runner ends 0 and its stderr holds no line about the store: its record is whole', code === 0 && storeLines(h.host.stderr()).length === 0, `exit ${code} · ${h.host.stderr().slice(-300)}`)
  })

  console.log('\n§8 the store fails under the last turn and answers again before the runner ends: the exit says the record is whole')
  await hosted('healed', async h => {
    const failed = await failingTurn(h, 2)
    check('the scene: the last turn spoke its outcome behind the notice', failed.outcome !== null && failed.outcome.answer === 'TWO' && failed.notice.type === 'notice', failed.outcome === null ? h.host.stderr().slice(-300) : JSON.stringify(failed.notice).slice(0, 200))
    putBack(h.w.home, h.record)
    const code = await h.host.stop(20_000)
    const after = readFileSync(h.record, 'utf8')
    check('the runner ends 0 with no line about the store on stderr', code === 0 && storeLines(h.host.stderr()).length === 0, `exit ${code} · ${h.host.stderr().slice(-300)}`)
    check('…and the record holds that turn', after.startsWith(h.before) && after.includes('RUNNER_PROMPT_2') && after.includes('TWO'), `${h.before.length} → ${after.length} bytes`)
  })

  console.log('\n§9 the store still fails when the runner ends: the exit says the record is not whole')
  await hosted('unhealed', async h => {
    const failed = await failingTurn(h, 2)
    check('the scene: the last turn spoke its outcome behind the notice', failed.outcome !== null && failed.outcome.answer === 'TWO' && failed.notice.type === 'notice', failed.outcome === null ? h.host.stderr().slice(-300) : JSON.stringify(failed.notice).slice(0, 200))
    const code = await h.host.stop(20_000)
    putBack(h.w.home, h.record)
    const after = readFileSync(h.record, 'utf8')
    check("the runner ends 1 with the store's sentence on stderr, once", code === 1 && storeLines(h.host.stderr()).length === 1 && isStoreSentence(storeLines(h.host.stderr())[0]!.replace(/^Error: /, ''), h.record), `exit ${code} · ${h.host.stderr().slice(-300)}`)
    check('…and the record does lack that turn: the exit told the truth', failed.outcome !== null && !after.includes('RUNNER_PROMPT_2'), `${h.before.length} → ${after.length} bytes`)
  })
} catch (error) {
  failures++
  console.log(`FAIL the proof could not finish: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} run-speaks-its-outcome-when-the-store-fails: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
