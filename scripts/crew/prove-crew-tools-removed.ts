#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'
import { bootLead, closeWorld, LEAD_GATE, LEAD_MODEL, makeTally, makeWorld, record, ROOT, TURN_MS } from './crew-world.ts'

process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'team-tools-removed-home-'))
process.env.MERCURY_CREWS_DIR ??= join(process.env.MERCURY_CONFIG_DIR, 'teams')
process.env.MERCURY_DESKTOP_DRIVER = 'none'

const tally = makeTally('prove-crew-tools-removed')
;(await import('../../src/utils/config/globalConfig.ts')).enableConfigs()
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const names = (text: string): string[] => ['TeamCreate', 'TeamDelete', 'TEAM_CREATE_TOOL_NAME', 'TEAM_DELETE_TOOL_NAME'].filter(name => text.includes(name))

tally.section('§1 the two tools are gone from the tree, the registry and the tables')
tally.check('src/tools/TeamCreateTool/ is deleted', !existsSync(join(ROOT, 'src/tools/TeamCreateTool')))
tally.check('src/tools/TeamDeleteTool/ is deleted', !existsSync(join(ROOT, 'src/tools/TeamDeleteTool')))
for (const rel of [
  'src/tools.ts',
  'src/utils/permissions/classifierDecision.ts',
  'src/utils/swarm/agentLaunchPlan.ts',
  'src/utils/capability/declarations.ts',
  'src/substrate/durableOperationMatrix.ts',
  'src/utils/messages/attachmentText.ts',
  'src/utils/swarm/crewOperations.ts',
  'scripts/builtin-tools/fixtures/tool-census.json',
  'scripts/builtin-tools/fixtures/tool-census.md',
  'scripts/project-services/fixtures/inventory.json',
]) {
  const hits = names(src(rel))
  tally.check(`${rel} names neither tool`, hits.length === 0, hits.join(', '))
}
const helpers = src('src/utils/swarm/crewHelpers.ts')
tally.check('the team-directory removal road (cleanupCrewDirectories · destroyWorktree) left with the tools — nothing removes a folder or a worktree', !helpers.includes('cleanupCrewDirectories') && !helpers.includes('destroyWorktree') && !helpers.includes("'worktree', 'remove'"))
const operations = src('src/utils/swarm/crewOperations.ts')
tally.check('the journal recovery reads every kind as written and the crew kinds alone have handlers — nothing deletes', src('src/substrate/operationJournal.ts').includes('handlers[op.kind]') && operations.includes("'crew-create'") && operations.includes("'crew-delete'") && !operations.includes('cleanupCrewDirectories') && !/rm\(/.test(operations))
const runner = src('src/cli/run.ts')
tally.check('the headless lead\'s end-of-input words no longer send the model to a team cleanup step', !runner.includes('team cleanup operation'))
const glyphs = src('src/components/mercury-ui/toolGlyphs.ts')
const { toolFamilyFor } = await import('../../src/components/mercury-ui/toolGlyphs.ts')
tally.check('the transcript renderer paints a recorded row of a tool no build ships as it paints any unknown tool — no mark remembers the two', !glyphs.includes('isRetiredToolName') && toolFamilyFor('TeamCreate') === toolFamilyFor('FrobnicateTool') && toolFamilyFor('TeamDelete') === toolFamilyFor('FrobnicateTool'))
const { getAllBaseTools } = await import('../../src/tools.ts')
const listed = getAllBaseTools().map(tool => tool.name)
tally.check('the tool list of a booted session names neither TeamCreate nor TeamDelete', !listed.includes('TeamCreate') && !listed.includes('TeamDelete'), listed.filter(name => /^Team/.test(name)).join(', '))
tally.check('the crew tools that stay are still listed (SendMessage · the crew brief · Agent)', listed.includes('SendMessage') && (listed.includes('TeamBrief') || listed.includes('LiveComms')) && listed.includes('Agent'), listed.join(', '))
const { findToolForRender } = await import('../../src/tools/MCPTool/absentToolShim.ts')
const tools = getAllBaseTools()
const shim = findToolForRender(tools, 'TeamCreate')
tally.check('an old TeamCreate row resolves a render shim under its recorded name (it paints; it never runs)', shim.name === 'TeamCreate' && shim.userFacingName({} as never) === 'TeamCreate' && typeof shim.renderToolUseMessage === 'function')
let shimCall = ''
try {
  await shim.call({} as never, {} as never, undefined as never, undefined as never)
} catch (error) {
  shimCall = error instanceof Error ? error.message : String(error)
}
tally.check('the shim refuses to run the old tool', shimCall.includes('no longer available'), shimCall)

tally.section('§2 the drive: the first request of a fresh session carries neither tool; an old transcript with a TeamCreate row still resumes whole')
const lead = (turn: Record<string, unknown>, when: string): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE, whenBody: when }) as ScriptedTurn
const world = await makeWorld('team-tools-removed', [lead({ kind: 'text', text: 'FRESH-DONE' }, 'FRESH'), lead({ kind: 'text', text: 'OLD-RESUMED' }, 'OLD')])
type Request = { body: { tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: unknown }> } }
const requests = (): Request[] => world.fixture.messageRequests() as Request[]
const toolNamesOf = (request: Request | undefined): string[] => (request?.body.tools ?? []).map(tool => tool.name)
const fresh = bootLead(world, [], ['Agent', 'SendMessage', 'TeamBrief'])
try {
  fresh.submit('FRESH: say the word.')
  await fresh.waitFor('the fresh session never answered', () => fresh.stdout().includes('FRESH-DONE'), TURN_MS)
  const first = toolNamesOf(requests()[0])
  record('fresh-first-request-tools.txt', first.join('\n') + '\n')
  tally.check('the first request names neither TeamCreate nor TeamDelete', first.length > 0 && !first.includes('TeamCreate') && !first.includes('TeamDelete'), first.filter(name => /^Team/.test(name)).join(', ') || `(${first.length} tools)`)
  tally.check('the first request still names SendMessage and the crew brief', first.includes('SendMessage') && (first.includes('TeamBrief') || first.includes('LiveComms')))
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
const CREATE_ID = 'toolu_old_team_create'
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
message({ role: 'operator' }, { kind: 'input', content: 'make the old team', meta: { msgRest: { role: 'user' } } }, { permissionMode: 'default' })
message({ role: 'assistant', model: LEAD_MODEL }, { kind: 'output', model: LEAD_MODEL, content: [{ kind: 'tool-use', callId: CREATE_ID, name: 'TeamCreate', input: { team_name: 'old-team', description: 'the old team' } }], usage, outcome: { result: 'completed', stopReason: 'tool_use', stopSequence: null }, providerMessageId: 'msg_old_1' }, {})
const createResult = { team_name: 'old-team', team_file_path: join(world.crews, 'old-team', 'config.json'), lead_agent_id: 'team-lead@old-team', objective: 'the old team', charter_version: 1 }
message({ role: 'operator' }, { kind: 'input', content: [{ kind: 'tool-result', callId: CREATE_ID, body: [{ kind: 'text', text: JSON.stringify(createResult) }] }], meta: { msgRest: { role: 'user' } } }, { toolUseResult: createResult, sourceToolAssistantUUID: parent })
message({ role: 'assistant', model: LEAD_MODEL }, { kind: 'output', model: LEAD_MODEL, content: [{ kind: 'text', text: 'OLD-TEAM-MADE' }], usage, outcome: { result: 'completed', stopReason: 'end_turn', stopSequence: null }, providerMessageId: 'msg_old_2' }, {})
const transcriptPath = join(projectDir, `${sessionId}.jsonl`)
writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
record('old-transcript.jsonl', readFileSync(transcriptPath, 'utf8'))
const before = requests().length
const old = bootLead(world, ['--resume', sessionId], ['Agent', 'SendMessage', 'TeamBrief'])
try {
  old.submit('OLD: read the old row and say the word.')
  await old.waitFor('the resumed old session never answered', () => old.stdout().includes('OLD-RESUMED'), TURN_MS)
  const request = requests()[before]
  const history = JSON.stringify(request?.body.messages ?? [])
  record('old-resumed-request-messages.json', JSON.stringify(request?.body.messages ?? [], null, 2))
  tally.check('the resumed session sends the old transcript whole: the TeamCreate tool use and its result ride the first request', history.includes(`"name":"TeamCreate"`) && history.includes(`"tool_use_id":"${CREATE_ID}"`) && history.includes('OLD-TEAM-MADE'), history.slice(0, 400))
  tally.check('the resumed session still answers on the tip', old.stdout().includes('OLD-RESUMED'))
  tally.check('the request that follows lists no TeamCreate tool for the model to call again', !toolNamesOf(request).includes('TeamCreate'), toolNamesOf(request).filter(name => /^Team/.test(name)).join(', '))
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
  const lookups = { resolvedToolUseIDs: new Set([CREATE_ID]), erroredToolUseIDs: new Set<string>(), deniedToolUseIDs: new Set<string>(), toolResultByToolUseID: new Map(), progressMessagesByToolUseID: new Map() }
  const node = React.createElement(AppStateProvider as never, { initialState: getDefaultAppState() } as never, React.createElement(AssistantToolUseMessage as never, { param: { type: 'tool_use', id: CREATE_ID, name: 'TeamCreate', input: { team_name: 'old-team', description: 'the old team' } }, tools, inProgressToolUseIDs: new Set<string>(), lookups, addMargin: false } as never) as never)
  const painted = (await renderToString(node, 100)).trim()
  record('old-row-render.txt', painted + '\n')
  tally.check('the old TeamCreate row paints under its recorded name instead of vanishing', painted.includes('TeamCreate'), JSON.stringify(painted))
} catch (error) {
  tally.check('the old row rendered', false, error instanceof Error ? error.message : String(error))
}
tally.finish()
