#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, record, ROOT, TURN_MS } from './crew-world.ts'

process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'unshipped-tool-rows-home-'))
process.env.MERCURY_DESKTOP_DRIVER = 'none'

const tally = makeTally('prove-unshipped-tool-rows')
;(await import('../../src/utils/config/globalConfig.ts')).enableConfigs()
const UNSHIPPED = 'FrobnicateTool'

tally.section('§1 a tool no build ships: the renderer, the tool list and the render shim')
const { toolFamilyFor } = await import('../../src/components/mercury-ui/toolGlyphs.ts')
tally.check('the transcript renderer paints a recorded row of a tool no build ships as it paints any unknown tool', toolFamilyFor(UNSHIPPED) === toolFamilyFor('AnotherUnknownTool'))
const { getAllBaseTools } = await import('../../src/tools.ts')
const listed = getAllBaseTools().map(tool => tool.name)
tally.check('the tool list of a booted session names the crew tools (SendMessage · Agent) and no unshipped name', listed.includes('SendMessage') && listed.includes('Agent') && !listed.includes(UNSHIPPED), listed.join(', '))
const { findToolForRender } = await import('../../src/tools/MCPTool/absentToolShim.ts')
const tools = getAllBaseTools()
const shim = findToolForRender(tools, UNSHIPPED)
tally.check('a recorded row of an unshipped tool resolves a render shim under its recorded name (it paints; it never runs)', shim.name === UNSHIPPED && shim.userFacingName({} as never) === UNSHIPPED && typeof shim.renderToolUseMessage === 'function')
let shimCall = ''
try {
  await shim.call({} as never, {} as never, undefined as never, undefined as never)
} catch (error) {
  shimCall = error instanceof Error ? error.message : String(error)
}
tally.check('the shim refuses to run the unshipped tool', shimCall.includes('no longer available'), shimCall)

tally.section('§2 the drive: a fresh session offers the crew tools; a transcript with an unshipped tool row resumes whole')
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const world = await makeWorld('unshipped-tool-rows', [lead({ kind: 'text', text: 'FRESH-DONE' }, 'FRESH'), lead({ kind: 'text', text: 'OLD-RESUMED' }, 'OLD')])
type Request = { body: { tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: unknown }> } }
const requests = (): Request[] => world.fixture.messageRequests() as Request[]
const toolNamesOf = (request: Request | undefined): string[] => (request?.body.tools ?? []).map(tool => tool.name)
const fresh = bootLead(world, [], ['Agent', 'SendMessage'])
try {
  fresh.submit('FRESH: say the word.')
  await fresh.waitFor('the fresh session never answered', () => fresh.stdout().includes('FRESH-DONE'), TURN_MS)
  const first = toolNamesOf(requests()[0])
  record('fresh-first-request-tools.txt', first.join('\n') + '\n')
  tally.check('the first request names SendMessage and Agent', first.includes('SendMessage') && first.includes('Agent'), `(${first.length} tools)`)
} catch (error) {
  tally.check('the fresh session ran', false, error instanceof Error ? error.message : String(error))
} finally {
  await fresh.end()
}

const { projectSlug } = await import('../../src/utils/sessionStoragePortable.ts')
const sessionId = randomUUID()
const cwd = realpathSync(world.project).normalize('NFC')
const projectDir = join(world.config, 'projects', projectSlug(cwd))
mkdirSync(projectDir, { recursive: true })
const version = (JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string }).version
const at = (offsetMs: number): string => new Date(Date.now() - 60_000 + offsetMs).toISOString()
const CALL_ID = 'toolu_old_frobnicate'
type Row = Record<string, unknown>
const rows: Row[] = []
let ordinal = 0
let parent: string | null = null
const meta = (metaKind: string, fields: Row): void => {
  ordinal += 1
  rows.push({ schemaVersion: 1, recordId: randomUUID(), sessionId, threadId: 'main', creationOrdinal: String(ordinal), updateOrdinal: String(ordinal), occurredAt: at(ordinal * 10), actor: { role: 'system' }, source: { channel: 'sdk' }, payload: { kind: 'session-meta', metaKind, fields } })
}
const message = (actor: Row, payload: Row, annotations: Row): void => {
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
}
const usage = { inputTokens: 25, outputTokens: 12, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
meta('mercury-transcript-header', { fileVersion: 1, format: 'mercury-records' })
message({ role: 'operator' }, { kind: 'input', content: 'frobnicate the old widget', meta: { msgRest: { role: 'user' } } }, { permissionMode: 'default' })
message({ role: 'assistant', model: LEAD_MODEL }, { kind: 'output', model: LEAD_MODEL, content: [{ kind: 'tool-use', callId: CALL_ID, name: UNSHIPPED, input: { widget: 'old-widget', description: 'the old widget' } }], usage, outcome: { result: 'completed', stopReason: 'tool_use', stopSequence: null }, providerMessageId: 'msg_old_1' }, {})
const callResult = { widget: 'old-widget', frobnicated: true }
message({ role: 'operator' }, { kind: 'input', content: [{ kind: 'tool-result', callId: CALL_ID, body: [{ kind: 'text', text: JSON.stringify(callResult) }] }], meta: { msgRest: { role: 'user' } } }, { toolUseResult: callResult, sourceToolAssistantUUID: parent })
message({ role: 'assistant', model: LEAD_MODEL }, { kind: 'output', model: LEAD_MODEL, content: [{ kind: 'text', text: 'OLD-WIDGET-FROBNICATED' }], usage, outcome: { result: 'completed', stopReason: 'end_turn', stopSequence: null }, providerMessageId: 'msg_old_2' }, {})
const transcriptPath = join(projectDir, `${sessionId}.jsonl`)
writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
record('old-transcript.jsonl', readFileSync(transcriptPath, 'utf8'))
const before = requests().length
const old = bootLead(world, ['--resume', sessionId], ['Agent', 'SendMessage'])
try {
  old.submit('OLD: read the old row and say the word.')
  await old.waitFor('the resumed old session never answered', () => old.stdout().includes('OLD-RESUMED'), TURN_MS)
  const request = requests()[before]
  const history = JSON.stringify(request?.body.messages ?? [])
  record('old-resumed-request-messages.json', JSON.stringify(request?.body.messages ?? [], null, 2))
  tally.check('the resumed session sends the old transcript whole: the unshipped tool use and its result ride the first request', history.includes(`"name":"${UNSHIPPED}"`) && history.includes(`"tool_use_id":"${CALL_ID}"`) && history.includes('OLD-WIDGET-FROBNICATED'), history.slice(0, 400))
  tally.check('the resumed session still answers on the tip', old.stdout().includes('OLD-RESUMED'))
  tally.check('the request that follows lists no unshipped tool for the model to call again', !toolNamesOf(request).includes(UNSHIPPED), toolNamesOf(request).join(', '))
  record('old-resumed-stderr.txt', old.stderr())
} catch (error) {
  tally.check('the old session resumed', false, error instanceof Error ? error.message : String(error))
} finally {
  await old.end()
  await closeWorld(world)
}

tally.section('§3 the old row paints: the transcript renderer with the tip\'s tool list')
try {
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { AppStateProvider } = await import('../../src/state/AppState.tsx')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { AssistantToolUseMessage } = await import('../../src/components/messages/AssistantToolUseMessage.tsx')
  const lookups = { resolvedToolUseIDs: new Set([CALL_ID]), erroredToolUseIDs: new Set<string>(), deniedToolUseIDs: new Set<string>(), toolResultByToolUseID: new Map(), progressMessagesByToolUseID: new Map() }
  const node = React.createElement(AppStateProvider as never, { initialState: getDefaultAppState() } as never, React.createElement(AssistantToolUseMessage as never, { param: { type: 'tool_use', id: CALL_ID, name: UNSHIPPED, input: { widget: 'old-widget', description: 'the old widget' } }, tools, inProgressToolUseIDs: new Set<string>(), lookups, addMargin: false } as never) as never)
  const painted = (await renderToString(node, 100)).trim()
  record('old-row-render.txt', painted + '\n')
  tally.check('the unshipped tool row paints under its recorded name instead of vanishing', painted.includes(UNSHIPPED), JSON.stringify(painted))
} catch (error) {
  tally.check('the old row rendered', false, error instanceof Error ? error.message : String(error))
}
tally.finish()
