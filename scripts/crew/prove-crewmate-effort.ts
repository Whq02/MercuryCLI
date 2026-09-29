#!/usr/bin/env bun
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, readJson, record, ROOT, sleep, toolResultOf, TURN_MS } from './crew-world.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'crewmate-effort-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_EFFORT_LEVEL
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const runner = await import('../../src/tools/AgentTool/runAgent.ts')
const defaults = await import('../../src/utils/agentDefaults.ts')
const { crewAgentFactsOf } = await import('../../src/services/engine-connector/crewFacts.ts')
const { projectWorkRoster } = await import('../../src/utils/task/workRoster.ts')
const { createTaskStateBase } = await import('../../src/Task.ts')
const { readCrewmateTranscriptFile } = await import('../../src/components/tasks/useCrewmateTranscript.ts')
type WorkRow = import('../../src/services/engine-connector/types.ts').WorkRowV1
type TaskState = import('../../src/tasks/types.ts').TaskState

const CREW = 'effort-truth'
const SEAT = 'deep'
const SEAT_MODEL = 'claude-opus-4-6'
const SEAT_GATE = 'opus-4-6'
const FIRST = 'START-SPAWN'
const SECOND = 'SECOND-TURN'
const SEAT_ONE = 'SEAT-ANSWER-ONE'
const SEAT_TWO = 'SEAT-ANSWER-TWO'
const SPAWN_ID = 'toolu_deep_spawn'
const MESSAGE_ID = 'toolu_deep_message'
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const slice = (text: string, from: string, length: number): string => {
  const at = text.indexOf(from)
  return at < 0 ? '' : text.slice(at, at + length)
}
const tally = makeTally('prove-crewmate-effort')

tally.section('§1 the ladder: the call\'s word is the pin, else the definition\'s, else the configured default')
{
  const defaultWord = defaults.subagentDefaultEffort()
  const pinned = runner.resolveAgentEffort({ effortOverride: 'max', useExactTools: undefined, definitionEffort: undefined, defaultEffort: defaultWord })
  tally.check('an Agent call asking max resolves max on the one ladder', pinned === 'max', String(pinned))
  const unpinned = runner.resolveAgentEffort({ effortOverride: undefined, useExactTools: undefined, definitionEffort: undefined, defaultEffort: defaultWord })
  tally.check(`a call without the word resolves the configured default (${defaultWord})`, unpinned === defaultWord, String(unpinned))
  tally.check("the agent's own word is the pin", runner.agentOwnEffortWord({ effortOverride: 'max', useExactTools: undefined, definitionEffort: 'low' }) === 'max')
}

tally.section('§2 the spawn seam: the crewmate arm forwards the call\'s effort to the crewmate\'s run (call-shaped pins)')
{
  const tool = src('src/tools/AgentTool/AgentTool.tsx')
  const arm = slice(tool, 'const spawned = await spawnCrewmate(', 900)
  tally.check('the crewmate arm hands spawnCrewmate the call\'s effort', /effort: input\.effort/.test(arm), arm.replace(/\s+/g, ' ').slice(0, 300))
  const spawn = src('src/tools/shared/spawnMultiAgent.ts')
  const config = slice(spawn, 'export type SpawnCrewmateConfig = {', 500)
  tally.check('SpawnCrewmateConfig carries an optional effort word', /\n\s*effort\?: string/.test(config), config.replace(/\s+/g, ' ').slice(0, 300))
  const inProcess = slice(spawn, 'startInProcessCrewmate({', 1400)
  tally.check('the in-process strategy hands the word to the runner as effortOverride', /effortOverride: (?:config|prepared)\.effort/.test(inProcess), inProcess.replace(/\s+/g, ' ').slice(0, 400))
  tally.check('the in-process strategy hands the runner the transcript agent id the spawn minted', /transcriptAgentId/.test(inProcess), inProcess.replace(/\s+/g, ' ').slice(0, 400))
  tally.check('no pane child command remains (the one strategy is in-process)', !/function childCommand\(/.test(spawn))
  const runnerSource = src('src/utils/swarm/inProcessRunner.ts')
  const run = slice(runnerSource, 'for await (const message of runAgent({', 1200)
  tally.check('the runner hands runAgent the effortOverride so the one ladder resolves it', /effortOverride/.test(run), run.replace(/\s+/g, ' ').slice(0, 400))
  tally.check('the runner hands runAgent one stable agent id for the crewmate\'s whole life (override.agentId)', /agentId: config\.transcriptAgentId/.test(run), run.replace(/\s+/g, ' ').slice(0, 400))
  tally.check('the runner records the resolved word on the task (onResolvedIdentity)', /onResolvedIdentity/.test(run), run.replace(/\s+/g, ' ').slice(0, 400))
}

tally.section('§3 the crew facts: the crewmate row carries the resolved word and the transcript id')
{
  const task = {
    ...createTaskStateBase('t1effort00', 'in_process_crewmate', `${SEAT}: the seat`),
    type: 'in_process_crewmate',
    status: 'running',
    identity: { agentId: `${SEAT}@${CREW}`, agentName: SEAT, crewName: CREW, planModeRequired: false, parentSessionId: 'lead' },
    prompt: 'the seat',
    model: SEAT_MODEL,
    effort: 'max',
    transcriptAgentId: 'a1effort00',
    awaitingPlanApproval: false,
    isIdle: false,
    shutdownRequested: false,
    messages: [],
  } as unknown as TaskState
  const row = projectWorkRoster({ t1effort00: task })[0] as (WorkRow & { effort?: string; transcriptAgentId?: string }) | undefined
  tally.check('the roster row of a crewmate carries its resolved effort', row?.effort === 'max', JSON.stringify(row))
  tally.check('the roster row of a crewmate carries its transcript agent id', row?.transcriptAgentId === 'a1effort00', JSON.stringify(row))
  const facts = row === undefined ? null : (crewAgentFactsOf(row, 'lead') as ({ effort?: string | null; transcriptAgentId?: string | null } | null))
  tally.check('the crew facts carry the word (effort max)', facts?.effort === 'max', JSON.stringify(facts))
  tally.check('the crew facts carry the transcript agent id', facts?.transcriptAgentId === 'a1effort00', JSON.stringify(facts))
  const bare = crewAgentFactsOf({ id: 't2', agentId: `${SEAT}-2@${CREW}`, kind: 'crewmate', name: `${SEAT}-2`, status: 'running', startTime: Date.now(), crew: CREW } as WorkRow, 'lead') as ({ effort?: string | null; transcriptAgentId?: string | null } | null)
  tally.check('a row without the fields reads as today: no word, no id (null, never a fabricated default)', bare !== null && bare.effort === null && bare.transcriptAgentId === null, JSON.stringify(bare))
}

const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn =>
  ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const script: ScriptedTurn[] = [
  lead(
    {
      kind: 'tool_use',
      id: SPAWN_ID,
      name: 'Agent',
      input: { name: SEAT, crew_name: 'crew', model: SEAT_MODEL, effort: 'max', subagent_type: 'mercury-general', description: 'the deep seat', prompt: 'DEEP-WORK: reply once.' },
    },
    FIRST,
  ),
  lead({ kind: 'text', text: 'SPAWN-REPORTED' }, FIRST),
  { kind: 'text', text: SEAT_ONE, whenModel: SEAT_GATE },
  lead({ kind: 'tool_use', id: MESSAGE_ID, name: 'SendMessage', input: { to: SEAT, message: 'MORE-WORK: reply once more.', summary: 'more work' } }, SECOND),
  lead({ kind: 'text', text: 'LEAD-DONE' }, SECOND),
  { kind: 'text', text: SEAT_TWO, whenModel: SEAT_GATE },
]

function agentFilesUnder(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) out.push(...agentFilesUnder(path, suffix))
    else if (entry.startsWith('agent-') && entry.endsWith(suffix)) out.push(path)
  }
  return out.sort()
}
const recordLines = (file: string): number => readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '').length
type SeatRequest = { body: { model?: string; output_config?: { effort?: string } } }
const seatRequests = (world: Awaited<ReturnType<typeof makeWorld>>): SeatRequest[] =>
  world.fixture.messageRequests().filter(request => String((request.body as { model?: string } | null)?.model ?? '').includes(SEAT_GATE)) as unknown as SeatRequest[]

tally.section('§4 the drive: an Agent call with crew_name and effort max reaches the seat\'s run, its wire and its sidecar')
const world = await makeWorld('crewmate-effort', script)
const session = bootLead(world, [], ['Agent', 'SendMessage'])
const projects = join(world.config, 'projects')
try {
  session.submit(`${FIRST}: create the crew and the deep seat.`)
  await session.waitFor('the lead never reported the spawn', () => session.stdout().includes('SPAWN-REPORTED'), TURN_MS)
  const spawnAnswer = toolResultOf(world, SPAWN_ID)
  record('agent-tool-answer.txt', `${spawnAnswer?.text ?? ''}\nis_error=${String(spawnAnswer?.isError)}\n`)
  tally.check('the Agent tool answered with the spawn', spawnAnswer !== null && !spawnAnswer.isError && /Crewmate spawned/.test(spawnAnswer.text), spawnAnswer?.text.slice(0, 200))
  const firstSeen = Date.now() + TURN_MS / 3
  while (seatRequests(world).length < 1 && Date.now() < firstSeen) await sleep(50)
  const firstRequest = seatRequests(world)[0]
  const firstEffort = firstRequest?.body.output_config?.effort
  tally.check(`the seat's first request carries the asked word on the wire (output_config.effort max)`, firstEffort === 'max', `the wire read ${String(firstEffort)}`)
  const sidecarSeen = Date.now() + TURN_MS / 3
  while (agentFilesUnder(projects, '.meta.json').length < 1 && Date.now() < sidecarSeen) await sleep(50)
  const sidecars = agentFilesUnder(projects, '.meta.json')
  const sidecar = sidecars[0] === undefined ? null : readJson<{ effort?: string; effortOverride?: string; model?: string }>(sidecars[0])
  record('seat-sidecar.json', JSON.stringify({ files: sidecars, sidecar }, null, 2) + '\n')
  tally.check('the seat\'s sidecar records the resolved word (effort max)', sidecar?.effort === 'max', JSON.stringify(sidecar))
  tally.check('the seat\'s sidecar records the pin the call asked (effortOverride max)', sidecar?.effortOverride === 'max', JSON.stringify(sidecar))
  tally.check('the sidecar names the seat\'s model', sidecar?.model === SEAT_MODEL, JSON.stringify(sidecar))
  const firstAnswerSeen = Date.now() + TURN_MS / 3
  const firstAnswerLanded = (): boolean => {
    const only = agentFilesUnder(projects, '.jsonl')
    return only.length === 1 && readFileSync(only[0]!, 'utf8').includes(SEAT_ONE)
  }
  while (!firstAnswerLanded() && Date.now() < firstAnswerSeen) await sleep(50)
  const firstFiles = agentFilesUnder(projects, '.jsonl')
  const firstRows = firstFiles[0] === undefined ? 0 : recordLines(firstFiles[0])
  tally.check('the seat\'s first turn landed in one transcript file named by the seat\'s own agent id', firstFiles.length === 1 && /agent-a[0-9a-z]{8}\.jsonl$/.test(firstFiles[0] ?? ''), firstFiles.join(' | '))

  session.submit(`${SECOND}: message the seat once more.`)
  await session.waitFor('the second turn never settled', () => session.stdout().includes('LEAD-DONE'))
  const message = toolResultOf(world, MESSAGE_ID)
  tally.check('the message reached the seat', message !== null && !message.isError, message?.text.slice(0, 200))
  const secondSeen = Date.now() + TURN_MS / 3
  while (seatRequests(world).length < 2 && Date.now() < secondSeen) await sleep(50)
  const secondRequest = seatRequests(world)[1]
  const secondEffort = secondRequest?.body.output_config?.effort
  tally.check('the seat\'s second turn carries the same word (the pin rides every turn)', secondEffort === 'max', `the wire read ${String(secondEffort)}`)
  const grown = Date.now() + TURN_MS / 3
  const secondAnswerLanded = (): boolean => {
    const only = agentFilesUnder(projects, '.jsonl')
    return only.length === 1 && recordLines(only[0]!) > firstRows && readFileSync(only[0]!, 'utf8').includes(SEAT_TWO)
  }
  while (!secondAnswerLanded() && Date.now() < grown) await sleep(100)
  const files = agentFilesUnder(projects, '.jsonl')
  const rows = files.map(file => recordLines(file))
  record('seat-transcripts.txt', files.map((file, index) => `${file} ${rows[index]} lines`).join('\n') + '\n')
  tally.check('after two turns the seat still has exactly ONE transcript file (one id for its whole life — the file the crew view reads)', files.length === 1, `${files.length} files: ${files.join(' | ')}`)
  tally.check('…and that file grew with the second turn', files.length === 1 && (rows[0] ?? 0) > firstRows, `${firstRows} → ${String(rows[0])} lines`)
  const seatFile = files.length === 1 && files[0] !== undefined ? readFileSync(files[0], 'utf8') : ''
  tally.check('the one file holds both of the seat\'s answers', seatFile.includes(SEAT_ONE) && seatFile.includes(SEAT_TWO), `${files.length} files`)
  const writerId = /agent-(a[0-9a-z]{8})\.jsonl$/.exec(files[0] ?? '')?.[1] ?? ''
  const viewRows = writerId === '' ? [] : await readCrewmateTranscriptFile(files[0]!, writerId)
  const viewText = JSON.stringify(viewRows)
  tally.check('the crew view\'s reader, given the file and the writer\'s id, returns rows holding both turns (what the crewmate\'s pane paints)', viewRows.length > 0 && viewText.includes(SEAT_ONE) && viewText.includes(SEAT_TWO), `${viewRows.length} rows by id ${writerId}`)
} finally {
  await session.end()
  await closeWorld(world)
  rmSync(HOME, { recursive: true, force: true })
}
tally.finish()
