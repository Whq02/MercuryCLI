#!/usr/bin/env bun
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const HOME = mkdtempSync(join(tmpdir(), 'old-transcript-kinds-home-'))
const SCRATCH = mkdtempSync(join(tmpdir(), 'old-transcript-kinds-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV

const vnext = await import('../../src/utils/sessionStorage/vnext.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const logs = await import('../../src/utils/sessionStorage/logs.ts')
const sessionClass = await import('../../src/utils/sessionClass.ts')
const attachmentText = await import('../../src/utils/messages/attachmentText.ts')
const nullRendering = await import('../../src/components/messages/nullRenderingAttachments.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
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
})

const dir = join(SCRATCH, 'project')
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
const crewMessages = {
  type: 'crew_messages',
  messages: [{ from: 'team-lead', text: 'a note under the crew kind', timestamp: at(5), color: 'cyan' }],
}

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
    id: 'msg_teambrief',
    role: 'assistant',
    model: 'm',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [{ type: 'tool_use', id: 'toolu_teambrief', name: 'TeamBrief', input: {} }],
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
})
const r2 = uid()
row({ ...base(r2, t2, i++), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_teambrief', content: 'brief' }] } })
const a3 = uid()
row({ ...base(a3, r2, i++), type: 'attachment', attachment: shutdownBatch })
const a4 = uid()
row({ ...base(a4, a3, i++), type: 'attachment', attachment: crewMessages })
const u2 = uid()
row({ ...base(u2, a4, i++), type: 'user', message: { role: 'user', content: 'thanks' } })

console.log('============================================================')
console.log(' old transcript kinds parse: team_context, teammate_mailbox, teammate_shutdown_batch, TeamCreate, TeamBrief, teamName — and crew_messages, the kind written now')
console.log('============================================================')

console.log('§1 the transcript loads whole through the product reader')
const log = await logs.loadTranscriptFromFile(file)
const messages = log.messages as Array<Record<string, unknown>>
check('every row of the chain is read', messages.length === 10, `${messages.length} rows`)
const attachments = messages.filter(m => m.type === 'attachment').map(m => (m.attachment as { type: string }).type)
check('the three old attachment kinds are read as themselves, and the crew kind beside them', JSON.stringify(attachments) === JSON.stringify(['team_context', 'teammate_mailbox', 'teammate_shutdown_batch', 'crew_messages']), JSON.stringify(attachments))
const toolNames = messages
  .filter(m => m.type === 'assistant')
  .flatMap(m => ((m.message as { content: Array<{ type: string; name?: string }> }).content ?? []).filter(c => c.type === 'tool_use').map(c => c.name))
check('the old tool names on tool_use rows are read as themselves', JSON.stringify(toolNames) === JSON.stringify(['TeamCreate', 'TeamBrief']), JSON.stringify(toolNames))
const teamContextRow = messages.find(m => m.type === 'attachment' && (m.attachment as { type: string }).type === 'team_context')?.attachment as Record<string, unknown> | undefined
check('the team_context row keeps its teamName and teamConfigPath keys', teamContextRow !== undefined && teamContextRow.teamName === TEAM && typeof teamContextRow.teamConfigPath === 'string')

console.log('§2 the session record reads the old stamps')
check('the log carries the teamName stamp', log.teamName === TEAM, String(log.teamName))
check('the log carries the agentName stamp', log.agentName === AGENT, String(log.agentName))
check('the picker classes the transcript as a crew session', sessionClass.isCrewSession(log) === true)
check('the crew tag names the team and the agent', sessionClass.crewTagOf(log) === `${TEAM} · ${AGENT}`, sessionClass.crewTagOf(log))

console.log('§3 the readers of the old kinds still answer')
process.argv.push('--agent-teams')
const contextText = attachmentText.normalizeAttachmentForAPI(teamContext as never)
check('team_context still composes its context words for the model', contextText.length === 1 && JSON.stringify(contextText[0]).includes(TEAM))
const mailboxText = attachmentText.normalizeAttachmentForAPI(mailbox as never)
check('teammate_mailbox still composes its messages for the model', mailboxText.length === 1 && JSON.stringify(mailboxText[0]).includes('ping from the lead'))
const crewText = attachmentText.normalizeAttachmentForAPI(crewMessages as never)
check('crew_messages, the kind written from now on, composes the same envelope (RED on the base: nothing)', crewText.length === 1 && JSON.stringify(crewText[0]).includes('a note under the crew kind') && JSON.stringify(crewText[0]).includes('teammate_id='), JSON.stringify(crewText).slice(0, 200))
check('teammate_shutdown_batch composes nothing for the model and does not throw', Array.isArray(attachmentText.normalizeAttachmentForAPI(shutdownBatch as never)))
const contextMessage = messages.find(m => m.type === 'attachment' && (m.attachment as { type: string }).type === 'team_context')
const mailboxMessage = messages.find(m => m.type === 'attachment' && (m.attachment as { type: string }).type === 'teammate_mailbox')
check('team_context stays a null-rendering kind on screen', contextMessage !== undefined && nullRendering.isNullRenderingAttachment(contextMessage as never) === true)
check('teammate_mailbox is not a null-rendering kind on screen', mailboxMessage !== undefined && nullRendering.isNullRenderingAttachment(mailboxMessage as never) === false)
const crewMessage = messages.find(m => m.type === 'attachment' && (m.attachment as { type: string }).type === 'crew_messages')
check('crew_messages is not a null-rendering kind on screen either', crewMessage !== undefined && nullRendering.isNullRenderingAttachment(crewMessage as never) === false)

console.log('§4 an agent sidecar written under the old teammate key still reads as a crewmate record')
{
  const agentId = 'agent-old-sidecar-0001'
  const sidecarPath = paths.getAgentMetadataPath(agentId as never)
  mkdirSync(join(sidecarPath, '..'), { recursive: true })
  const old = { agentType: 'general-purpose', name: AGENT, launchedAt: 1, teammate: { teamName: TEAM, prompt: 'work the docs', transcriptAgentId: 'agent-old-sidecar-0001', planModeRequired: false } }
  writeFileSync(sidecarPath, JSON.stringify(old))
  const meta = (await paths.readAgentMetadata(agentId as never)) as Record<string, unknown> | null
  const record = (meta?.crewmate ?? null) as Record<string, unknown> | null
  check('the sidecar reads', meta !== null)
  check('the old teammate record reads as the crewmate record', record !== null && record.teamName === TEAM && record.prompt === 'work the docs', JSON.stringify(meta))
  check('the rest of the sidecar still reads', typeof meta?.agentType === 'string' && meta?.name === AGENT)
}

console.log(failures === 0 ? '\nold transcript kinds: ALL GREEN' : `\nold transcript kinds: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
