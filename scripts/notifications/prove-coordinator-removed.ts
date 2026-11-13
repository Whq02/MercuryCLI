#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi } from '../lib/fixtureApi.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const SENTENCE = 'The Concourse coordinator has been removed, so --coordinator-on and --coordinator-off change nothing: n on the board starts a session.'
const MODEL = 'claude-opus-4-8'
const ANSWER = 'COORDINATOR-REMOVED-ANSWER'
const KEYS = {
  coordinatorEnabled: true,
  concourseCoordinator: { mode: 'agent-assisted', assistModel: 'claude-opus-4-8', effort: 'high' },
  hasSeenCoordinatorOffHint: true,
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'coordinator-removed-')))
const hadItOn = join(scratch, 'had-it-on')
const hadItOnCfg = join(hadItOn, '.mercury')
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = hadItOnCfg
process.env.MERCURY_DAEMON_DIR = join(hadItOn, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.ANTHROPIC_BASE_URL
delete process.env.MERCURY_CREW_DIR

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const j = (value: unknown): string => JSON.stringify(value)
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

type World = { home: string; cfg: string; cwd: string; env: Record<string, string> }
type Ran = { code: number | null; out: string; err: string }

async function main(): Promise<void> {
  const node = Bun.which('node')
  if (!existsSync(DIST) || node === null) {
    check('dist/mercury.mjs and a node binary are present (build first; the pooled gate prebuilds the bundle)', false, DIST)
    return
  }
  const world = (name: string): World => {
    const home = join(scratch, name)
    const cfg = join(home, '.mercury')
    const cwd = join(home, 'project')
    mkdirSync(join(cfg, 'tmp'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    seedFirstRun(cfg, [cwd])
    return {
      home,
      cfg,
      cwd,
      env: {
        HOME: home,
        PATH: `/usr/bin:/bin:${dirname(node)}`,
        TERM: 'dumb',
        MERCURY_CONFIG_DIR: cfg,
        MERCURY_TMPDIR: join(cfg, 'tmp'),
        MERCURY_DAEMON_DIR: join(home, 'daemon'),
        MERCURY_LOCAL_PROBE_TARGETS: 'none',
        MERCURY_CREDENTIAL_STORE: 'file',
        ANTHROPIC_API_KEY: 'fixture-key-000',
      },
    }
  }
  const mercury = async (w: World, args: string[]): Promise<Ran> => {
    const fixture = await startFixtureApi([
      { kind: 'text', text: ANSWER },
      { kind: 'text', text: ANSWER },
      { kind: 'text', text: ANSWER },
    ])
    const child = spawn(node, [DIST, ...args], { cwd: w.cwd, env: { ...w.env, ANTHROPIC_BASE_URL: fixture.url }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', d => { out += String(d) })
    child.stderr.on('data', d => { err += String(d) })
    const code = await new Promise<number | null>(done => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
      child.on('close', c => { clearTimeout(timer); done(c) })
    })
    await fixture.close()
    return { code, out, err }
  }
  const configOf = (w: World): Record<string, unknown> => JSON.parse(readFileSync(join(w.cfg, '.mercury.json'), 'utf8')) as Record<string, unknown>
  const giveKeys = (w: World): void => writeFileSync(join(w.cfg, '.mercury.json'), `${JSON.stringify({ ...configOf(w), ...KEYS }, null, 2)}\n`)
  const keysStand = (w: World): boolean => Object.entries(KEYS).every(([key, value]) => j(configOf(w)[key]) === j(value))
  const oneShot = ['run', '--model', MODEL, 'say the word']

  section('§1 the two flags are accepted, say one sentence and write nothing')
  {
    const plain = world('plain')
    const help = await mercury(plain, ['--help'])
    check('mercury --help prints its page', help.code === 0 && help.out.includes('--concourse-off'), `exit ${help.code}`)
    check('…and names neither flag', !help.out.includes('--coordinator-on') && !help.out.includes('--coordinator-off'), help.out.split('\n').filter(l => l.includes('--coordinator-o')).join(' | '))

    const quiet = await mercury(plain, oneShot)
    check('a run with neither flag answers and says nothing on stderr', quiet.code === 0 && quiet.out.includes(ANSWER) && quiet.err === '', j({ code: quiet.code, err: quiet.err.slice(0, 300) }))

    const on = world('flag-on')
    const turnedOn = await mercury(on, ['--coordinator-on', ...oneShot])
    check('--coordinator-on: the start goes on and the run answers', turnedOn.code === 0 && turnedOn.out.includes(ANSWER), j({ code: turnedOn.code, out: turnedOn.out.slice(0, 200) }))
    check('…stderr carries the one sentence, once, and nothing else', turnedOn.err === `${SENTENCE}\n`, j(turnedOn.err.slice(0, 400)))
    check('…and the config holds no coordinator key', !('coordinatorEnabled' in configOf(on)) && !('concourseCoordinator' in configOf(on)), j(Object.keys(configOf(on))))

    const both = world('flag-both')
    const twice = await mercury(both, ['--coordinator-off', '--coordinator-on', ...oneShot])
    check('both flags on one line: still one sentence, the run answers, no key written', twice.code === 0 && twice.out.includes(ANSWER) && twice.err === `${SENTENCE}\n` && !('coordinatorEnabled' in configOf(both)), j({ code: twice.code, err: twice.err.slice(0, 400) }))

    const kept = world('flag-off-on-a-home-that-had-it')
    giveKeys(kept)
    const turnedOff = await mercury(kept, ['--coordinator-off', ...oneShot])
    check('--coordinator-off on a home that had it on: one sentence, the run answers', turnedOff.code === 0 && turnedOff.out.includes(ANSWER) && turnedOff.err === `${SENTENCE}\n`, j({ code: turnedOff.code, err: turnedOff.err.slice(0, 400) }))
    check('…and its three keys are in the file as an earlier version left them', keysStand(kept), j(configOf(kept)))

    const after = await mercury(plain, ['run', '--coordinator-on', 'say the word'])
    check('the flags are the root\'s alone, as before: behind run one is an unknown option', after.code !== 0 && /unknown option '--coordinator-on'/.test(after.err) && !after.err.includes(SENTENCE), j({ code: after.code, err: after.err.slice(0, 200) }))

    const source = readFileSync(join(ROOT, 'src', 'main.tsx'), 'utf8')
    check('the sentence is written in one place, before the screen is taken', source.split(SENTENCE).length === 2 && source.indexOf(SENTENCE) !== -1 && source.indexOf(SENTENCE) < source.indexOf('await interactiveLaunch({'), `${source.split(SENTENCE).length - 1} time(s)`)
  }

  section('§2 a home that had the coordinator on starts clean and keeps every file it wrote')
  {
    const w = world('had-it-on')
    giveKeys(w)
    const { enableConfigs } = await import('../../src/utils/config.ts')
    enableConfigs()
    const identity = await import('../../src/services/crew/identity.ts')
    const { buildConcourseSnapshot, writeConcourseDraft } = await import('../../src/services/concourse/concourseSnapshot.ts')
    const { boardRowsOf } = await import('../../src/components/concourse/contracts.ts')
    const { projectIdentity } = await import('../../src/utils/bootCardFacts.ts')

    const conversation = join(w.cfg, 'coordinator-conversation.json')
    writeFileSync(conversation, `${j({ schema: 1, entries: [{ kind: 'operator', text: 'launch two sessions', at: 1 }], contextTokens: 1200 })}\n`)
    const journal = join(identity.crewStoreRoot(), 'coordinator-receipt-journal.json')
    mkdirSync(dirname(journal), { recursive: true })
    writeFileSync(journal, `${j({ schema: 1, seq: 2, consumedSeq: 1, rows: [{ seq: 2, verb: 'session.launch', objectRef: 'a session', outcome: 'applied' }] })}\n`)
    await writeConcourseDraft('a new session, half written', w.cfg)
    const draft = join(w.cfg, 'concourse-draft.json')
    writeFileSync(draft, j({ ...(JSON.parse(readFileSync(draft, 'utf8')) as Record<string, unknown>), coordinatorDraft: 'ask the board something', coordinatorDraftCaret: 7 }))
    const agent = await identity.ensureAgentIdentity({ displayName: 'Concourse Coordinator', binding: { bindingKind: 'native', bindingId: 'concourse-coordinator' } })
    await identity.linkAgentRole(agent.agentId, 'coordinator', 'concourse:coordinator')
    const collisions = join(w.home, 'daemon', 'concourse-collisions.json')
    mkdirSync(dirname(collisions), { recursive: true })
    const fork = (branchName: string, consumedAt?: number): Record<string, unknown> => ({
      schema: 1,
      kind: 'authored-work-retained',
      workspaceId: w.cwd,
      holders: [{ workerId: `w-${branchName}` }],
      observedAt: Date.now() - 60_000,
      branchName: `mercury/${branchName}`,
      ...(consumedAt !== undefined ? { consumedAt } : {}),
    })
    writeFileSync(collisions, `${j({ version: 1, rows: [fork('asked-about', Date.now() - 30_000), fork('never-asked')] })}\n`)

    const left = [conversation, journal, draft, collisions]
    const before = left.map(sha)
    const ran = await mercury(w, oneShot)
    check('a run in that home answers and says nothing on stderr', ran.code === 0 && ran.out.includes(ANSWER) && ran.err === '', j({ code: ran.code, err: ran.err.slice(0, 300) }))
    check('its conversation, its receipt journal, the draft it left and the collision evidence are byte for byte what they were', j(left.map(sha)) === j(before), left.filter((p, i) => sha(p) !== before[i]).join(', '))
    check('its three config keys are in the file as it left them', keysStand(w), j(configOf(w)))
    const agents = await identity.listAgents()
    const mine = agents.find(a => a.displayName === 'Concourse Coordinator')
    const roles = mine === undefined ? [] : await identity.listAgentRoles(mine.agentId)
    check('the crew store still holds the identity it gave its coordinator, in the role coordinator', mine !== undefined && roles.some(r => r.role === 'coordinator'), j({ agents: agents.map(a => a.displayName), roles }))

    const snapshot = await buildConcourseSnapshot({ project: projectIdentity(w.cwd), recordsDir: join(w.home, 'daemon'), crewDir: identity.crewStoreRoot(), draftDir: w.cfg, nowMs: Date.now() })
    const titles = boardRowsOf(snapshot).flatMap(r => (r.kind === 'session' ? [r.row.title] : []))
    check('the board over that home carries no coordinator and no seat held for one', !('coordinator' in snapshot) && !('seatsHeld' in snapshot.counts), Object.keys(snapshot).join(','))
    check('a fork an earlier version had already asked about stays off the board, one it never asked about is listed', titles.includes('mercury/never-asked') && !titles.includes('mercury/asked-about'), j(titles))
    check('the draft of the new-session row is the one it left', snapshot.newSession.draft === 'a new session, half written', j(snapshot.newSession))
  }

  section('§3 what carries the word and is not the coordinator stands')
  {
    const { AGENT_ROLES } = await import('../../src/services/crew/identity.ts')
    check('the crew\'s role vocabulary goes on accepting coordinator', (AGENT_ROLES as readonly string[]).includes('coordinator'))
    const help = await mercury(world('mcp-help'), ['mcp-server', '--help'])
    check('mercury mcp-server keeps --coordinator <session-id>, the session an automation client addresses by that role', help.code === 0 && help.out.includes('--coordinator <session-id>'), `exit ${help.code}`)
  }
}

await main()
rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? `prove-coordinator-removed: ALL LAWS HOLD (${checks} checks)` : `prove-coordinator-removed: ${failures} FAILURE(S) of ${checks}`}`)
process.exit(failures === 0 ? 0 : 1)
