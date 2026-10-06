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
const crewMessages = { type: 'crew_messages', messages: [{ from: 'crew-lead', text: 'a note under the crew kind', timestamp: at(5), color: 'cyan' }] }
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
const a4 = uid()
row({ ...base(a4, a3, i++), type: 'attachment', attachment: crewMessages })
const OLD_QUEUED = '<teammate-message teammate_id="delta" color="blue" summary="READY delta">\nREADY delta\n</teammate-message>'
const q1 = uid()
row({ ...base(q1, a4, i++), type: 'attachment', attachment: { type: 'queued_command', prompt: OLD_QUEUED, source_uuid: uid(), commandMode: 'prompt' } })
const q2 = uid()
row({ ...base(q2, q1, i++), type: 'attachment', attachment: { type: 'queued_command', prompt: [{ type: 'text', text: OLD_QUEUED.replace('delta', 'echo').replace('delta', 'echo').replace('delta', 'echo') }], source_uuid: uid(), commandMode: 'prompt' } })
const q3 = uid()
row({ ...base(q3, q2, i++), type: 'attachment', attachment: { type: 'queued_command', prompt: 'a plain queued prompt', source_uuid: uid(), commandMode: 'prompt' } })
const u2 = uid()
row({ ...base(u2, q3, i++), type: 'user', message: { role: 'user', content: OLD_MESSAGE } })
const u3 = uid()
row({ ...base(u3, u2, i++), type: 'user', message: { role: 'user', content: 'thanks' } })

console.log('============================================================')
console.log(' the old crew spellings are unknown to every reader: team_context, teammate_mailbox, teammate_shutdown_batch, teamName, isTeammate, team_name, teammate_spawned, the teammate-message tag, TeamCreate and TeamBrief rows, the old sidecar key, the old roster folder, the old lead name, the old shortcut id, the old flags — each reads as written or as any unknown word')
console.log('============================================================')

console.log('§1 the transcript loads whole through the product reader; every row keeps the kind and the keys it was written with')
const log = await logs.loadTranscriptFromFile(file)
const messages = log.messages as Array<Record<string, unknown>>
check('every row of the chain is read', messages.length === 16, `${messages.length} rows`)
const attachments = messages.filter(m => m.type === 'attachment').map(m => (m.attachment as { type: string }).type)
check('the attachment kinds read exactly as written — no old kind is renamed at the decode point', JSON.stringify(attachments) === JSON.stringify(['team_context', 'teammate_mailbox', 'teammate_shutdown_batch', 'crew_messages', 'queued_command', 'queued_command', 'queued_command']), JSON.stringify(attachments))
const queued = messages.filter(m => m.type === 'attachment' && (m.attachment as { type: string }).type === 'queued_command').map(m => (m.attachment as { prompt: unknown }).prompt)
const queuedText = (prompt: unknown): string => (typeof prompt === 'string' ? prompt : (prompt as Array<{ text?: string }>).map(b => b.text ?? '').join('\n'))
check('a queued prompt written under the old tag reads as written (a string prompt)', queuedText(queued[0]) === OLD_QUEUED, queuedText(queued[0]))
check('the same for a queued prompt written as text blocks', Array.isArray(queued[1]) && queuedText(queued[1]) === OLD_QUEUED.replace(/delta/g, 'echo'), JSON.stringify(queued[1]))
check('a plain queued prompt is left as written', queued[2] === 'a plain queued prompt', JSON.stringify(queued[2]))
const toolNames = messages
  .filter(m => m.type === 'assistant')
  .flatMap(m => ((m.message as { content: Array<{ type: string; name?: string }> }).content ?? []).filter(c => c.type === 'tool_use').map(c => c.name))
check('the tool names on tool_use rows read as themselves', JSON.stringify(toolNames) === JSON.stringify(['TeamCreate', 'Agent', 'TeamBrief']), JSON.stringify(toolNames))
const glyphs = await import('../../src/components/mercury-ui/toolGlyphs.ts')
check('a tool name no build of Mercury ships paints as any unknown tool does — no family remembers it', glyphs.toolFamilyFor('TeamCreate') === glyphs.toolFamilyFor('FrobnicateTool') && glyphs.toolFamilyFor('TeamBrief') === glyphs.toolFamilyFor('FrobnicateTool'), `${glyphs.toolFamilyFor('TeamCreate')} / ${glyphs.toolFamilyFor('FrobnicateTool')}`)
check('no crew_context row is read from the old context kind', messages.find(m => m.type === 'attachment' && (m.attachment as { type: string }).type === 'crew_context') === undefined)
const oldContextRow = messages.find(m => m.type === 'attachment' && (m.attachment as { type: string }).type === 'team_context')?.attachment as Record<string, unknown> | undefined
check('the old context row keeps its keys as written', oldContextRow !== undefined && oldContextRow.teamName === TEAM && typeof oldContextRow.teamConfigPath === 'string' && !('crewName' in oldContextRow) && !('crewConfigPath' in oldContextRow), JSON.stringify(oldContextRow))
check('the old context row composes nothing for the model and paints nothing special on screen — an unknown kind', attachmentText.normalizeAttachmentForAPI(oldContextRow as never).length === 0 && nullRendering.isNullRenderingAttachment({ type: 'attachment', attachment: oldContextRow } as never) === false)
const mailboxRow = messages.find(m => m.type === 'attachment' && (m.attachment as { type: string }).type === 'teammate_mailbox')?.attachment as { messages: Array<{ text: string }> } | undefined
check('a terminated notice inside an old message row reads as written', mailboxRow !== undefined && mailboxRow.messages[1]!.text.includes('"teammate_terminated"') && !mailboxRow.messages[1]!.text.includes('crewmate_terminated'), JSON.stringify(mailboxRow?.messages[1]))
const crewMessagesRow = messages.find(m => m.type === 'attachment' && (m.attachment as { type: string }).type === 'crew_messages')?.attachment
const crewMessagesText = crewMessagesRow === undefined ? [] : attachmentText.normalizeAttachmentForAPI(crewMessagesRow as never)
check('a crew_messages row composes nothing for the model — an unknown kind like the old one', crewMessagesText.length === 0)
check('the old shutdown kind composes nothing for the model and does not throw', Array.isArray(attachmentText.normalizeAttachmentForAPI({ type: 'teammate_shutdown_batch', count: 2 } as never)) && attachmentText.normalizeAttachmentForAPI({ type: 'teammate_shutdown_batch', count: 2 } as never).length === 0)
const createRow = messages.find(m => m.type === 'assistant' && JSON.stringify(m).includes('toolu_teamcreate'))
const createInput = ((createRow?.message as { content: Array<{ input?: Record<string, unknown> }> }).content[0]?.input ?? {}) as Record<string, unknown>
check('the recorded row of a tool no build ships keeps its input as recorded (it paints; it never runs)', createInput.team_name === TEAM && !('crew_name' in createInput), JSON.stringify(createInput))
const spawnRow = messages.find(m => m.type === 'assistant' && JSON.stringify(m).includes('toolu_spawn'))
const spawnInput = ((spawnRow?.message as { content: Array<{ input?: Record<string, unknown> }> }).content[0]?.input ?? {}) as Record<string, unknown>
check('an Agent call written with team_name reads as written — nothing renames the field', spawnInput.team_name === TEAM && !('crew_name' in spawnInput), JSON.stringify(spawnInput))
const spawnResult = messages.find(m => 'toolUseResult' in m && JSON.stringify(m.toolUseResult).includes('agent-water'))?.toolUseResult as Record<string, unknown> | undefined
check('a spawn record written with teammate_spawned and team_name reads as written', spawnResult !== undefined && spawnResult.status === 'teammate_spawned' && spawnResult.team_name === TEAM && spawnResult.teammate_id === 'agent-water' && !('crew_name' in spawnResult) && !('crewmate_id' in spawnResult), JSON.stringify(spawnResult))
const messageRow = messages.find(m => m.type === 'user' && typeof (m.message as { content: unknown }).content === 'string' && ((m.message as { content: string }).content).includes('hello from water'))
const messageText = (messageRow?.message as { content: string } | undefined)?.content ?? ''
check('a message written under the old tag reads as written', messageText === OLD_MESSAGE, messageText)
check('every row of the chain keeps the stamps it was written with; none gains a crew stamp', messages.every(m => !('crewName' in m) && !('isCrewmate' in m)) && messages.some(m => m.teamName === TEAM && m.isTeammate === true))
const decodedTwice = decode.decodeTranscriptBuffer<Record<string, unknown>>(readFileSync(file, 'utf8')).entries
check('the decode point itself renames nothing (every reader shares it)', decodedTwice.every(e => !('crewName' in e)) && decodedTwice.some(e => e.teamName === TEAM))

console.log('§2 the session record reads no crew stamp from the old words')
check('the log carries no crewName stamp', log.crewName === undefined, String(log.crewName))
check('the picker does not class the transcript as a crew session', sessionClass.isCrewSession(log) === false)
const PLAIN_SID = '00000000-bbbb-4000-8000-0000000c0ffee'
const plainFile = join(dir, `${PLAIN_SID}.jsonl`)
const p1 = uid()
appendFileSync(plainFile, (vnext.encodeTranscriptLine(plainFile, { uuid: p1, parentUuid: null, isSidechain: false, cwd: SCRATCH, sessionId: PLAIN_SID, version: '1.0.0', timestamp: at(50), type: 'user', message: { role: 'user', content: 'a plain session' } }) as { line: string }).line)
const lite = (sessionId: string, fullPath: string): Record<string, unknown> => ({ date: at(60), messages: [], isLite: true, fullPath, value: 0, created: new Date(), modified: new Date(), firstPrompt: '', fileSize: readFileSync(fullPath).length, sessionId })
const enriched = await logs.enrichSessionListings([lite(SID, file), lite(PLAIN_SID, plainFile)] as never, 0, 2)
const liteOld = enriched.logs.find(l => l.sessionId === SID) ?? null
const litePlain = enriched.logs.find(l => l.sessionId === PLAIN_SID) ?? null
check('the lite session listing reads no crew stamp from the old head line: the transcript is listed beside the plain session like any other', liteOld !== null && litePlain !== null, JSON.stringify(enriched.logs.map(l => l.sessionId)))

console.log('§3 the old opt-in words on the command line enable nothing')
{
  process.env.MERCURY_CREWMATES = '0'
  process.argv.push('--agent-teams', '--agent-crews')
  check('with the crew surfaces off, the old words in argv turn nothing on', (await import('../../src/utils/crewEnabled.ts')).isCrewEnabled() === false)
  delete process.env.MERCURY_CREWMATES
  check('the command table declares neither word', !src('src/main.tsx').includes('--agent-crews') && !src('src/main.tsx').includes('--agent-teams'))
}

console.log('§4 an agent sidecar written under the old keys reads as written — no crewmate record is read from it')
{
  const agentId = 'agent-old-sidecar-0001'
  const sidecarPath = paths.getAgentMetadataPath(agentId as never)
  mkdirSync(join(sidecarPath, '..'), { recursive: true })
  const old = { agentType: 'general-purpose', name: AGENT, launchedAt: 1, teammate: { teamName: TEAM, prompt: 'work the docs', transcriptAgentId: 'agent-old-sidecar-0001' } }
  writeFileSync(sidecarPath, JSON.stringify(old))
  const meta = (await paths.readAgentMetadata(agentId as never)) as Record<string, unknown> | null
  check('the sidecar reads', meta !== null)
  check('no crewmate record is read from the old key', meta !== null && !('crewmate' in meta) && JSON.stringify(meta.teammate) === JSON.stringify(old.teammate), JSON.stringify(meta))
  check('the rest of the sidecar reads', typeof meta?.agentType === 'string' && meta?.name === AGENT)
}

console.log('§5 a roster saved in the old folder, under the old lead name, is not a crew Mercury knows')
{
  const envUtils = await import('../../src/utils/envUtils.ts')
  const helpers = await import('../../src/utils/crew/crewHelpers.ts')
  const constants = await import('../../src/utils/crew/constants.ts')
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
  check('the home has one crews folder — no other folder is read for rosters', !('getRetiredCrewsDir' in envUtils))
  const read = await helpers.readCrewFileAsync('oldcrew')
  check('a roster under the old folder is not found', read === null, JSON.stringify(read))
  check('the lead name is the crew word', constants.CREW_LEAD_NAME === 'crew-lead', constants.CREW_LEAD_NAME)
  const convert = await import('../../src/utils/crew/crewConvert.ts')
  const outcome = await convert.convertSavedCrews({ crewDir: join(HOME, 'crew-store') })
  check('the conversion of saved rosters reads the crews folder alone', !outcome.converted.includes('oldcrew') && !outcome.unchanged.includes('oldcrew') && outcome.crewsDir === join(HOME, 'crews'), JSON.stringify(outcome))
}

console.log('§6 the Agent tool reads its input as declared — an old field name is an unknown field')
{
  const agentTool = await import('../../src/tools/AgentTool/AgentTool.tsx')
  const parsed = agentTool.AgentTool.inputSchema.safeParse({ description: 'd', prompt: 'p', name: 'water', team_name: TEAM })
  const data = (parsed.success ? parsed.data : {}) as Record<string, unknown>
  check('an input carrying team_name parses as an input carrying an unknown field', parsed.success === true, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 2)))
  check('and lands no crew_name', !('crew_name' in data) && !('team_name' in data), JSON.stringify(data))
  const jsonSchema = JSON.stringify((await import('../../src/utils/zodToJsonSchema.ts')).zodToJsonSchema(agentTool.AgentTool.inputSchema as never))
  check('the schema the model sees names neither the old field nor a crew name', !jsonSchema.includes('crew_name') && !jsonSchema.includes('team_name'))
  check('the schema keeps its shape for every reader of its words', 'name' in ((agentTool.AgentTool.inputSchema as unknown as { shape: Record<string, unknown> }).shape ?? {}) && 'name' in ((agentTool.inputSchema() as unknown as { shape: Record<string, unknown> }).shape ?? {}))
}

console.log('§7 a saved keybinding under the old action id binds nothing Mercury knows')
{
  const parser = await import('../../src/keybindings/parser.ts')
  const bindings = parser.parseBindings([{ context: 'Global', bindings: { 'ctrl+shift+o': 'app:toggleTeammatePreview' } }] as never)
  check('the old id reads as written — no id is rewritten', bindings[0]?.action === 'app:toggleTeammatePreview', String(bindings[0]?.action))
  check('the crew id is the registered action and the old id is not', src('src/keybindings/actionGraph.ts').includes("'app:toggleCrewmatePreview'") && !src('src/keybindings/actionGraph.ts').includes("'app:toggleTeammatePreview'"))
  const loader = await import('../../src/keybindings/loadUserBindings.ts')
  writeFileSync(loader.getKeybindingsPath(), JSON.stringify({ bindings: [{ context: 'Global', bindings: { 'ctrl+shift+u': 'app:toggleTeammatePreview' } }] }))
  loader.invalidateKeybindingsCache()
  const loaded = await loader.loadKeybindings()
  const saved = loaded.bindings.filter(b => b.context === 'Global' && JSON.stringify(b.chord).includes('"u"')).map(b => b.action)
  check('a saved keybindings file under the old id loads through the product\'s own loader with the id as written and never as the crew action', saved.includes('app:toggleTeammatePreview') && !saved.includes('app:toggleCrewmatePreview'), JSON.stringify({ warnings: loaded.warnings, actions: saved }))
}

console.log('§8 the command line knows one crew spelling')
{
  const main = src('src/main.tsx')
  check('the crew flag is the one the launcher declares', main.includes("'--crew <name>'") && !main.includes("'--crew-name <name>'") && !main.includes("'--team-name <name>'"))
  check('the launcher reads the command line through no alias table', !main.includes('readRetiredCliFlags'))
}

console.log('§9 the journal knows the crew kinds alone')
{
  const ops = await optional('src/utils/crew/crewOperations.ts')
  const handlers = ops !== null && typeof ops.crewJournalRecoveryHandlers === 'function' ? (ops.crewJournalRecoveryHandlers as () => Record<string, unknown>)() : {}
  check('the crew kinds have handlers and the old kinds have none', 'crew-create' in handlers && 'crew-delete' in handlers && !('team-create' in handlers) && !('team-delete' in handlers), Object.keys(handlers).join(','))
  check('the journal dispatch reads the kind as written', src('src/substrate/operationJournal.ts').includes('handlers[op.kind]') && !src('src/substrate/operationJournal.ts').includes('readRetiredJournalKind'))
}

console.log('§10 the old command name is not carried: /crewmates has no alias')
{
  const crewmates = (await import('../../src/commands/crewmates/index.ts')).default as { name: string; aliases?: string[] }
  check('the command is /crewmates and carries no alias (no hidden old spelling)', crewmates.name === 'crewmates' && (crewmates.aliases ?? []).length === 0, JSON.stringify(crewmates))
}

console.log(failures === 0 ? '\nold transcript kinds: ALL GREEN' : `\nold transcript kinds: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
