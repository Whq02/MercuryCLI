#!/usr/bin/env bun
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { open } from '../../src/crew/board/store.ts'
import { bootLead, closeWorld, findFiles, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, record, sleep, toolResultOf, TURN_MS } from './crew-world.ts'

const PEER_MODEL = 'claude-opus-4-6'
const FILES = 8
const LINES = 420
const BURST = 6
const NOTE = 'changed on disk since your last read or edit'
const WHERE = "getChangedFiles in src/engine/attachments/fileAttachments.ts walks the read list of the seat it is handed, and makeMaybe in src/engine/attachments/turnAttachments.ts must hand a pass only the scan its own seat started (the pending producer is keyed by the seat's owner key)"

const SEATS = {
  reader: 'READER-SEAT-ONLY',
  woken: 'WOKEN-SEAT-ONLY',
  messaged: 'MESSAGED-SEAT-ONLY',
  resumed: 'RESUMED-SEAT-ONLY',
} as const
type SeatName = keyof typeof SEATS
const ROADS: Record<Exclude<SeatName, 'reader'>, string> = {
  woken: "woken by the reader's board post",
  messaged: 'sent a message by the lead',
  resumed: 'resumed by the lead',
}
const CREW: SeatName[] = ['reader', 'woken', 'messaged', 'resumed']

type Call = { name: string; input: Record<string, unknown>; id?: string }
type Step = { kind: 'text'; text: string } | ({ kind: 'tool_use' } & Call) | { kind: 'paced_tool_use'; preDeltas: string[]; gapMs: number; tools: Call[] }
const say = (text: string): Step => ({ kind: 'text', text })
const call = (one: Call): Step => ({ kind: 'tool_use', ...one })
const calls = (...tools: Call[]): Step => ({ kind: 'paced_tool_use', preDeltas: [], gapMs: 1, tools })
const gated = (step: Step, model: string, gates: { whenModel: string; whenSaid?: string; whenBody?: string }): ScriptedTurn => (step.kind === 'paced_tool_use' ? { ...step, ...gates } : { ...step, model, ...gates })
const lead = (step: Step, said: string): ScriptedTurn => gated(step, LEAD_MODEL, { whenModel: LEAD_GATE, whenSaid: said })
const idle = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-IDLE', model: LEAD_MODEL, whenModel: LEAD_GATE })
const peer = (name: SeatName, step: Step): ScriptedTurn => gated(step, PEER_MODEL, { whenModel: 'opus-4-6', whenBody: SEATS[name] })

const scratch = mkdtempSync(join(tmpdir(), 'changed-file-note-files-'))
const gate = (name: string): string => join(scratch, `gate-${name}`)
const text = (tag: string): string => Array.from({ length: LINES }, (_, i) => `${tag} line ${i} ${'x'.repeat(40)}`).join('\n') + '\n'
const filesOf = (owner: string): string[] => Array.from({ length: FILES }, (_, i) => join(scratch, `${owner}-read-${i}.txt`))
const leadFiles = filesOf('lead')
const readerFiles = filesOf('reader')
for (const path of [...leadFiles, ...readerFiles]) writeFileSync(path, text('before'))
const changeOnDisk = (paths: string[]): void => {
  const later = new Date(Date.now() + 3000)
  for (const path of paths) {
    writeFileSync(path, text('after'))
    utimesSync(path, later, later)
  }
}

const read = (path: string): Call => ({ name: 'Read', input: { file_path: path } })
const waitAt = (mark: string, signal: string): Call => ({ name: 'Bash', input: { command: `touch ${JSON.stringify(gate(mark))}; until [ -e ${JSON.stringify(gate(signal))} ]; do sleep 0.01; done`, description: 'Wait for the signal' } })
const quick = (): Call => ({ name: 'Bash', input: { command: 'true', description: 'One quick step' } })
const burst = (name: SeatName): ScriptedTurn[] => Array.from({ length: BURST }, () => peer(name, call(quick())))
const launch = (name: SeatName, words: string): Call => ({
  name: 'Crewmate',
  id: `launch-${name}`,
  input: { name, description: `The ${name} seat`, prompt: `${SEATS[name]}. ${words}`, crewmate_type: 'mercury-crew', run_in_background: true, model: PEER_MODEL },
})

const script: ScriptedTurn[] = [
  ...leadFiles.map(path => lead(call(read(path)), 'PROMPT-ONE')),
  lead(call(launch('reader', 'Read your files, wait, then post on the board.')), 'PROMPT-ONE'),
  lead(call(launch('woken', 'Declare your wait and finish.')), 'PROMPT-ONE'),
  lead(call(launch('messaged', 'Wait for the signals.')), 'PROMPT-ONE'),
  lead(call(launch('resumed', 'Finish at once.')), 'PROMPT-ONE'),
  lead(say('ONE-DONE'), 'PROMPT-ONE'),
  lead(call({ name: 'ResumeCrewmate', id: 'first-resume', input: { to: 'resumed', message: 'Carry on and wait for the signal.' } }), 'PROMPT-TWO'),
  lead(say('TWO-DONE'), 'PROMPT-TWO'),
  lead(say('THREE-DONE'), 'PROMPT-THREE'),
  lead(
    calls(
      waitAt('lead-ready', 'go-2'),
      { name: 'SendMessage', id: 'lead-message', input: { to: 'messaged', message: 'A-NOTE-FROM-THE-LEAD' } },
      { name: 'ResumeCrewmate', id: 'lead-resume', input: { to: 'resumed', message: 'Carry on once more.' } },
      waitAt('lead-at-sync-2', 'sync-2'),
    ),
    'PROMPT-FOUR',
  ),
  lead(say('FOUR-DONE'), 'PROMPT-FOUR'),
  ...Array.from({ length: 40 }, idle),

  ...readerFiles.map(path => peer('reader', call(read(path)))),
  peer(
    'reader',
    calls(
      waitAt('reader-ready', 'go-1'),
      { name: 'CrewBoard', id: 'reader-post', input: { op: 'post', clientOpId: 'reader-post', kind: 'result', about: 'reader-trigger', text: 'READER-POSTED-ITS-RESULT' } },
      waitAt('reader-at-sync-1', 'sync-1'),
    ),
  ),
  peer('reader', call(waitAt('reader-at-sync-2', 'sync-2'))),
  ...burst('reader'),
  peer('reader', say('READER-DONE')),

  peer('woken', call({ name: 'CrewBoard', id: 'woken-wait', input: { op: 'post', clientOpId: 'woken-wait', kind: 'ask', text: '@main wake me when about reader-trigger' } })),
  peer('woken', say('WOKEN-PARKED')),
  peer('woken', call(waitAt('woken-at-sync-1', 'sync-1'))),
  ...burst('woken'),
  peer('woken', call(waitAt('woken-at-sync-2', 'sync-2'))),
  ...burst('woken'),
  peer('woken', say('WOKEN-DONE')),

  peer('messaged', call(waitAt('messaged-at-sync-1', 'sync-1'))),
  ...burst('messaged'),
  peer('messaged', call(waitAt('messaged-at-sync-2', 'sync-2'))),
  ...burst('messaged'),
  peer('messaged', say('MESSAGED-DONE')),

  peer('resumed', say('RESUMED-RUN-ONE-DONE')),
  peer('resumed', call(waitAt('resumed-at-sync-1', 'sync-1'))),
  ...burst('resumed'),
  peer('resumed', say('RESUMED-RUN-TWO-DONE')),
  peer('resumed', call(waitAt('resumed-at-sync-2', 'sync-2'))),
  ...burst('resumed'),
  peer('resumed', say('RESUMED-DONE')),
]

const tally = makeTally('prove-changed-file-note-reaches-its-reader-only')
const world = await makeWorld('changed-file-note', script)
const settings = join(world.config, 'settings.json')
writeFileSync(settings, JSON.stringify({ ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}), swarm: { enabled: true } }))
const session = bootLead(world, ['--sovereign'], ['Crewmate', 'CrewBoard', 'Bash', 'Read', 'SendMessage', 'ResumeCrewmate'])
let board: ReturnType<typeof open> | undefined

type Block = { type?: string; text?: string; content?: unknown }
type Item = { role?: string; content?: unknown }
type Body = { model?: string; messages?: Item[] }
const textsOf = (content: unknown): string[] => {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return (content as Block[]).flatMap(part => (typeof part.text === 'string' ? [part.text] : part.type === 'tool_result' ? textsOf(part.content) : []))
}
const bodies = (): Body[] => world.fixture.messageRequests().map(request => request.body as Body)
const wireOf = (seat: SeatName | 'lead'): Body[] =>
  seat === 'lead'
    ? bodies().filter(found => found.model === LEAD_MODEL)
    : bodies().filter(found => found.model === PEER_MODEL && JSON.stringify(found.messages ?? []).includes(SEATS[seat]))
const notesOf = (seat: SeatName | 'lead', paths: string[]): string => {
  const last = wireOf(seat).at(-1)
  const parts = (last?.messages ?? []).filter(item => item.role === 'user').flatMap(item => textsOf(item.content))
  return paths.map(path => parts.filter(part => part.includes(`${path} ${NOTE}`)).length).join(',')
}
const shownTo = (seat: SeatName | 'lead', paths: string[]): number => paths.filter(path => wireOf(seat).some(found => JSON.stringify(found.messages ?? []).includes(path))).length
const once = Array.from({ length: FILES }, () => 1).join(',')
const said = (words: string): boolean => bodies().some(found => JSON.stringify(found.messages ?? []).includes(words))
const stands = (...names: string[]): boolean => names.every(name => existsSync(gate(name)))
const signal = (name: string): void => writeFileSync(gate(name), '')

try {
  session.submit('/swarm on')
  await session.waitFor('the wave never opened', () => session.stdout().includes('Swarm on for new crewmates'), TURN_MS)
  const boardPath = findFiles(world.config, 'board.sqlite')[0]!
  board = open(boardPath, dirname(dirname(dirname(boardPath))).split(/[\\/]/).at(-1)!)

  session.submit('PROMPT-ONE')
  await session.waitFor('the lead never finished its launches', () => session.stdout().includes('ONE-DONE'), TURN_MS)
  await session.waitFor('the seat to be woken never parked', () => board!.screenEvents(0).some(event => event.authorName === 'woken' && event.lifecycle?.kind === 'parked'), TURN_MS)
  await session.waitFor('the seat to be resumed never finished its first run', () => said('RESUMED-RUN-ONE-DONE'), TURN_MS)
  session.submit('PROMPT-TWO')
  await session.waitFor('the lead never resumed the finished seat', () => session.stdout().includes('TWO-DONE'), TURN_MS)
  await session.waitFor('the seats never reached their first wait', () => stands('reader-ready', 'messaged-at-sync-1', 'resumed-at-sync-1'), TURN_MS)

  tally.section("§1 a crewmate's files change on disk; it posts on the board before it is told, then its scan starts beside the passes of the other seats")
  changeOnDisk(readerFiles)
  signal('go-1')
  await session.waitFor("the reader's board post never woke the parked seat", () => stands('reader-at-sync-1', 'woken-at-sync-1'), TURN_MS)
  signal('sync-1')
  await sleep(40)
  session.submit('PROMPT-THREE')
  await session.waitFor('the lead never answered the third prompt', () => session.stdout().includes('THREE-DONE'), TURN_MS)
  await session.waitFor('the seats never reached their second wait', () => stands('reader-at-sync-2', 'woken-at-sync-2', 'messaged-at-sync-2'), TURN_MS)
  await session.waitFor('the resumed seat never finished its second run', () => said('RESUMED-RUN-TWO-DONE'), TURN_MS)
  tally.check('the reader posted on the board while its changed files were still untold', toolResultOf(world, 'reader-post')?.isError === false, toolResultOf(world, 'reader-post')?.text ?? 'no result')

  tally.section("§2 the lead's files change on disk; it sends a message and resumes a seat before it is told, then its scan starts beside the passes of the crewmates")
  session.submit('PROMPT-FOUR')
  await session.waitFor('the lead never reached its wait', () => stands('lead-ready'), TURN_MS)
  changeOnDisk(leadFiles)
  signal('go-2')
  await session.waitFor("the lead's resume never started the finished seat", () => stands('lead-at-sync-2', 'resumed-at-sync-2'), TURN_MS)
  signal('sync-2')
  await session.waitFor('the lead never answered the fourth prompt', () => session.stdout().includes('FOUR-DONE'), TURN_MS)
  await session.waitFor('the seats never finished', () => CREW.every(name => said(`${name.toUpperCase()}-DONE`)), TURN_MS)
  tally.check('the lead sent its message and its resume while its changed files were still untold', toolResultOf(world, 'lead-message')?.isError === false && toolResultOf(world, 'lead-resume')?.isError === false, `${toolResultOf(world, 'lead-message')?.text ?? 'no result'} | ${toolResultOf(world, 'lead-resume')?.text ?? 'no result'}`)

  tally.section('§3 what each seat was shown, over every request it made')
  tally.check('the reader is told once of each of its changed files', notesOf('reader', readerFiles) === once, `notes per file ${notesOf('reader', readerFiles)}; ${WHERE}`)
  tally.check('the lead is told once of each of its changed files', notesOf('lead', leadFiles) === once, `notes per file ${notesOf('lead', leadFiles)}; ${WHERE}`)
  tally.check("the lead, which never read them, is shown none of the reader's files", shownTo('lead', readerFiles) === 0, `${shownTo('lead', readerFiles)} of ${FILES} files reached it; ${WHERE}`)
  tally.check("the reader, which never read them, is shown none of the lead's files", shownTo('reader', leadFiles) === 0, `${shownTo('reader', leadFiles)} of ${FILES} files reached it; ${WHERE}`)
  for (const name of ['woken', 'messaged', 'resumed'] as const) {
    tally.check(`the seat ${ROADS[name]}, which read nothing, is shown none of the reader's files`, shownTo(name, readerFiles) === 0, `${shownTo(name, readerFiles)} of ${FILES} files reached it; ${WHERE}`)
    tally.check(`the seat ${ROADS[name]}, which read nothing, is shown none of the lead's files`, shownTo(name, leadFiles) === 0, `${shownTo(name, leadFiles)} of ${FILES} files reached it; ${WHERE}`)
  }
} catch (error) {
  tally.check('the scene reached every checkpoint', false, error instanceof Error ? error.message : String(error))
} finally {
  record('requests.json', JSON.stringify(bodies()))
  record('lead-stdout.txt', session.stdout())
  record('lead-stderr.txt', session.stderr())
  board?.close()
  await session.terminate()
  await closeWorld(world)
  rmSync(scratch, { recursive: true, force: true })
}
tally.finish()
