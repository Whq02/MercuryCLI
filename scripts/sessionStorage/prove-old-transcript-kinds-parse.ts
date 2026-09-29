#!/usr/bin/env bun
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'old-transcript-kinds-home-'))
const SCRATCH = mkdtempSync(join(tmpdir(), 'old-transcript-kinds-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.MERCURY_CREWS_DIR
delete process.env.MERCURY_TEAMS_DIR

const ROOT = join(import.meta.dir, '..', '..')
const vnext = await import('../../src/utils/sessionStorage/vnext.ts')
const logs = await import('../../src/utils/sessionStorage/logs.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const sessionClass = await import('../../src/utils/sessionClass.ts')
const attachmentText = await import('../../src/utils/messages/attachmentText.ts')
const nullRendering = await import('../../src/components/messages/nullRenderingAttachments.ts')
const decode = await import('../../src/fabric/transcriptDecode.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const optional = async (rel: string): Promise<Record<string, unknown> | null> => {
  try {
    return (await import(join(ROOT, rel))) as Record<string, unknown>
  } catch {
    return null
  }
}

const SID = '00000000-aaaa-4000-8000-0000000c0ffee'
const TEAM = 'party'
const AGENT = 'dps1'
let n = 0
const uid = (): string => `00000000-0000-4000-8000-${String(100000000000 + ++n).slice(1)}`
const at = (i: number): string => new Date(Date.parse('2026-01-01T00:00:00.000Z') + i * 1000).toISOString()
const base = (uuid: string, parent: string | null, i: number): Record<string, unknown> => ({
  uuid,
  parentUuid: parent,
  isSidechain: false,
  cwd: SCRATCH,
  sessionId: SID,
  version: '1.0.0',
  timestamp: at(i),
  teamName: TEAM,
  agentName: AGENT,
  isTeammate: true,
})

const dir = paths.getProjectDir(SCRATCH)
mkdirSync(dir, { recursive: true })
const file = join(dir, `${SID}.jsonl`)
const row = (entry: Record<string, unknown>): void => {
  appendFileSync(file, (vnext.encodeTranscriptLine(file, entry) as { line: string }).line)
}

const teamContext = { type: 'team_context', agentId: `${AGENT}@${TEAM}`, agentName: AGENT, teamName: TEAM, teamConfigPath: join(HOME, 'teams', TEAM, 'config.json'), taskListPath: join(HOME, 'tasks', TEAM) }
const mailbox = {
  type: 'teammate_mailbox',
  messages: [
    { from: 'team-lead', text: 'ping from the lead', timestamp: at(3), color: 'cyan' },
    { from: 'scribe', text: JSON.stringify({ type: 'teammate_terminated', message: 'scribe has been terminated' }), timestamp: at(4) },
  ],
}
const shutdownBatch = { type: 'teammate_shutdown_batch', count: 2 }
const OLD_MESSAGE = '<teammate-message teammate_id="water" color="cyan">\nhello from water\n</teammate-message>'

let i = 0
const u1 = uid()
row({ ...base(u1, null, i++), type: 'user', message: { role: 'user', content: 'hello crew' } })
row({ type: 'agent-name', agentName: AGENT, sessionId: SID })
const a1 = uid()
row({ ...base(a1, u1, i++), type: 'attachment', attachment: teamContext })
const a2 = uid()
row({ ...base(a2, a1, i++), type: 'attachment', attachment: mailbox })
const t1 = uid()
row({
  ...base(t1, a2, i++),
  type: 'assistant',
  message: {
    id: 'msg_teamcreate',
    role: 'assistant',
    model: 'm',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [{ type: 'tool_use', id: 'toolu_teamcreate', name: 'TeamCreate', input: { operation: 'spawnTeam', team_name: TEAM } }],
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
})
const r1 = uid()
row({ ...base(r1, t1, i++), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_teamcreate', content: 'team created' }] }, toolUseResult: { teamName: TEAM } })
const t2 = uid()
row({
  ...base(t2, r1, i++),
  type: 'assistant',
  message: {
    id: 'msg_spawn',
    role: 'assistant',
    model: 'm',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [{ type: 'tool_use', id: 'toolu_spawn', name: 'Agent', input: { name: 'water', team_name: TEAM, description: 'water', prompt: 'work' } }],
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
})
const r2 = uid()
row({
  ...base(r2, t2, i++),
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_spawn', content: 'Teammate spawned.' }] },
  toolUseResult: { status: 'teammate_spawned', teammate_id: 'agent-water', agent_id: 'agent-water', name: 'water', team_name: TEAM },
})
const t3 = uid()
row({
  ...base(t3, r2, i++),
  type: 'assistant',
  message: {
    id: 'msg_teambrief',
    role: 'assistant',
    model: 'm',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [{ type: 'tool_use', id: 'toolu_teambrief', name: 'TeamBrief', input: {} }],
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
})
const r3 = uid()
row({ ...base(r3, t3, i++), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_teambrief', content: 'brief' }] } })
const a3 = uid()
row({ ...base(a3, r3, i++), type: 'attachment', attachment: shutdownBatch })
const u2 = uid()
row({ ...base(u2, a3, i++), type: 'user', message: { role: 'user', content: OLD_MESSAGE } })
const u3 = uid()
row({ ...base(u3, u2, i++), type: 'user', message: { role: 'user', content: 'thanks' } })

console.log('============================================================')
console.log(' old transcript kinds, records and files read as the crew: team_context, teammate_mailbox, teammate_shutdown_batch, teamName, isTeammate, team_name, teammate_spawned, the teammate-message tag, TeamCreate and TeamBrief rows, the old sidecar key, the old roster, the old folder, the old shortcut id, the old flags')
console.log('============================================================')

console.log('§1 the transcript loads whole through the product reader, every old kind read as the current one')
const log = await logs.loadTranscriptFromFile(file)
const messages = log.messages as Array<Record<string, unknown>>
check('every row of the chain is read', messages.length === 12, `${messages.length} rows`)
const attachments = messages.filter(m => m.type === 'attachment').map(m => (m.attachment as { type: string }).type)
check('the three old attachment kinds read as the crew kinds', JSON.stringify(attachments) === JSON.stringify(['crew_context', 'crewmate_mailbox', 'crewmate_shutdown_batch']), JSON.stringify(attachments))
const toolNames = messages
  .filter(m => m.type === 'assistant')
  .flatMap(m => ((m.message as { content: Array<{ type: string; name?: string }> }).content ?? []).filter(c => c.type === 'tool_use').map(c => c.name))
check('the old tool names on tool_use rows are read as themselves (the renderer resolves them through the alias table)', JSON.stringify(toolNames) === JSON.stringify(['TeamCreate', 'Agent', 'TeamBrief']), JSON.stringify(toolNames))
const contextRow = messages.find(m => m.type === 'attachment' && (m.attachment as { type: string }).type === 'crew_context')?.attachment as Record<string, unknown> | undefined
check('the old context row reads with crewName and crewConfigPath, its old keys gone', contextRow !== undefined && contextRow.crewName === TEAM && typeof contextRow.crewConfigPath === 'string' && !('teamName' in contextRow) && !('teamConfigPath' in contextRow), JSON.stringify(contextRow))
const mailboxRow = messages.find(m => m.type === 'attachment' && (m.attachment as { type: string }).type === 'crewmate_mailbox')?.attachment as { messages: Array<{ text: string }> } | undefined
check('a terminated notice inside an old mailbox row reads as the crew notice', mailboxRow !== undefined && mailboxRow.messages[1]!.text.includes('"crewmate_terminated"'), JSON.stringify(mailboxRow?.messages[1]))
const spawnRow = messages.find(m => m.type === 'assistant' && JSON.stringify(m).includes('toolu_spawn'))
const spawnInput = ((spawnRow?.message as { content: Array<{ input?: Record<string, unknown> }> }).content[0]?.input ?? {}) as Record<string, unknown>
check('an Agent call written with team_name reads with crew_name', spawnInput.crew_name === TEAM && !('team_name' in spawnInput), JSON.stringify(spawnInput))
const spawnResult = messages.find(m => 'toolUseResult' in m && JSON.stringify(m.toolUseResult).includes('agent-water'))?.toolUseResult as Record<string, unknown> | undefined
check('a spawn record written with teammate_spawned and team_name reads as crewmate_spawned with crew_name and crewmate_id', spawnResult !== undefined && spawnResult.status === 'crewmate_spawned' && spawnResult.crew_name === TEAM && spawnResult.crewmate_id === 'agent-water', JSON.stringify(spawnResult))
const messageRow = messages.find(m => m.type === 'user' && typeof (m.message as { content: unknown }).content === 'string' && ((m.message as { content: string }).content).includes('hello from water'))
const messageText = (messageRow?.message as { content: string } | undefined)?.content ?? ''
check('a crewmate message written under the old tag reads under the crew tag with crewmate_id', messageText.startsWith('<crewmate-message crewmate_id="water"') && messageText.endsWith('</crewmate-message>') && !messageText.includes('teammate'), messageText)
check('every row of the chain carries crewName and isCrewmate, never the old keys', messages.every(m => !('teamName' in m) && !('isTeammate' in m)) && messages.some(m => m.crewName === TEAM && m.isCrewmate === true))
const decodedTwice = decode.decodeTranscriptBuffer<Record<string, unknown>>(readFileSync(file, 'utf8')).entries
check('the decode point itself answers the crew spellings (every reader shares it)', decodedTwice.every(e => !('teamName' in e)) && decodedTwice.some(e => e.crewName === TEAM))

console.log('§2 the session record reads the old stamps as the crew stamps')
check('the log carries the crewName stamp', log.crewName === TEAM, String(log.crewName))
check('the log carries the agentName stamp', log.agentName === AGENT, String(log.agentName))
check('the picker classes the transcript as a crew session', sessionClass.isCrewSession(log) === true)
check('the crew tag names the crew and the agent', sessionClass.crewTagOf(log) === `${TEAM} · ${AGENT}`, sessionClass.crewTagOf(log))
const PLAIN_SID = '00000000-bbbb-4000-8000-0000000c0ffee'
const plainFile = join(dir, `${PLAIN_SID}.jsonl`)
const p1 = uid()
appendFileSync(plainFile, (vnext.encodeTranscriptLine(plainFile, { uuid: p1, parentUuid: null, isSidechain: false, cwd: SCRATCH, sessionId: PLAIN_SID, version: '1.0.0', timestamp: at(50), type: 'user', message: { role: 'user', content: 'a plain session' } }) as { line: string }).line)
const lite = (sessionId: string, fullPath: string): Record<string, unknown> => ({ date: at(60), messages: [], isLite: true, fullPath, value: 0, created: new Date(), modified: new Date(), firstPrompt: '', fileSize: readFileSync(fullPath).length, isSidechain: false, sessionId, projectPath: SCRATCH })
const enriched = await logs.enrichLogs([lite(SID, file), lite(PLAIN_SID, plainFile)] as never, 0, 2)
const liteOld = enriched.logs.find(l => l.sessionId === SID) ?? null
const litePlain = enriched.logs.find(l => l.sessionId === PLAIN_SID) ?? null
check('the lite session listing reads the old crew-name stamp from the head line: the crewmate transcript stays out of /resume while a plain session beside it is listed', liteOld === null && litePlain !== null, JSON.stringify({ old: liteOld !== null, plain: litePlain !== null, listed: enriched.logs.length }))

console.log('§3 the readers of the crew kinds answer the old rows')
process.argv.push('--agent-teams')
const contextText = contextRow === undefined ? [] : attachmentText.normalizeAttachmentForAPI(contextRow as never)
check('the context row composes its context words for the model', contextText.length === 1 && JSON.stringify(contextText[0]).includes(TEAM))
const contextMessage = messages.find(m => m.type === 'attachment' && (m.attachment as { type: string }).type === 'crew_context')
check('the context row stays a null-rendering kind on screen', contextMessage !== undefined && nullRendering.isNullRenderingAttachment(contextMessage as never) === true)
check('the old opt-in flag still enables the crew surfaces', (await import('../../src/utils/agentSwarmsEnabled.ts')).isAgentSwarmsEnabled() === true)

console.log('§4 an agent sidecar written under the old keys still reads as a crewmate record')
{
  const agentId = 'agent-old-sidecar-0001'
  const sidecarPath = paths.getAgentMetadataPath(agentId as never)
  mkdirSync(join(sidecarPath, '..'), { recursive: true })
  const old = { agentType: 'general-purpose', name: AGENT, launchedAt: 1, teammate: { teamName: TEAM, prompt: 'work the docs', transcriptAgentId: 'agent-old-sidecar-0001', planModeRequired: false } }
  writeFileSync(sidecarPath, JSON.stringify(old))
  const meta = (await paths.readAgentMetadata(agentId as never)) as Record<string, unknown> | null
  const record = (meta?.crewmate ?? null) as Record<string, unknown> | null
  check('the sidecar reads', meta !== null)
  check('the old record reads as the crewmate record with crewName', record !== null && record.crewName === TEAM && record.prompt === 'work the docs' && !('teamName' in record), JSON.stringify(meta))
  check('the rest of the sidecar still reads', typeof meta?.agentType === 'string' && meta?.name === AGENT)
}

console.log('§5 a saved roster in the old folder, with the old lead name and member role, reads as the crew')
{
  const envUtils = await import('../../src/utils/envUtils.ts')
  const helpers = await import('../../src/utils/swarm/crewHelpers.ts')
  const constants = await import('../../src/utils/swarm/constants.ts')
  const oldDir = join(HOME, 'teams', 'oldcrew')
  mkdirSync(oldDir, { recursive: true })
  writeFileSync(join(oldDir, 'config.json'), JSON.stringify({
    name: 'oldcrew',
    createdAt: 1,
    leadAgentId: 'team-lead@oldcrew',
    members: [
      { agentId: 'team-lead@oldcrew', name: 'team-lead', joinedAt: 1, tmuxPaneId: '', cwd: SCRATCH, subscriptions: [] },
      { agentId: 'water@oldcrew', name: 'water', role: 'teammate', joinedAt: 2, tmuxPaneId: '', cwd: SCRATCH, subscriptions: [] },
    ],
  }, null, 2))
  check('the crews home is the crews folder', envUtils.getCrewsDir() === join(HOME, 'crews'), envUtils.getCrewsDir())
  const read = await helpers.readCrewFileAsync('oldcrew')
  check('a roster the old build wrote under teams/ still reads', read !== null)
  check('its lead reads under the current lead name', read?.leadAgentId === `${constants.CREW_LEAD_NAME}@oldcrew` && read?.members[0]?.name === constants.CREW_LEAD_NAME, JSON.stringify(read?.members.map(m => m.name)))
  check('its member role reads as crewmate', read?.members[1]?.role === 'crewmate', String(read?.members[1]?.role))
  check('the current lead name is the crew word', constants.CREW_LEAD_NAME === 'crew-lead', constants.CREW_LEAD_NAME)
  const convert = await import('../../src/utils/crew/crewConvert.ts')
  const outcome = await convert.convertSavedCrews({ crewDir: join(HOME, 'crew-store') })
  check('the conversion of saved rosters still finds the old folder', outcome.converted.includes('oldcrew') || outcome.unchanged.includes('oldcrew'), JSON.stringify(outcome))
}

console.log('§6 the Agent tool accepts the old field name from an old caller')
{
  const agentTool = await import('../../src/tools/AgentTool/AgentTool.tsx')
  const parsed = agentTool.inputSchema().safeParse({ description: 'd', prompt: 'p', name: 'water', team_name: TEAM })
  const data = (parsed.success ? parsed.data : {}) as Record<string, unknown>
  check('an input carrying team_name parses', parsed.success === true, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 2)))
  check('and reads as crew_name', data.crew_name === TEAM && !('team_name' in data), JSON.stringify(data))
  const jsonSchema = JSON.stringify((await import('../../src/utils/zodToJsonSchema.ts')).zodToJsonSchema(agentTool.inputSchema() as never))
  check('the schema the model sees names crew_name and not the old field', jsonSchema.includes('crew_name') && !jsonSchema.includes('team_name'))
}

console.log('§7 a saved keybinding under the old action id still binds')
{
  const parser = await import('../../src/keybindings/parser.ts')
  const bindings = parser.parseBindings([{ context: 'Global', bindings: { 'ctrl+shift+o': 'app:toggleTeammatePreview' } }] as never)
  check('the old id reads as the crew id', bindings[0]?.action === 'app:toggleCrewmatePreview', String(bindings[0]?.action))
  check('the crew id is the registered action', src('src/keybindings/actionGraph.ts').includes("'app:toggleCrewmatePreview'") && !src('src/keybindings/actionGraph.ts').includes("'app:toggleTeammatePreview'"))
}

console.log('§8 the old command-line spellings still read')
{
  const spellings = await import('../../src/migrations/retiredCrewSpellings.ts')
  const argv = spellings.readRetiredCliFlags(['node', 'mercury', '--team-name', 'alpha', '--agent-teams', '--agent-name=x'])
  check('--team-name and --agent-teams read as the crew flags', argv.includes('--crew-name') && argv.includes('--agent-crews') && !argv.includes('--team-name'), argv.join(' '))
  check('the launcher parses the command line through the table', /parseAsync\(readRetiredCliFlags\(process\.argv\)\)/.test(src('src/main.tsx')))
  check('the crew flag is the one the launcher declares', src('src/main.tsx').includes("'--crew-name <name>'") && !src('src/main.tsx').includes("'--team-name <name>'"))
}

console.log('§9 a saved expanded-view value under the old word opens the crew tree')
{
  const spellings = await import('../../src/migrations/retiredCrewSpellings.ts')
  check('the old value reads as the crew value', spellings.readRetiredGlobalConfigValue('expandedView', 'teammates') === 'crewmates')
  check('the store reads the remembered value through the table', src('src/state/AppStateStore.ts').includes("readRetiredGlobalConfigValue('expandedView'"))
}

console.log('§10 the old journal kinds and keys find their crew handlers')
{
  const spellings = await import('../../src/migrations/retiredCrewSpellings.ts')
  const ops = await optional('src/utils/swarm/crewOperations.ts')
  const handlers = ops !== null && typeof ops.crewJournalRecoveryHandlers === 'function' ? (ops.crewJournalRecoveryHandlers as () => Record<string, unknown>)() : {}
  check('the handler of an old create row is found under the crew kind', spellings.readRetiredJournalKind('team-create') in handlers, Object.keys(handlers).join(','))
  check('the journal dispatch reads the kind through the table', src('src/substrate/operationJournal.ts').includes('handlers[readRetiredJournalKind(op.kind)]'))
  check('an old idempotency key still yields its crew name', spellings.readRetiredJournalKey('team-create:party:12') === 'crew-create:party:12')
}

console.log('§11 the old command name still opens the crew view, as the one alias')
{
  const crewmates = (await import('../../src/commands/crewmates/index.ts')).default as { name: string; aliases?: string[] }
  check('the command is /crewmates with the old name as its one alias', crewmates.name === 'crewmates' && JSON.stringify(crewmates.aliases) === JSON.stringify(['teammates']), JSON.stringify(crewmates))
}

console.log(failures === 0 ? '\nold transcript kinds: ALL GREEN' : `\nold transcript kinds: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
