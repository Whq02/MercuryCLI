#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startFixtureApi, handoffTurn, isHandoffRequest, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { hostRunner, scratchHome } from '../lib/runnerHost.ts'

const at = process.argv.indexOf('--dist')
const dist = resolve(at < 0 ? join(import.meta.dir, '../../dist/mercury.mjs') : process.argv[at + 1]!)
if (!existsSync(dist)) { console.error(`FAIL run bundle exists: ${dist}`); process.exit(1) }

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => { checks++; console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok || !detail ? '' : `: ${detail}`}`); if (!ok) failures++ }
const head = (text: string): string => JSON.stringify(text.slice(0, 120))

const BRIEF = 'SESSION_BRIEF_MARKER: answer in one line and name the file you would open first.'
const OTHER = 'REPLACED_BRIEF_MARKER: answer in two lines.'
const ADDED = 'SESSION_BRIEF_ADD_MARKER: end every answer with the word done.'
const AGENT_BRIEF = 'AGENT_BRIEF_MARKER: answer as the fixture agent.'
const agentDefinitions = JSON.stringify({ fixture: { description: 'A fixture agent with a prompt of its own', prompt: AGENT_BRIEF } })

type Seen = { code: number | null; err: string; status: string | undefined; session: string | undefined; system: string; shape: string; requests: number; error: string }

const home = realpathSync(mkdtempSync(join(tmpdir(), 'session-brief-')))
const cwd = join(home, 'project')
mkdirSync(cwd, { recursive: true })
mkdirSync(join(home, 'tmp'), { recursive: true })
seedFirstRun(home, [cwd])

async function run(args: string[], answer = 'FIXTURE_ANSWER'): Promise<Seen> {
  const turns: ScriptedTurn[] = [{ kind: 'text', text: answer }, { kind: 'text', text: 'FIXTURE_ANSWER' }, handoffTurn(), handoffTurn(), handoffTurn()]
  const api = await startFixtureApi(turns)
  try {
    const child = spawn('node', [dist, 'run', '--format', 'json', '--model', 'claude-opus-4-8', ...args], {
      cwd,
      env: {
        HOME: home, PATH: process.env.PATH ?? '', TMPDIR: join(home, 'tmp'), MERCURY_TMPDIR: join(home, 'tmp'), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file',
        MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: api.url,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', err = ''
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', d => { err += String(d) })
    const guard = setTimeout(() => child.kill('SIGKILL'), 120_000)
    const code = await new Promise<number | null>(done => child.on('close', exit => { clearTimeout(guard); done(exit) }))
    const asked = api.requests.filter(request => request.path.includes('/v1/messages') && !request.path.includes('count_tokens') && !isHandoffRequest(request))
    const body = (asked.at(-1)?.body ?? {}) as { system?: unknown }
    const blocks = Array.isArray(body.system) ? body.system as Array<{ text?: string }> : [{ text: typeof body.system === 'string' ? body.system : '' }]
    let outcome: { status?: string; session_id?: string; error?: { message?: string } } = {}
    try { outcome = JSON.parse(out) as typeof outcome } catch { outcome = {} }
    const system = blocks.map(block => block.text ?? '').at(-1) ?? ''
    return { code, err, status: outcome.status, session: outcome.session_id, system, shape: outcome.session_id ? system.split(outcome.session_id).join('<session>') : system, requests: asked.length, error: outcome.error?.message ?? '' }
  } finally {
    await api.close()
  }
}

type Stored = { kind: string; metaKind?: string; fields?: Record<string, unknown> }
const recordOf = (root: string, session: string): Stored[] => {
  const found: string[] = []
  const visit = (folder: string): void => { for (const entry of readdirSync(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) visit(path); else if (entry.name === `${session}.jsonl`) found.push(path) } }
  if (existsSync(root)) visit(root)
  if (found.length !== 1) return []
  return readFileSync(found[0]!, 'utf8').split('\n').filter(Boolean).map(line => { try { return (JSON.parse(line) as { payload?: Stored }).payload ?? { kind: 'unreadable' } } catch { return { kind: 'unreadable' } } })
}
const briefRows = (rows: Stored[], metaKind = 'session-brief', field = 'brief'): string[] => rows.filter(row => row.kind === 'session-meta' && row.metaKind === metaKind).map(row => String(row.fields?.[field]))
const completed = (seen: Seen): boolean => seen.code === 0 && seen.status === 'completed'
const apart = (left: string, right: string): string => { let at = 0; while (at < left.length && left[at] === right[at]) at++; return at === left.length && at === right.length ? 'equal' : `first differ at ${at}: ${JSON.stringify(left.slice(at, at + 60))} against ${JSON.stringify(right.slice(at, at + 60))}` }

try {
  console.log('§1 a brief given at launch rides the launch and is written to the record once')
  const plain = await run(['PLAIN_PROMPT'])
  const kept = randomUUID()
  const launched = await run(['--brief', BRIEF, '--session-id', kept, 'FIRST_PROMPT'])
  check('the scene: a run without a brief rides the default brief, a run with one rides it instead', completed(plain) && completed(launched) && launched.system.includes(BRIEF) && !plain.system.includes(BRIEF), `plain rc ${plain.code} ${plain.status} · launched rc ${launched.code} ${launched.status} · ${launched.err.slice(0, 200)}`)
  check('the record of the session holds the brief in one row', briefRows(recordOf(home, kept)).join('|') === BRIEF, JSON.stringify(briefRows(recordOf(home, kept)).map(text => text.slice(0, 40))))

  console.log('\n§2 the session resumed without the flag keeps its brief')
  const resumed = await run(['--resume', kept, 'SECOND_PROMPT'])
  check('the resumed run completes and its system prompt carries the brief', completed(resumed) && resumed.system.includes(BRIEF), `rc ${resumed.code} ${resumed.status} · ${head(resumed.system)} · ${resumed.err.slice(0, 200)}`)
  check('the launch and the resume ride one system prompt', resumed.system === launched.system, `launch ${launched.system.length} chars · resume ${resumed.system.length} chars`)
  check('the resume wrote no second row of the brief', briefRows(recordOf(home, kept)).length === 1, String(briefRows(recordOf(home, kept)).length))
  const continued = await run(['--continue', 'THIRD_PROMPT'])
  check('--continue keeps it the same way', completed(continued) && continued.system === launched.system, `rc ${continued.code} ${continued.status} · ${head(continued.system)}`)

  console.log('\n§3 the flag given again replaces it; an empty brief is a brief with no text, kept like any other')
  const emptied = randomUUID()
  const emptyLaunch = await run(['--brief', '', '--session-id', emptied, 'EMPTY_PROMPT'])
  const ridesDefault = (seen: Seen): boolean => completed(seen) && seen.shape.startsWith(plain.shape.slice(0, 1_000)) && ![BRIEF, OTHER, ADDED, AGENT_BRIEF].some(text => seen.system.includes(text))
  console.log(`  the system prompt of a launch with an empty brief: ${emptyLaunch.system.length} chars, sha256 ${createHash('sha256').update(emptyLaunch.system).digest('hex').slice(0, 16)}`)
  check('control: a launch with an empty brief carries the built-in constitution alone — the head of a briefed prompt, no brief text, not the default brief', completed(emptyLaunch) && emptyLaunch.system.length > 1_000 && launched.system.startsWith(emptyLaunch.system.trimEnd()) && launched.system.length - emptyLaunch.system.trimEnd().length <= BRIEF.length + 4 && !ridesDefault(emptyLaunch), `rc ${emptyLaunch.code} ${emptyLaunch.status} · ${emptyLaunch.system.length} chars against the briefed ${launched.system.length} · ${apart(emptyLaunch.system, launched.system)}`)
  check('the record holds the empty brief in one row', briefRows(recordOf(home, emptied)).join('|') === '' && briefRows(recordOf(home, emptied)).length === 1, String(briefRows(recordOf(home, emptied)).length))
  const emptyResumed = await run(['--resume', emptied, 'EMPTY_SECOND'])
  check('the session resumed without the flag still carries the constitution alone', completed(emptyResumed) && emptyResumed.system === emptyLaunch.system, apart(emptyResumed.system, emptyLaunch.system))
  const emptyFork = await run(['--resume', emptied, '--fork', 'EMPTY_FORK'])
  check('its fork carries the same and records the empty brief in a row of its own', completed(emptyFork) && emptyFork.system === emptyLaunch.system && emptyFork.session !== undefined && emptyFork.session !== emptied && briefRows(recordOf(home, emptyFork.session)).length === 1 && briefRows(recordOf(home, emptyFork.session))[0] === '', apart(emptyFork.system, emptyLaunch.system))
  const replaced = await run(['--resume', kept, '--brief', OTHER, 'FOURTH_PROMPT'])
  check('the new brief rides and the old one does not', completed(replaced) && replaced.system.includes(OTHER) && !replaced.system.includes(BRIEF), head(replaced.system))
  const afterReplace = await run(['--resume', kept, 'FIFTH_PROMPT'])
  check('the next resume without the flag rides the new brief', completed(afterReplace) && afterReplace.system === replaced.system, head(afterReplace.system))
  const cleared = await run(['--resume', kept, '--brief', '', 'SIXTH_PROMPT'])
  check('an empty brief given to a session that had one: the constitution alone, as at launch', completed(cleared) && cleared.system === emptyLaunch.system, `rc ${cleared.code} ${cleared.status} · ${apart(cleared.system, emptyLaunch.system)}`)
  const afterClear = await run(['--resume', kept, 'SEVENTH_PROMPT'])
  check('…and the next resume without the flag keeps it', completed(afterClear) && afterClear.system === emptyLaunch.system, apart(afterClear.system, emptyLaunch.system))
  check('the record holds the three values in the order they were given', briefRows(recordOf(home, kept)).join('|') === [BRIEF, OTHER, ''].join('|'), JSON.stringify(briefRows(recordOf(home, kept)).map(text => text.slice(0, 24))))

  console.log('\n§4 --brief-add is kept and replaced the same way; an empty addition removes it')
  const added = randomUUID()
  const withAdd = await run(['--brief-add', ADDED, '--session-id', added, 'ADD_PROMPT'])
  const addResumed = await run(['--resume', added, 'ADD_SECOND'])
  check('the addition rides the launch and the resume without the flag', completed(withAdd) && completed(addResumed) && withAdd.system.endsWith(ADDED) && addResumed.system === withAdd.system, `launch ${head(withAdd.system.slice(-100))} · resume ${head(addResumed.system.slice(-100))}`)
  const addCleared = await run(['--resume', added, '--brief-add', '', 'ADD_THIRD'])
  const addAfter = await run(['--resume', added, 'ADD_FOURTH'])
  check('an empty addition: that run and the next ride the default brief with nothing added', ridesDefault(addCleared) && ridesDefault(addAfter), apart(addAfter.shape, plain.shape))
  check('the record holds the addition and its clearing', briefRows(recordOf(home, added), 'session-brief-add', 'briefAdd').join('|') === [ADDED, ''].join('|'))

  console.log("\n§5 on a resume the brief outranks the agent's prompt, as at launch")
  const agented = randomUUID()
  const both = await run(['--agent-defs', agentDefinitions, '--agent', 'fixture', '--brief', BRIEF, '--session-id', agented, 'AGENT_PROMPT'])
  const bothResumed = await run(['--agent-defs', agentDefinitions, '--resume', agented, 'AGENT_SECOND'])
  check('the launch rides the brief and not the agent prompt', completed(both) && both.system.includes(BRIEF) && !both.system.includes(AGENT_BRIEF), head(both.system))
  check('the resume without either flag rides the same', completed(bothResumed) && bothResumed.system === both.system, head(bothResumed.system))
  const agentAlone = await run(['--agent-defs', agentDefinitions, '--resume', agented, '--brief', '', 'AGENT_THIRD'])
  check("an empty brief outranks the agent's prompt too: the constitution alone", completed(agentAlone) && agentAlone.system === emptyLaunch.system, apart(agentAlone.system, emptyLaunch.system))

  console.log('\n§6 a fork carries the brief into its own record')
  const origin = randomUUID()
  const first = await run(['--brief', BRIEF, '--session-id', origin, 'ORIGIN_PROMPT'])
  const forked = await run(['--resume', origin, '--fork', 'FORK_PROMPT'])
  check('the fork is a session of its own and rides the brief', completed(first) && completed(forked) && forked.session !== undefined && forked.session !== origin && forked.system === first.system, `fork ${forked.session} · ${head(forked.system)}`)
  check("the fork's record holds the brief in one row and the origin's still holds one", forked.session !== undefined && briefRows(recordOf(home, forked.session)).join('|') === BRIEF && briefRows(recordOf(home, origin)).length === 1, `fork ${forked.session === undefined ? 0 : briefRows(recordOf(home, forked.session)).length} · origin ${briefRows(recordOf(home, origin)).length}`)
  const forkResumed = forked.session === undefined ? forked : await run(['--resume', forked.session, 'FORK_SECOND'])
  check('the fork resumed without the flag keeps it', completed(forkResumed) && forkResumed.system === first.system, head(forkResumed.system))

  console.log('\n§7 a brief read from a file is kept as its text')
  const filed = randomUUID()
  writeFileSync(join(home, 'brief.txt'), BRIEF)
  const fromFile = await run(['--brief-file', join(home, 'brief.txt'), '--session-id', filed, 'FILE_PROMPT'])
  rmSync(join(home, 'brief.txt'))
  const fileResumed = await run(['--resume', filed, 'FILE_SECOND'])
  check('the resume rides the text the file held, with the file gone', completed(fromFile) && completed(fileResumed) && fileResumed.system === fromFile.system && fileResumed.system.includes(BRIEF), head(fileResumed.system))
  const firstReply = ((): string => {
    const found: string[] = []
    const visit = (folder: string): void => { for (const entry of readdirSync(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) visit(path); else if (entry.name === `${filed}.jsonl`) found.push(path) } }
    visit(home)
    const lines = found.length === 1 ? readFileSync(found[0]!, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as { recordId?: string; payload?: { kind?: string } }) : []
    return lines.find(line => line.payload?.kind === 'output')?.recordId ?? ''
  })()
  const replayed = await run(['--resume', filed, '--replay-to', firstReply, 'FILE_THIRD'])
  check('a branch taken back to an earlier reply with --replay-to keeps it too', firstReply !== '' && completed(replayed) && replayed.system === fromFile.system, `reply ${firstReply} · rc ${replayed.code} ${replayed.status} ${replayed.error} · ${head(replayed.system)}`)

  console.log("\n§8 the fold's own restamp writes the brief again, so it stands behind the boundary; no other restamp does")
  {
    const state = await import('../../src/bootstrap/state.ts')
    const storage = await import('../../src/utils/sessionStorage.ts')
    const inProcess = randomUUID()
    state.switchSession(inProcess as never)
    storage.clearSessionMetadata()
    storage.saveSessionBrief('brief', BRIEF)
    storage.adoptResumedSessionFile()
    const file = storage.getTranscriptPath()
    const stored = (): string[] => readFileSync(file, 'utf8').split('\n').filter(line => line.includes('"metaKind":"session-brief"')).map(line => String((JSON.parse(line) as { payload: { fields: { brief?: string } } }).payload.fields.brief))
    check('the row is written when the record is first known', stored().join('|') === BRIEF, JSON.stringify(stored().map(text => text.slice(0, 24))))
    storage.adoptResumedSessionFile()
    storage.adoptResumedSessionFile()
    check('the restamps of a resume and of an exit add none', stored().length === 1, String(stored().length))
    storage.reAppendSessionMetadata()
    check('the restamp a fold runs behind its boundary writes it once more', stored().join('|') === [BRIEF, BRIEF].join('|'), String(stored().length))
    storage.saveSessionBrief('brief', BRIEF)
    check('the flag given again with the text the record already holds writes nothing', stored().length === 2, String(stored().length))
    storage.saveSessionBrief('brief', '')
    storage.reAppendSessionMetadata()
    check('an empty brief is a row like any other, and the fold after it writes it again behind its boundary', stored().join('|') === [BRIEF, BRIEF, '', ''].join('|'), JSON.stringify(stored().map(text => text.slice(0, 24))))
    const { loadTranscriptFile: reread } = await import('../../src/utils/sessionStorage/loading.ts')
    check('the record read back yields the empty brief, not an absent one', (await reread(file)).sessionBriefs.get(inProcess as never) === '')
    storage.clearSessionMetadata()
  }

  console.log('\n§9 a session of many turns writes the brief once')
  const node = Bun.which('node')
  const api = await startFixtureApi([{ kind: 'text', text: 'ONE' }, { kind: 'text', text: 'TWO' }, { kind: 'text', text: 'THREE' }, handoffTurn(), handoffTurn(), handoffTurn()])
  const scratch = scratchHome('session-brief-runner-')
  mkdirSync(join(scratch.home, 'tmp'), { recursive: true })
  const host = hostRunner({ dist, node: node ?? 'node', cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, TMPDIR: join(scratch.home, 'tmp'), MERCURY_TMPDIR: join(scratch.home, 'tmp'), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: FIXTURE_API_KEY }, argv: ['--model', 'claude-opus-4-8', '--brief', BRIEF] })
  try {
    await host.initialize({}, 90_000)
    for (const turn of [1, 2, 3]) {
      await host.prompt(`RUNNER_PROMPT_${turn}`)
      await host.waitFor(`outcome ${turn}`, row => row.type === 'outcome' && row.turn === turn, 90_000)
    }
    await host.stop()
    const asked = api.requests.filter(request => request.path.includes('/v1/messages') && !request.path.includes('count_tokens') && !isHandoffRequest(request))
    const systems = asked.map(request => ((request.body ?? {}) as { system?: Array<{ text?: string }> }).system?.map(block => block.text ?? '').at(-1) ?? '')
    check('the runner door rode the brief on each of its three turns', systems.length === 3 && systems.every(system => system.includes(BRIEF)), `${systems.length} requests`)
    const files: string[] = []
    const visit = (folder: string): void => { for (const entry of readdirSync(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) visit(path); else if (entry.name.endsWith('.jsonl') && path.includes('/projects/') && !path.includes('/lineage/')) files.push(path) } }
    visit(scratch.home)
    const stored = files.flatMap(file => readFileSync(file, 'utf8').split('\n').filter(line => line.includes('"metaKind":"session-brief"')))
    check('its record holds the brief in one row after three turns', files.length === 1 && stored.length === 1, `${files.length} record(s) · ${stored.length} row(s)`)
    const session = files.length === 1 ? files[0]!.split('/').at(-1)!.replace(/\.jsonl$/, '') : ''
    const again = await startFixtureApi([{ kind: 'text', text: 'FOUR' }, handoffTurn(), handoffTurn()])
    const loaded = hostRunner({ dist, node: node ?? 'node', cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, TMPDIR: join(scratch.home, 'tmp'), MERCURY_TMPDIR: join(scratch.home, 'tmp'), ANTHROPIC_BASE_URL: again.url, ANTHROPIC_API_KEY: FIXTURE_API_KEY }, argv: ['--model', 'claude-opus-4-8', '--resume', session] })
    try {
      await loaded.initialize({}, 90_000)
      await loaded.prompt('RUNNER_PROMPT_4')
      await loaded.waitFor('the outcome of the resumed runner', row => row.type === 'outcome', 90_000)
      await loaded.stop()
      const resumedAsk = again.requests.filter(request => request.path.includes('/v1/messages') && !request.path.includes('count_tokens') && !isHandoffRequest(request))
      const resumedSystem = ((resumedAsk[0]?.body ?? {}) as { system?: Array<{ text?: string }> }).system?.map(block => block.text ?? '').at(-1) ?? ''
      check('a runner started on that session by id with no brief flag, as an editor reloading the session starts one, rides the brief', resumedSystem === systems[0], head(resumedSystem))
      check('…and its record still holds one row', readFileSync(files[0] ?? '', 'utf8').split('\n').filter(line => line.includes('"metaKind":"session-brief"')).length === 1)
    } finally {
      await loaded.stop().catch(() => null)
      await again.close()
    }
  } finally {
    await host.stop().catch(() => null)
    await api.close()
    rmSync(scratch.home, { recursive: true, force: true })
    rmSync(scratch.cwd, { recursive: true, force: true })
  }

  console.log("\n§10 a session the daemon hosts: a runner started with the window's flag and claimed for a new session records the brief; a later runner claims it back")
  {
    const node = Bun.which('node') ?? 'node'
    const scratch = scratchHome('session-brief-claim-')
    mkdirSync(join(scratch.home, 'tmp'), { recursive: true })
    const claimed = randomUUID()
    const rowsOf = (): string[] => {
      const files: string[] = []
      const visit = (folder: string): void => { for (const entry of readdirSync(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) visit(path); else if (entry.name === `${claimed}.jsonl`) files.push(path) } }
      visit(scratch.home)
      return files.flatMap(file => readFileSync(file, 'utf8').split('\n').filter(line => line.includes('"metaKind":"session-brief"')).map(line => String((JSON.parse(line) as { payload: { fields: { brief?: string } } }).payload.fields.brief)))
    }
    const turn = async (argv: string[], resume: boolean): Promise<string> => {
      const api = await startFixtureApi([{ kind: 'text', text: 'CLAIMED' }, handoffTurn(), handoffTurn()])
      const host = hostRunner({ dist, node, cwd: scratch.cwd, home: scratch.home, env: { ...scratch.env, MERCURY_CONCOURSE_WORKER: '1', TMPDIR: join(scratch.home, 'tmp'), MERCURY_TMPDIR: join(scratch.home, 'tmp'), ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: FIXTURE_API_KEY }, argv: ['--model', 'claude-opus-4-8', ...argv] })
      try {
        await host.initialize({}, 90_000)
        await host.request('session/claim', { session_id: claimed, model: 'claude-opus-4-8', ...(resume ? { resume: true } : {}) }, 90_000)
        await host.prompt('CLAIMED_PROMPT')
        await host.waitFor('the claimed turn outcome', row => row.type === 'outcome', 90_000)
        await host.stop()
        const asked = api.requests.filter(request => request.path.includes('/v1/messages') && !request.path.includes('count_tokens') && !isHandoffRequest(request))
        return ((asked.at(-1)?.body ?? {}) as { system?: Array<{ text?: string }> }).system?.map(block => block.text ?? '').at(-1) ?? ''
      } finally {
        await host.stop().catch(() => null)
        await api.close()
      }
    }
    try {
      const born = await turn(['--brief', BRIEF], false)
      check('the new session rides the brief and its record holds it in one row', born.includes(BRIEF) && rowsOf().join('|') === BRIEF, `${head(born)} · ${rowsOf().length} row(s)`)
      const back = await turn([], true)
      check('a runner with no flag that claims the session back rides the brief', back === born, head(back))
      const same = await turn(['--brief', BRIEF], true)
      check('a runner started again with the same flag rides it and adds no row', same === born && rowsOf().length === 1, `${rowsOf().length} row(s)`)
      const other = await turn(['--brief', OTHER], true)
      check('a runner started with another brief replaces it: the record holds both in order', other.includes(OTHER) && !other.includes(BRIEF) && rowsOf().join('|') === [BRIEF, OTHER].join('|'), `${head(other)} · ${JSON.stringify(rowsOf().map(text => text.slice(0, 24)))}`)
    } finally {
      rmSync(scratch.home, { recursive: true, force: true })
      rmSync(scratch.cwd, { recursive: true, force: true })
    }
  }

  console.log("\n§11 the addition the switchboard composes for the runners it starts is the host's: it rides while the session is hosted, is never recorded, and never displaces the session's own")
  {
    const { buildConcourseWorkerSpec } = await import('../../src/daemon/concourseWorkers.ts')
    const { buildRunnerInvocation } = await import('../../src/daemon/headlessRun.ts')
    const node = Bun.which('node') ?? 'node'
    const WINDOW_ADD = 'WINDOW_BRIEF_ADD_MARKER: the window was launched with this.'
    const specOf = (session: string | undefined, resume: boolean, windowArgv: string[]): ReturnType<typeof buildConcourseWorkerSpec> => buildConcourseWorkerSpec({ runnerId: 'concourse-w1', workspaceId: cwd, modelKey: 'claude-opus-4-8', ...(session === undefined ? { warm: true } : { sessionId: session, resume }), runnerArgv: windowArgv })
    const NOTE = specOf(undefined, false, []).appendSystemPrompt
    const addRows = (session: string): string[] => briefRows(recordOf(home, session), 'session-brief-add', 'briefAdd')
    const hosted = async (session: string, how: 'born' | 'resumed' | 'claimed' | 'claimed back', windowArgv: string[] = []): Promise<string> => {
      const warm = how === 'claimed' || how === 'claimed back'
      const spec = specOf(warm ? undefined : session, how === 'resumed', windowArgv)
      const api = await startFixtureApi([{ kind: 'text', text: 'HOSTED' }, handoffTurn(), handoffTurn()])
      const host = hostRunner({ dist, node, cwd, home, env: { HOME: home, PATH: process.env.PATH ?? '', TERM: 'dumb', TMPDIR: join(home, 'tmp'), MERCURY_TMPDIR: join(home, 'tmp'), MERCURY_CONFIG_DIR: home, MERCURY_HOME: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_CONCOURSE_WORKER: '1', ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: FIXTURE_API_KEY }, argv: ['--model', 'claude-opus-4-8', '--brief-add', spec.appendSystemPrompt, ...(spec.extraArgv ?? [])] })
      try {
        await host.initialize({}, 90_000)
        if (warm) await host.request('session/claim', { session_id: session, model: 'claude-opus-4-8', ...(how === 'claimed back' ? { resume: true } : {}) }, 90_000)
        await host.prompt('HOSTED_PROMPT')
        await host.waitFor('the hosted turn outcome', row => row.type === 'outcome', 90_000)
        await host.stop()
        const asked = api.requests.filter(request => request.path.includes('/v1/messages') && !request.path.includes('count_tokens') && !isHandoffRequest(request))
        return ((asked.at(-1)?.body ?? {}) as { system?: Array<{ text?: string }> }).system?.map(block => block.text ?? '').at(-1) ?? ''
      } finally {
        await host.stop().catch(() => null)
        await api.close()
      }
    }
    const wired = buildRunnerInvocation(specOf(randomUUID(), false, [])).argv
    check("the scene: the daemon hands a runner its note as the runner's --brief-add, and joins a window's own addition behind it", wired[wired.indexOf('--brief-add') + 1] === NOTE && NOTE.includes('switchboard') && specOf(randomUUID(), false, ['--brief-add', WINDOW_ADD]).appendSystemPrompt === `${NOTE}\n\n${WINDOW_ADD}`, head(NOTE))

    const born = randomUUID()
    const bornSystem = await hosted(born, 'born')
    check('a session born on the switchboard rides the note', bornSystem.endsWith(NOTE), head(bornSystem.slice(-200)))
    check('…and its record holds no addition', addRows(born).length === 0, JSON.stringify(addRows(born).map(text => text.slice(0, 40))))
    const later = await run(['--resume', born, 'LATER_PROMPT'])
    check('a run that continues that session rides what the session rode less the note: nothing of the host is carried', completed(later) && !later.system.includes(NOTE) && later.system === bornSystem.slice(0, -(NOTE.length + 2)), `rc ${later.code} ${later.status} · ${apart(later.system, bornSystem.slice(0, -(NOTE.length + 2)))}`)

    const claimed = randomUUID()
    const claimedSystem = await hosted(claimed, 'claimed')
    check('a warm runner that claims a new session: the note rides and the record holds no addition', claimedSystem.endsWith(NOTE) && addRows(claimed).length === 0, `${head(claimedSystem.slice(-120))} · ${addRows(claimed).length} row(s)`)

    const own = randomUUID()
    const launchedWithAdd = await run(['--brief-add', ADDED, '--session-id', own, 'OWN_PROMPT'])
    const hostedOwn = await hosted(own, 'resumed')
    check('a session that was given an addition and is hosted later rides the note and then its own addition', completed(launchedWithAdd) && hostedOwn.endsWith(`${NOTE}\n\n${ADDED}`), head(hostedOwn.slice(-260)))
    check('…its record still holds its own addition in one row', addRows(own).join('|') === ADDED, JSON.stringify(addRows(own).map(text => text.slice(0, 40))))
    const claimedBack = await hosted(own, 'claimed back')
    check('a warm runner that claims that session back rides the same and writes no row', claimedBack === hostedOwn && addRows(own).join('|') === ADDED, `${apart(claimedBack, hostedOwn)} · ${addRows(own).length} row(s)`)
    const afterHosting = await run(['--resume', own, 'AFTER_PROMPT'])
    check('…and a run that continues it afterwards rides its own addition and not the note', completed(afterHosting) && afterHosting.system.endsWith(ADDED) && !afterHosting.system.includes(NOTE), head(afterHosting.system.slice(-200)))

    const windowed = randomUUID()
    const windowedSystem = await hosted(windowed, 'born', ['--brief-add', WINDOW_ADD])
    check('a window launched with an addition of its own: its session rides the note and that addition', windowedSystem.endsWith(`${NOTE}\n\n${WINDOW_ADD}`), head(windowedSystem.slice(-260)))
    check("…and the record holds none: the addition is the window's", addRows(windowed).length === 0, String(addRows(windowed).length))
    const windowedLater = await run(['--resume', windowed, 'WINDOWED_LATER'])
    check("…so a run that continues that session afterwards rides neither the note nor the window's addition", completed(windowedLater) && !windowedLater.system.includes(NOTE) && !windowedLater.system.includes(WINDOW_ADD), `rc ${windowedLater.code} ${windowedLater.status} · ${head(windowedLater.system.slice(-200))}`)
    const rehosted = await hosted(windowed, 'resumed')
    check('…and a window that hosts it again without the flag rides the note alone', rehosted.endsWith(NOTE) && !rehosted.includes(WINDOW_ADD), head(rehosted.slice(-260)))
    const both = await hosted(own, 'resumed', ['--brief-add', ADDED])
    check("the session's own addition given to the window as well is said once", both.endsWith(`${NOTE}\n\n${ADDED}`) && both.split(ADDED).length === 2 && addRows(own).join('|') === ADDED, head(both.slice(-260)))

    const briefed = randomUUID()
    const briefedSystem = await hosted(briefed, 'born', ['--brief', BRIEF])
    const briefedLater = await run(['--resume', briefed, 'BRIEFED_LATER'])
    check('a window launched with a brief: its session records the brief and no addition, and a run that continues it rides the brief without the note', briefedSystem.includes(BRIEF) && briefedSystem.endsWith(NOTE) && briefRows(recordOf(home, briefed)).join('|') === BRIEF && addRows(briefed).length === 0 && completed(briefedLater) && briefedLater.system.includes(BRIEF) && !briefedLater.system.includes(NOTE), `${briefRows(recordOf(home, briefed)).length} brief row(s) · ${addRows(briefed).length} addition row(s) · ${head(briefedLater.system.slice(-160))}`)

    const { runnerArgvFromBoot, refuseRunnerArgv } = await import('../../src/services/switchboard/runnerArgv.ts')
    const bootArgv = runnerArgvFromBoot(['--resume', briefed, '--default-brief', '--model', 'claude-opus-4-8'])
    check('a window launched with --default-brief hands the flag to its runner', bootArgv.join(' ') === '--default-brief' && refuseRunnerArgv(bootArgv) === null && (specOf(briefed, true, bootArgv).extraArgv ?? []).includes('--default-brief'), JSON.stringify(bootArgv))
    const unbriefed = await hosted(briefed, 'resumed', bootArgv).catch((error: unknown) => `THE WINDOW'S RUNNER DID NOT SERVE: ${error instanceof Error ? error.message : String(error)}`)
    const unbriefedLater = await run(['--resume', briefed, 'UNBRIEFED_LATER'])
    check('…and the session it hosts goes back to the default brief, in that window and in the run that continues it', !unbriefed.includes(BRIEF) && unbriefed.endsWith(NOTE) && completed(unbriefedLater) && !unbriefedLater.system.includes(BRIEF) && !unbriefedLater.system.includes(NOTE) && briefRows(recordOf(home, briefed)).join('|') === [BRIEF, 'null'].join('|'), `${head(unbriefed.slice(-200))} · ${JSON.stringify(briefRows(recordOf(home, briefed)).map(text => text.slice(0, 24)))}`)
  }

  console.log('\n§12 a record read from its last fold boundary still yields a brief written before it')
  {
    const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
    const { loadTranscriptFile: load } = await import('../../src/utils/sessionStorage/loading.ts')
    const large = randomUUID()
    const ids = Array.from({ length: 8 }, () => randomUUID())
    const filler = 'A line of an old answer that the fold has already summarised. '.repeat(30_000)
    const stamp = (second: number): string => `2026-10-07T00:00:${String(second).padStart(2, '0')}.000Z`
    const said = (index: number, parent: string | null, role: 'user' | 'assistant', text: string): Record<string, unknown> => role === 'user'
      ? { type: 'user', uuid: ids[index], parentUuid: parent, sessionId: large, cwd, timestamp: stamp(index), message: { role: 'user', content: text } }
      : { type: 'assistant', uuid: ids[index], parentUuid: parent, sessionId: large, cwd, timestamp: stamp(index), message: { id: `msg_${index}`, type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }
    const rowsOfRecord = [
      { type: 'session-brief', sessionId: large, brief: BRIEF },
      { type: 'session-brief-add', sessionId: large, briefAdd: ADDED },
      said(0, null, 'user', 'the first prompt'),
      said(1, ids[0]!, 'assistant', filler),
      said(2, ids[1]!, 'user', 'the second prompt'),
      said(3, ids[2]!, 'assistant', filler),
      said(4, ids[3]!, 'user', 'the third prompt'),
      said(5, ids[4]!, 'assistant', filler),
      { type: 'system', subtype: 'compact_boundary', uuid: ids[6], parentUuid: null, logicalParentUuid: ids[5], sessionId: large, cwd, timestamp: stamp(6), level: 'info', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 100_000 } },
      { type: 'user', uuid: ids[7], parentUuid: ids[6], sessionId: large, cwd, timestamp: stamp(7), isCompactSummary: true, message: { role: 'user', content: 'The summary of the folded conversation.' } },
    ]
    const file = join(home, `${large}.jsonl`)
    writeFileSync(file, encodeSeedTranscript(rowsOfRecord, large))
    const size = readFileSync(file).length
    const read = await load(file)
    check('the scene: the record is larger than the size from which a load starts at the last boundary, and that load leaves the old answers unread', size > 5 * 1024 * 1024 && read.messages.size < 4, `${size} bytes · ${read.messages.size} messages read`)
    check('the brief and its addition, written before the boundary, are still read', read.sessionBriefs.get(large as never) === BRIEF && read.sessionBriefAdds.get(large as never) === ADDED, `${String(read.sessionBriefs.get(large as never)).slice(0, 30)} · ${String(read.sessionBriefAdds.get(large as never)).slice(0, 30)}`)
    const emptyFile = join(home, 'empty-brief-before-the-boundary.jsonl')
    writeFileSync(emptyFile, encodeSeedTranscript([{ type: 'session-brief', sessionId: large, brief: '' }, ...rowsOfRecord.slice(2)], large))
    check('an empty brief written before the boundary is read as empty, not as absent', (await load(emptyFile)).sessionBriefs.get(large as never) === '')
  }

  console.log('\n§13 a resume snapshot an older build left beside the record does not hide the brief')
  {
    const reader = await import('../../src/utils/sessionStorage/transcriptReader.ts')
    const snapshots = await import('../../src/utils/sessionStorage/resumeSnapshot.ts')
    const { loadTranscriptFile: load } = await import('../../src/utils/sessionStorage/loading.ts')
    const file = ((): string => { const found: string[] = []; const visit = (folder: string): void => { for (const entry of readdirSync(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) visit(path); else if (entry.name === `${origin}.jsonl`) found.push(path) } }; visit(home); return found[0] ?? '' })()
    const size = readFileSync(file).length
    reader._resetTranscriptReaderForTesting()
    const view = await reader.readTranscript(file, { policy: 'resume' })
    snapshots.writeResumeSnapshot(file, view.fold, size)
    const sidecar = snapshots.snapshotPathFor(file)
    const written = JSON.parse(readFileSync(sidecar, 'utf8')) as { schemaVersion: number; fold: Record<string, unknown> }
    const withoutTheBrief = { ...written, fold: Object.fromEntries(Object.entries(written.fold).filter(([key]) => key !== 'sessionBriefs' && key !== 'sessionBriefAdds')) }
    check('the scene: the snapshot the product wrote holds the brief and is trusted as written', JSON.stringify(written.fold.sessionBriefs ?? null).includes(BRIEF) && (await snapshots.tryLoadResumeSnapshot(file)) !== null, JSON.stringify(written.fold.sessionBriefs ?? null).slice(0, 80))
    writeFileSync(sidecar, JSON.stringify({ ...withoutTheBrief, schemaVersion: snapshots.SNAPSHOT_SCHEMA - 1 }))
    check('the sidecar of a build that did not know the brief, under the number that build writes, is not trusted', (await snapshots.tryLoadResumeSnapshot(file)) === null)
    reader._resetTranscriptReaderForTesting()
    const fromOlder = await load(file)
    check('…so the load reads the record itself and yields the brief', fromOlder.sessionBriefs.get(origin as never) === BRIEF, String(fromOlder.sessionBriefs.get(origin as never)).slice(0, 40))
    writeFileSync(sidecar, JSON.stringify({ ...withoutTheBrief, schemaVersion: snapshots.SNAPSHOT_SCHEMA }))
    reader._resetTranscriptReaderForTesting()
    const trusted = await load(file)
    check('control: the same sidecar under the current number is trusted and yields no brief, which is why the number moved with the fold', (await snapshots.tryLoadResumeSnapshot(file)) !== null && trusted.sessionBriefs.get(origin as never) === undefined && trusted.messages.size === fromOlder.messages.size, String(trusted.sessionBriefs.get(origin as never)).slice(0, 40))
    rmSync(sidecar, { force: true })
    reader._resetTranscriptReaderForTesting()
  }

  console.log('\n§14 a reader that does not know the two rows skips them and reads the rest')
  const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
  const sourceFile = ((): string => { const found: string[] = []; const visit = (folder: string): void => { for (const entry of readdirSync(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) visit(path); else if (entry.name === `${origin}.jsonl`) found.push(path) } }; visit(home); return found[0] ?? '' })()
  const known = await loadTranscriptFile(sourceFile)
  const unknownFile = join(home, 'a-later-build.jsonl')
  writeFileSync(unknownFile, readFileSync(sourceFile, 'utf8').split('"metaKind":"session-brief"').join('"metaKind":"a-row-of-a-later-build"'))
  const unknown = await loadTranscriptFile(unknownFile)
  check('the scene: the record read as written yields the brief', known.sessionBriefs.get(origin as never) === BRIEF && known.messages.size > 0, `${known.messages.size} messages`)
  check('the same record with the row under a kind the reader has never heard of: every message is read, the row is skipped', unknown.messages.size === known.messages.size && unknown.sessionBriefs.size === 0 && unknown.leafUuids.size === known.leafUuids.size, `${unknown.messages.size} of ${known.messages.size} messages`)

  console.log('\n§15 --default-brief returns a continued session to the default brief')
  {
    const given = randomUUID()
    const start = await run(['--brief', BRIEF, '--brief-add', ADDED, '--session-id', given, 'DEFAULT_FIRST'])
    const back = await run(['--resume', given, '--default-brief', 'DEFAULT_SECOND'])
    const after = await run(['--resume', given, 'DEFAULT_THIRD'])
    const defaultHead = plain.shape.slice(0, 1_000)
    check('the scene: the session was given a brief and an addition', completed(start) && start.system.includes(BRIEF) && start.system.endsWith(ADDED), head(start.system.slice(-200)))
    check('the run that carries the flag rides the default brief, with the addition the session keeps', completed(back) && !back.system.includes(BRIEF) && back.system.endsWith(ADDED) && back.shape.startsWith(defaultHead), `rc ${back.code} ${back.status} · ${back.err.slice(0, 200)} · ${apart(back.shape.slice(0, 1_000), defaultHead)}`)
    check('…and so does the next run without the flag: the brief is forgotten, not set aside for one run', completed(after) && after.system === back.system, apart(after.system, back.system))
    check('the record says so in one row behind the brief\'s own', briefRows(recordOf(home, given)).join('|') === [BRIEF, 'null'].join('|'), JSON.stringify(briefRows(recordOf(home, given)).map(text => text.slice(0, 24))))
    const read = await loadTranscriptFile(((): string => { const found: string[] = []; const visit = (folder: string): void => { for (const entry of readdirSync(folder, { withFileTypes: true })) { const path = join(folder, entry.name); if (entry.isDirectory()) visit(path); else if (entry.name === `${given}.jsonl`) found.push(path) } }; visit(home); return found[0] ?? '' })())
    check('the loader reads that record as a session with no brief and its addition', !read.sessionBriefs.has(given as never) && read.sessionBriefAdds.get(given as never) === ADDED, `${read.sessionBriefs.size} brief(s) · ${read.sessionBriefAdds.size} addition(s)`)
    const fresh = randomUUID()
    const never = await run(['--default-brief', '--session-id', fresh, 'DEFAULT_FRESH'])
    check('given to a session that was never given a brief: the default brief, and no row', ridesDefault(never) && briefRows(recordOf(home, fresh)).length === 0, `rc ${never.code} ${never.status} · ${briefRows(recordOf(home, fresh)).length} row(s)`)
    const refused = await run(['--resume', given, '--default-brief', '--brief', OTHER, 'DEFAULT_BOTH'])
    check('with --brief beside it the run is refused as a usage error and nothing is asked', refused.code === 2 && `${refused.err}${refused.error}`.includes('Use either --brief or --default-brief, not both') && refused.requests === 0, `rc ${refused.code} · ${refused.requests} request(s) · ${refused.err.slice(0, 200)} · ${refused.error.slice(0, 200)}`)
    const regiven = await run(['--resume', given, '--brief', OTHER, 'DEFAULT_REGIVEN'])
    check('a brief given afterwards is kept again', completed(regiven) && regiven.system.includes(OTHER) && briefRows(recordOf(home, given)).join('|') === [BRIEF, 'null', OTHER].join('|'), JSON.stringify(briefRows(recordOf(home, given)).map(text => text.slice(0, 24))))
    const agentGiven = randomUUID()
    const agentStart = await run(['--agent-defs', agentDefinitions, '--agent', 'fixture', '--brief', BRIEF, '--session-id', agentGiven, 'DEFAULT_AGENT'])
    const agentBack = await run(['--agent-defs', agentDefinitions, '--resume', agentGiven, '--default-brief', 'DEFAULT_AGENT_BACK'])
    check("a session whose agent has a prompt of its own goes back to that prompt", completed(agentStart) && completed(agentBack) && agentBack.system.includes(AGENT_BRIEF) && !agentBack.system.includes(BRIEF), head(agentBack.system))
    const forkBack = await run(['--resume', given, '--fork', '--default-brief', 'DEFAULT_FORK'])
    check('a fork made with the flag is a session of its own on the default brief, and the session it left keeps its brief', completed(forkBack) && forkBack.session !== undefined && forkBack.session !== given && !forkBack.system.includes(OTHER) && forkBack.shape.startsWith(defaultHead) && briefRows(recordOf(home, given)).at(-1) === OTHER, `fork ${forkBack.session} · ${head(forkBack.system.slice(-160))}`)
  }
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`\n${failures ? 'FAIL' : 'PASS'} session-brief-survives-resume: ${checks} checks, ${failures} failed`)
process.exit(failures ? 1 : 0)
