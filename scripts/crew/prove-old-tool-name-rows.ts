#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

const proofHome = mkdtempSync(join(tmpdir(), 'old-tool-name-rows-home-'))
process.env.MERCURY_CONFIG_DIR = proofHome
delete process.env.MERCURY_HOME
process.on('exit', () => rmSync(proofHome, { recursive: true, force: true }))
const { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, record, ROOT, TURN_MS } = await import('./crew-world.ts')
process.env.MERCURY_DESKTOP_DRIVER = 'none'

const tally = makeTally('prove-old-tool-name-rows')
;(await import('../../src/utils/config/globalConfig.ts')).enableConfigs()

const OLD_TOOL = 'Agent'
const OLD_RESUME = 'ResumeAgent'
const OLD_FIELD = 'subagent_type'
const TOOL = 'Crewmate'
const RESUME = 'ResumeCrewmate'
const AGENT_ID = 'a1b2c3d4e'

tally.section('§1 the old names are names no build ships: the renderer, the tool list, the alias road, the render shim, the launch-receipt readers')
const { toolFamilyFor } = await import('../../src/components/mercury-ui/toolGlyphs.ts')
tally.check('the transcript renderer paints a recorded row under the old tool name as it paints any unknown tool — no family remembers it', toolFamilyFor(OLD_TOOL) === toolFamilyFor('FrobnicateTool') && toolFamilyFor(OLD_RESUME) === toolFamilyFor('FrobnicateTool'))
const { getAllBaseTools } = await import('../../src/tools.ts')
const { findToolByName } = await import('../../src/Tool.ts')
const tools = getAllBaseTools()
const listed = tools.map(tool => tool.name)
tally.check(`the tool list of a booted session names ${TOOL} and ${RESUME} and neither old name`, listed.includes(TOOL) && listed.includes(RESUME) && !listed.includes(OLD_TOOL) && !listed.includes(OLD_RESUME), listed.join(', '))
tally.check('no tool answers to an old name — no alias, no folded match', findToolByName(tools, OLD_TOOL) === undefined && findToolByName(tools, OLD_RESUME) === undefined)
const { findToolForRender } = await import('../../src/tools/MCPTool/absentToolShim.ts')
const shim = findToolForRender(tools, OLD_TOOL)
tally.check('a recorded row under the old name resolves a render shim under its recorded name (it paints; it never runs)', shim.name === OLD_TOOL && shim.userFacingName({} as never) === OLD_TOOL && !listed.includes(shim.name))
let shimCall = ''
try {
  await shim.call({} as never, {} as never, undefined as never, undefined as never)
} catch (error) {
  shimCall = error instanceof Error ? error.message : String(error)
}
tally.check('the shim refuses to run the old tool, as it refuses any tool the build does not have', shimCall.includes('no longer available'), shimCall)
const { backgroundLaunchReceipts, namedLaunchReceipts } = await import('../../src/tasks/LocalAgentTask/launchReceipts.ts')
const stamp = (n: number): string => new Date(1700000000000 + n * 1000).toISOString()
const oldLaunch = {
  type: 'assistant',
  uuid: randomUUID(),
  timestamp: stamp(1),
  message: { role: 'assistant', id: 'msg_old', model: LEAD_MODEL, content: [{ type: 'tool_use', id: 'toolu_old_launch', name: OLD_TOOL, input: { description: 'scout the notes', prompt: 'read the notes', name: 'scout', run_in_background: true, [OLD_FIELD]: 'mercury-crew' } }] },
}
const oldReceipt = {
  type: 'user',
  uuid: randomUUID(),
  timestamp: stamp(2),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_old_launch', content: `${OLD_TOOL} launched in the background.\nagentId: ${AGENT_ID} (internal — do not mention it to the user). To continue this agent, use ${OLD_RESUME} addressed to that id or to its name "scout".` }] },
}
tally.check('the launch-receipt readers read an old launch row as any unknown tool row: no background receipt, no named launch (a crewmate of the old build is reached by its id, never by its name)', backgroundLaunchReceipts([oldLaunch, oldReceipt] as never).length === 0 && namedLaunchReceipts([oldLaunch, oldReceipt] as never).length === 0)

tally.section('§2 the drive: a transcript with an old launch row and an old resume row resumes whole, the session answers, and the model is offered the new names')
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const world = await makeWorld('old-tool-name-rows', [lead({ kind: 'text', text: 'OLD-RESUMED' }, 'OLD-ROWS'), lead({ kind: 'text', text: 'RECORD-RESUMED' }, 'OLD-RECORD')])
type Request = { body: { tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: unknown }> } }
const requests = (): Request[] => world.fixture.messageRequests() as Request[]
const toolNamesOf = (request: Request | undefined): string[] => (request?.body.tools ?? []).map(tool => tool.name)

const { projectSlug } = await import('../../src/utils/sessionStoragePortable.ts')
const cwd = realpathSync(world.project).normalize('NFC')
const projectDir = join(world.config, 'projects', projectSlug(cwd))
mkdirSync(projectDir, { recursive: true })
const version = (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const at = (offsetMs: number): string => new Date(Date.now() - 60_000 + offsetMs).toISOString()
type Row = Record<string, unknown>
const LAUNCH_ID = 'toolu_old_launch'
const RESUME_ID = 'toolu_old_resume'
const usage = { inputTokens: 25, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

function oldTranscript(sessionId: string, withRecord: boolean): { path: string; firstRow: string } {
  const rows: Row[] = []
  let ordinal = 0
  let parent: string | null = null
  let firstRow = ''
  const meta = (metaKind: string, fields: Row): void => {
    ordinal += 1
    rows.push({ schemaVersion: 1, recordId: randomUUID(), sessionId, threadId: 'main', creationOrdinal: String(ordinal), updateOrdinal: String(ordinal), occurredAt: at(ordinal * 10), actor: { role: 'system' }, source: { channel: 'sdk' }, payload: { kind: 'session-meta', metaKind, fields } })
  }
  const message = (actor: Row, payload: Row, annotations: Row): string => {
    ordinal += 1
    const id = randomUUID()
    rows.push({
      schemaVersion: 1,
      recordId: id,
      sessionId,
      threadId: 'main',
      creationOrdinal: String(ordinal),
      updateOrdinal: String(ordinal),
      occurredAt: at(ordinal * 10),
      actor,
      source: { channel: 'sdk' },
      payload,
      ...(parent !== null ? { parentId: parent } : {}),
      annotations: { parentUuid: parent, isSidechain: false, uuid: id, timestamp: at(ordinal * 10), entrypoint: 'headless', cwd, sessionId, version, ...annotations },
    })
    parent = id
    return id
  }
  meta('mercury-transcript-header', { fileVersion: 1, format: 'mercury-records' })
  firstRow = message({ role: 'operator' }, { kind: 'input', content: 'launch a scout over the notes', meta: { msgRest: { role: 'user' } } }, { permissionMode: 'default' })
  message({ role: 'assistant', model: LEAD_MODEL }, { kind: 'output', model: LEAD_MODEL, content: [{ kind: 'tool-use', callId: LAUNCH_ID, name: OLD_TOOL, input: { description: 'scout the notes', prompt: 'read the notes and report', name: 'scout', run_in_background: true, [OLD_FIELD]: 'mercury-crew' } }], usage, outcome: { result: 'completed', stopReason: 'tool_use', stopSequence: null }, providerMessageId: 'msg_old_1' }, {})
  const launchText = `${OLD_TOOL} launched in the background.\nagentId: ${AGENT_ID} (internal — do not mention it to the user). To continue this agent, use ${OLD_RESUME} addressed to that id or to its name "scout".`
  message({ role: 'operator' }, { kind: 'input', content: [{ kind: 'tool-result', callId: LAUNCH_ID, body: [{ kind: 'text', text: launchText }] }], meta: { msgRest: { role: 'user' } } }, { toolUseResult: { text: launchText }, sourceToolAssistantUUID: parent })
  message({ role: 'assistant', model: LEAD_MODEL }, { kind: 'output', model: LEAD_MODEL, content: [{ kind: 'tool-use', callId: RESUME_ID, name: OLD_RESUME, input: { to: 'scout', message: 'also count the pages' } }], usage, outcome: { result: 'completed', stopReason: 'tool_use', stopSequence: null }, providerMessageId: 'msg_old_2' }, {})
  const resumeText = `${OLD_TOOL} scout (id ${AGENT_ID}) is still running, so nothing was resumed: the message was delivered and it reads it at its next tool boundary.`
  message({ role: 'operator' }, { kind: 'input', content: [{ kind: 'tool-result', callId: RESUME_ID, body: [{ kind: 'text', text: resumeText }] }], meta: { msgRest: { role: 'user' } } }, { toolUseResult: { success: true, message: resumeText }, sourceToolAssistantUUID: parent })
  message({ role: 'assistant', model: LEAD_MODEL }, { kind: 'output', model: LEAD_MODEL, content: [{ kind: 'text', text: 'OLD-SCOUT-SENT' }], usage, outcome: { result: 'completed', stopReason: 'end_turn', stopSequence: null }, providerMessageId: 'msg_old_3' }, {})
  if (withRecord) {
    const definition = (name: string, properties: Record<string, unknown>): string => JSON.stringify({ name, description: `the ${name} tool as the earlier build described it`, input_schema: { type: 'object', properties } })
    ordinal += 1
    const id = randomUUID()
    rows.push({
      schemaVersion: 1,
      recordId: id,
      sessionId,
      threadId: 'main',
      creationOrdinal: String(ordinal),
      updateOrdinal: String(ordinal),
      occurredAt: at(ordinal * 10),
      actor: { role: 'system' },
      source: { channel: 'sdk' },
      payload: {
        kind: 'attachment',
        attachmentType: 'bound_prefix',
        fields: {
          boundKey: `main|${firstRow}|${LEAD_MODEL}`,
          rosterEnabled: false,
          roster: [
            { name: OLD_TOOL, deferred: false, definition: definition(OLD_TOOL, { description: { type: 'string' }, prompt: { type: 'string' }, [OLD_FIELD]: { type: 'string' } }) },
            { name: 'Read', deferred: false },
            { name: OLD_RESUME, deferred: false, definition: definition(OLD_RESUME, { to: { type: 'string' }, message: { type: 'string' } }) },
          ],
          sections: [],
          systemContext: {},
        },
      },
      parentId: parent,
      annotations: { parentUuid: parent, isSidechain: false, uuid: id, timestamp: at(ordinal * 10), entrypoint: 'headless', cwd, sessionId, version },
    })
  }
  const path = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  return { path, firstRow }
}

const plain = randomUUID()
const plainTranscript = oldTranscript(plain, false)
record('old-transcript.jsonl', readFileSync(plainTranscript.path, 'utf8'))
let before = requests().length
const old = bootLead(world, ['--resume', plain], [TOOL, RESUME, 'Read'])
try {
  old.submit('OLD-ROWS: read the old rows and say the word.')
  await old.waitFor('the resumed old session never answered', () => old.stdout().includes('OLD-RESUMED'), TURN_MS)
  const request = requests()[before]
  const history = JSON.stringify(request?.body.messages ?? [])
  record('old-resumed-request-messages.json', JSON.stringify(request?.body.messages ?? [], null, 2))
  record('old-resumed-request-tools.txt', toolNamesOf(request).join('\n') + '\n')
  tally.check('the resumed session sends the old transcript whole: the old launch row, its receipt, the old resume row and its result ride the first request under their recorded names', history.includes(`"name":"${OLD_TOOL}"`) && history.includes(`"tool_use_id":"${LAUNCH_ID}"`) && history.includes(`"name":"${OLD_RESUME}"`) && history.includes(`"tool_use_id":"${RESUME_ID}"`) && history.includes('OLD-SCOUT-SENT'))
  tally.check(`the old launch row keeps its recorded input, ${OLD_FIELD} included — a record is never rewritten`, history.includes(`"${OLD_FIELD}":"mercury-crew"`))
  tally.check('the resumed session still answers on the tip', old.stdout().includes('OLD-RESUMED'))
  tally.check(`the request that follows offers ${TOOL} and ${RESUME} and neither old name`, toolNamesOf(request).includes(TOOL) && toolNamesOf(request).includes(RESUME) && !toolNamesOf(request).includes(OLD_TOOL) && !toolNamesOf(request).includes(OLD_RESUME), toolNamesOf(request).join(', '))
  record('old-resumed-stderr.txt', old.stderr())
} catch (error) {
  tally.check('the old session resumed', false, error instanceof Error ? error.message : String(error))
} finally {
  await old.end()
}

tally.section("§3 the record case: a transcript whose first-exchange record names the old tools with their definitions resumes whole; the request carries what the frozen-prefix law says it carries")
const recorded = randomUUID()
const recordedTranscript = oldTranscript(recorded, true)
record('old-record-transcript.jsonl', readFileSync(recordedTranscript.path, 'utf8'))
before = requests().length
const withRecord = bootLead(world, ['--resume', recorded], [TOOL, RESUME, 'Read'])
try {
  withRecord.submit('OLD-RECORD: read the old rows and say the word.')
  await withRecord.waitFor('the resumed recorded session never answered', () => withRecord.stdout().includes('RECORD-RESUMED'), TURN_MS)
  const request = requests()[before]
  const names = toolNamesOf(request)
  record('old-record-resumed-request-tools.txt', names.join('\n') + '\n')
  record('old-record-resumed-stderr.txt', withRecord.stderr())
  tally.check('the resumed recorded session still answers on the tip', withRecord.stdout().includes('RECORD-RESUMED'))
  tally.check('the frozen prefix re-sends the recorded roster as recorded: the old names ride with their recorded definitions, and the new names are held as joiners until the next compaction or /clear', names.includes(OLD_TOOL) && names.includes(OLD_RESUME) && !names.includes(TOOL) && !names.includes(RESUME), names.join(', '))
} catch (error) {
  tally.check('the recorded old session resumed', false, error instanceof Error ? error.message : String(error))
} finally {
  await withRecord.end()
  await closeWorld(world)
}

tally.section("§4 the old row paints: the transcript renderer with the tip's tool list")
try {
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { AssistantToolUseMessage } = await import('../../src/components/messages/AssistantToolUseMessage.tsx')
  const lookups = { resolvedToolUseIDs: new Set([LAUNCH_ID]), erroredToolUseIDs: new Set<string>(), deniedToolUseIDs: new Set<string>(), toolResultByToolUseID: new Map(), progressMessagesByToolUseID: new Map() }
  const node = React.createElement(AppStateProvider as never, { initialState: getDefaultAppState() } as never, React.createElement(AssistantToolUseMessage as never, { param: { type: 'tool_use', id: LAUNCH_ID, name: OLD_TOOL, input: { description: 'scout the notes', prompt: 'read the notes and report', [OLD_FIELD]: 'mercury-crew' } }, tools, inProgressToolUseIDs: new Set<string>(), lookups, addMargin: false } as never) as never)
  const painted = (await renderToString(node, 100)).trim()
  record('old-row-render.txt', painted + '\n')
  tally.check('the old launch row paints under its recorded name instead of vanishing', painted.includes(OLD_TOOL), JSON.stringify(painted))
} catch (error) {
  tally.check('the old row rendered', false, error instanceof Error ? error.message : String(error))
}
tally.finish()
