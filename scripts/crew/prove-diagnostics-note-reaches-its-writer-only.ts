#!/usr/bin/env bun
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, record, ROOT, toolResultOf, TURN_MS } from './crew-world.ts'

const OUTSIDER_MODEL = 'claude-opus-4-6'
const INSIDER_MODEL = 'claude-haiku-4-5'
const OUTSIDER = 'opus-4-6'
const INSIDER = 'haiku-4-5'
const NOTE = 'New diagnostics from the language server'
const OUT_FILE = 'written-outside-the-project.ts'
const IN_FILE = 'written-inside-the-project.ts'
const FIRST_TEXT = "export const count: number = 'one'\n"
const SECOND_TEXT = 'export const count: number = 1\nexport const extra: string = 2\n'
const FIRST_ERROR = "Type 'string' is not assignable to type 'number'"
const SECOND_ERROR = "Type 'number' is not assignable to type 'string'"
const CARRY_ON = 'CARRY-ON-OUTSIDER'
const GO_SEEN = 'INSIDE-GO-SEEN'
const WHERE = "releaseDiagnosticsWriter in src/integrations/lsp/LSPDiagnosticRegistry.ts hands a seat's files and unread publishes to the main lane when its run ends; a file outside the lead's project folder must stay under the seat's own owner key"

const tally = makeTally('prove-diagnostics-note-reaches-its-writer-only')
const world = await makeWorld('diagnostics-note', [])
const elsewhere = join(world.dir, 'elsewhere')
mkdirSync(elsewhere)
const outFile = join(elsewhere, OUT_FILE)
const inFile = join(world.project, IN_FILE)
const gate = join(world.dir, 'inside-go')
for (const folder of [world.project, elsewhere]) {
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'diagnostics-note-fixture', private: true }))
  writeFileSync(join(folder, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['*.ts'] }))
  symlinkSync(join(ROOT, 'node_modules'), join(folder, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
}

type Call = { name: string; input: Record<string, unknown>; id?: string }
type Step = { kind: 'text'; text: string } | ({ kind: 'tool_use' } & Call)
const say = (text: string): Step => ({ kind: 'text', text })
const call = (one: Call): Step => ({ kind: 'tool_use', ...one })
const pause = (seconds: string): Call => ({ name: 'Bash', input: { command: `sleep ${seconds}`, description: 'A short pause' } })
const watch = (): Call => ({ name: 'Bash', input: { command: `if [ -e ${JSON.stringify(gate)} ]; then echo ${GO_SEEN}; fi; sleep 0.3`, description: 'Look for the signal' } })
const lead = (step: Step, said: string): ScriptedTurn => ({ ...step, model: LEAD_MODEL, whenModel: LEAD_GATE, whenSaid: said })
const idle = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-IDLE', model: LEAD_MODEL, whenModel: LEAD_GATE })
const outsider = (step: Step, whenBody?: string): ScriptedTurn => ({ ...step, model: OUTSIDER_MODEL, whenModel: OUTSIDER, ...(whenBody !== undefined ? { whenBody } : {}) })
const insider = (step: Step, whenBody?: string): ScriptedTurn => ({ ...step, model: INSIDER_MODEL, whenModel: INSIDER, ...(whenBody !== undefined ? { whenBody } : {}) })
const launch = (name: string, model: string, words: string): Call => ({
  name: 'Crewmate',
  id: `launch-${name}`,
  input: { name, description: `The ${name} seat`, prompt: words, crewmate_type: 'mercury-crew', run_in_background: true, model },
})
const passes = (said: string): ScriptedTurn[] => Array.from({ length: 8 }, () => lead(call(pause('0.5')), said))

const fixture = await startFixtureApi([
  lead(call(launch('outsider', OUTSIDER_MODEL, 'Write your file outside the project, then wait until you are told of its errors.')), 'PROMPT-ONE'),
  lead(call(launch('insider', INSIDER_MODEL, 'Wait for the signal, write your file inside the project, then wait until you are told of its errors.')), 'PROMPT-ONE'),
  lead(say('ONE-DONE'), 'PROMPT-ONE'),
  ...passes('PROMPT-TWO'),
  lead(say('TWO-DONE'), 'PROMPT-TWO'),
  lead(call({ name: 'ResumeCrewmate', id: 'resume-outsider', input: { to: 'outsider', message: CARRY_ON } }), 'PROMPT-THREE'),
  lead(say('THREE-DONE'), 'PROMPT-THREE'),
  ...passes('PROMPT-FOUR'),
  lead(say('FOUR-DONE'), 'PROMPT-FOUR'),
  ...Array.from({ length: 30 }, idle),

  outsider(call({ name: 'Write', id: 'outsider-write', input: { file_path: outFile, content: FIRST_TEXT } })),
  outsider(say('OUTSIDER-TOLD-ONCE'), NOTE),
  ...Array.from({ length: 6 }, () => outsider(call(pause('0.5')), CARRY_ON)),
  outsider(say('OUTSIDER-RUN-TWO-DONE'), CARRY_ON),
  ...Array.from({ length: 300 }, () => outsider(call(pause('0.3')))),

  insider(call({ name: 'Write', id: 'insider-write', input: { file_path: inFile, content: FIRST_TEXT } }), GO_SEEN),
  insider(say('INSIDER-TOLD-ONCE'), NOTE),
  ...Array.from({ length: 600 }, () => insider(call(watch()))),
])
world.env.ANTHROPIC_BASE_URL = fixture.url
const session = bootLead(world, ['--sovereign'], ['Crewmate', 'Bash', 'Write', 'ResumeCrewmate'])

type Block = { type?: string; text?: string; content?: unknown }
type Item = { role?: string; content?: unknown }
type Body = { model?: string; messages?: Item[] }
const textsOf = (content: unknown): string[] => {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return (content as Block[]).flatMap(part => (typeof part.text === 'string' ? [part.text] : part.type === 'tool_result' ? textsOf(part.content) : []))
}
const bodies = (): Body[] => fixture.messageRequests().map(request => request.body as Body)
const said = (words: string): boolean => bodies().some(found => JSON.stringify(found.messages ?? []).includes(words))
const notesOf = (seat: string, file: string): string[] =>
  bodies()
    .filter(found => (found.model ?? '').includes(seat))
    .flatMap(found => (found.messages ?? []).flatMap(item => textsOf(item.content)))
    .filter(part => part.includes(NOTE) && part.includes(file))
const told = (seat: string, file: string, error: string): boolean => notesOf(seat, file).some(part => part.includes(error))
const untold = (seat: string, file: string): boolean => notesOf(seat, file).length === 0

try {
  session.submit('PROMPT-ONE')
  await session.waitFor('the lead never finished its launches', () => session.stdout().includes('ONE-DONE'), TURN_MS)

  tally.section("§1 a crewmate writes a file OUTSIDE the lead's project folder; its run ends; the file draws new diagnostics")
  await session.waitFor('the outside writer was never told of its own error', () => said('OUTSIDER-TOLD-ONCE'), TURN_MS)
  tally.check('while its run lives, the writer is told of the error its own write made', told(OUTSIDER, OUT_FILE, FIRST_ERROR), `${existsSync(outFile) ? 'the file was written' : 'the file was never written'}; ${WHERE}`)
  writeFileSync(outFile, SECOND_TEXT)
  session.submit('PROMPT-TWO')
  await session.waitFor('the lead never answered the second prompt', () => session.stdout().includes('TWO-DONE'), TURN_MS)
  tally.check('the lead, which never touched the file, is shown no diagnostics of it after the run ended', untold(LEAD_GATE, OUT_FILE), `${notesOf(LEAD_GATE, OUT_FILE).length} diagnostics note(s) naming it reached the lead; ${WHERE}`)
  tally.check('the other crewmate, which never touched the file, is shown no diagnostics of it', untold(INSIDER, OUT_FILE), `${notesOf(INSIDER, OUT_FILE).length} diagnostics note(s) naming it reached the other crewmate; ${WHERE}`)
  session.submit('PROMPT-THREE')
  await session.waitFor('the resumed writer never finished its second run', () => said('OUTSIDER-RUN-TWO-DONE'), TURN_MS)
  tally.check('the lead resumed the writer', toolResultOf({ ...world, fixture }, 'resume-outsider')?.isError === false, toolResultOf({ ...world, fixture }, 'resume-outsider')?.text ?? 'no result')
  tally.check('the writer, running again, is told of the errors its file drew meanwhile', told(OUTSIDER, OUT_FILE, SECOND_ERROR), WHERE)
  tally.check('the lead is still shown none of it', untold(LEAD_GATE, OUT_FILE), `${notesOf(LEAD_GATE, OUT_FILE).length} diagnostics note(s) naming it reached the lead; ${WHERE}`)

  tally.section("§2 a crewmate writes a file INSIDE the lead's project folder; its run ends; the file draws new diagnostics")
  writeFileSync(gate, '')
  await session.waitFor('the inside writer was never told of its own error', () => said('INSIDER-TOLD-ONCE'), TURN_MS)
  tally.check('while its run lives, the writer is told of the error its own write made', told(INSIDER, IN_FILE, FIRST_ERROR), `${existsSync(inFile) ? 'the file was written' : 'the file was never written'}; ${WHERE}`)
  writeFileSync(inFile, SECOND_TEXT)
  session.submit('PROMPT-FOUR')
  await session.waitFor('the lead never answered the fourth prompt', () => session.stdout().includes('FOUR-DONE'), TURN_MS)
  tally.check('the lead hears of the error left in its own tree, as before', told(LEAD_GATE, IN_FILE, SECOND_ERROR), "releaseDiagnosticsWriter in src/integrations/lsp/LSPDiagnosticRegistry.ts must still return a file under the lead's project folder, with its unread publishes, to the main lane")
  tally.check('the outside writer is shown no diagnostics of the inside file', untold(OUTSIDER, IN_FILE), WHERE)
} catch (error) {
  tally.check('the scene reached every checkpoint', false, error instanceof Error ? error.message : String(error))
} finally {
  record('requests.json', JSON.stringify(bodies()))
  record('lead-stdout.txt', session.stdout())
  record('lead-stderr.txt', session.stderr())
  await session.terminate()
  await fixture.close()
  await closeWorld(world)
}
tally.finish()
