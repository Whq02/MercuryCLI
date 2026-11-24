#!/usr/bin/env bun
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, record, ROOT, toolResultOf, TURN_MS } from './crew-world.ts'

const LOOKER_MODEL = 'claude-opus-4-6'
const LOOKER = 'opus-4-6'
const NOTE = 'New diagnostics from the language server'
const IN_FILE = 'looked-at-inside-the-project.ts'
const OUT_FILE = 'looked-at-outside-the-project.ts'
const IN_ASKED = 'asked-about-inside-the-project.ts'
const OUT_ASKED = 'asked-about-outside-the-project.ts'
const TEXT = "export const count: number = 'one'\n"
const WHERE = 'an LSP op must claim a file it opens for the seat that asked (claimDiagnosticsLook in src/integrations/lsp/LSPDiagnosticRegistry.ts, called by runLspOperation in src/tools/lsp/lspTools.ts and by syncFileFromDisk in src/tools/lsp/mercury-ops/shared.ts), so the publish the open draws is routed to that seat by laneForFile'
const ENDS = "releaseDiagnosticsWriter in src/integrations/lsp/LSPDiagnosticRegistry.ts must hand the main lane nothing for a file the ended seat only looked at"

const tally = makeTally('prove-looked-at-file-diagnostics-reach-the-looker')
const world = await makeWorld('diagnostics-looked-at', [])
const elsewhere = join(world.dir, 'elsewhere')
mkdirSync(elsewhere)
const inFile = join(world.project, IN_FILE)
const outFile = join(elsewhere, OUT_FILE)
const inAsked = join(world.project, IN_ASKED)
const outAsked = join(elsewhere, OUT_ASKED)
for (const folder of [world.project, elsewhere]) {
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'diagnostics-looked-at-fixture', private: true }))
  writeFileSync(join(folder, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true }, include: ['*.ts'] }))
  symlinkSync(join(ROOT, 'node_modules'), join(folder, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
}
for (const file of [inFile, outFile, inAsked, outAsked]) writeFileSync(file, TEXT)

type Call = { name: string; input: Record<string, unknown>; id?: string }
type Step = { kind: 'text'; text: string } | ({ kind: 'tool_use' } & Call)
const say = (text: string): Step => ({ kind: 'text', text })
const call = (one: Call): Step => ({ kind: 'tool_use', ...one })
const pause = (seconds: string): Call => ({ name: 'Bash', input: { command: `sleep ${seconds}`, description: 'A short pause' } })
const lead = (step: Step, said: string): ScriptedTurn => ({ ...step, model: LEAD_MODEL, whenModel: LEAD_GATE, whenSaid: said })
const idle = (): ScriptedTurn => ({ kind: 'text', text: 'LEAD-IDLE', model: LEAD_MODEL, whenModel: LEAD_GATE })
const looker = (step: Step): ScriptedTurn => ({ ...step, model: LOOKER_MODEL, whenModel: LOOKER })
const passes = (said: string): ScriptedTurn[] => Array.from({ length: 8 }, () => lead(call(pause('0.5')), said))

const fixture = await startFixtureApi([
  lead(call({ name: 'Crewmate', id: 'launch-looker', input: { name: 'looker', description: 'The looker seat', prompt: 'Look at four files through the language server, then wait.', crewmate_type: 'mercury-crew', run_in_background: true, model: LOOKER_MODEL } }), 'PROMPT-ONE'),
  lead(say('ONE-DONE'), 'PROMPT-ONE'),
  ...passes('PROMPT-TWO'),
  lead(say('TWO-DONE'), 'PROMPT-TWO'),
  ...passes('PROMPT-THREE'),
  lead(say('THREE-DONE'), 'PROMPT-THREE'),
  ...Array.from({ length: 30 }, idle),

  looker(call({ name: 'ToolSearch', id: 'looker-load', input: { query: 'select:LspRead' } })),
  looker(call({ name: 'LspRead', id: 'looker-inside', input: { operation: 'documentSymbol', filePath: inFile } })),
  looker(call({ name: 'LspRead', id: 'looker-outside', input: { operation: 'documentSymbol', filePath: outFile } })),
  looker(call({ name: 'LspRead', id: 'looker-several', input: { operation: 'diagnostics', paths: [inAsked, outAsked] } })),
  ...Array.from({ length: 16 }, () => looker(call(pause('0.5')))),
  looker(say('LOOKER-DONE')),
])
world.env.ANTHROPIC_BASE_URL = fixture.url
const session = bootLead(world, ['--sovereign'], ['Crewmate', 'Bash'])

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
const seen = { ...world, fixture }
const LOOKS = ['looker-inside', 'looker-outside', 'looker-several']
const FILES: Array<[string, string]> = [
  [IN_FILE, "it read inside the lead's folder"],
  [OUT_FILE, "it read outside the lead's folder"],
  [IN_ASKED, "it asked about inside the lead's folder"],
  [OUT_ASKED, "it asked about outside the lead's folder"],
]
const leadNotesBefore = (file: string): number =>
  bodies()
    .filter(found => (found.model ?? '').includes(LEAD_GATE) && !JSON.stringify(found.messages ?? []).includes('LOOKER-DONE'))
    .flatMap(found => (found.messages ?? []).flatMap(item => textsOf(item.content)))
    .filter(part => part.includes(NOTE) && part.includes(file)).length

try {
  session.submit('PROMPT-ONE')
  await session.waitFor('the lead never launched the looker', () => session.stdout().includes('ONE-DONE'), TURN_MS)
  await session.waitFor('the looker never looked at its files', () => toolResultOf(seen, 'looker-several') !== null, TURN_MS)
  tally.check('the looker read two files one by one and asked the diagnostics of two more in one call', LOOKS.every(id => toolResultOf(seen, id)?.isError === false), LOOKS.map(id => `${id}: ${toolResultOf(seen, id)?.text.slice(0, 160) ?? 'no result'}`).join(' | '))
  session.submit('PROMPT-TWO')
  await session.waitFor('the lead never answered the second prompt', () => session.stdout().includes('TWO-DONE'), TURN_MS)
  await session.waitFor('the looker never finished', () => said('LOOKER-DONE'), TURN_MS)

  tally.section('§1 the seat that looked is told; the lead, which never touched the files, is not')
  for (const [file, words] of FILES) {
    tally.check(`the looker is told of the diagnostics of the file ${words}`, notesOf(LOOKER, file).length > 0, WHERE)
    tally.check(`while the looker lives, the lead is shown no diagnostics of the file ${words}`, leadNotesBefore(file) === 0, `${leadNotesBefore(file)} note(s) reached the lead; ${WHERE}`)
  }

  tally.section("§2 the looker's run has ended: a look hands the lead nothing")
  session.submit('PROMPT-THREE')
  await session.waitFor('the lead never answered the third prompt', () => session.stdout().includes('THREE-DONE'), TURN_MS)
  for (const [file, words] of FILES) {
    tally.check(`the lead is shown no diagnostics of the file ${words}`, notesOf(LEAD_GATE, file).length === 0, `${notesOf(LEAD_GATE, file).length} note(s) reached the lead; ${ENDS}`)
  }
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
