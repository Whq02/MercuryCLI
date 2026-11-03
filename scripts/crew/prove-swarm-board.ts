import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

const suiteHome = process.env.MERCURY_CONFIG_DIR
assert(suiteHome, 'run with a scratch MERCURY_CONFIG_DIR')
const home = mkdtempSync(join(suiteHome, 'board-home-'))
process.env.MERCURY_CONFIG_DIR = home
const work = join(home, 'board-proof')
mkdirSync(work, { recursive: true })
process.chdir(work)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(work)
bootstrap.setCwdState(work)
bootstrap.setProjectRoot(work)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
const seam = await import('../../src/services/crewBoard/seam.ts')
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
const { getAllBaseTools } = await import('../../src/tools.ts')
const { writeAgentMetadata } = await import('../../src/utils/sessionStorage/paths.ts')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { createAssistantMessage } = await import('../../src/utils/messages.ts')
const { createFileStateCacheWithSizeLimit } = await import('../../src/utils/fileStateCache.ts')
const { runToolUse } = await import('../../src/services/tools/toolExecution.ts')
const { SendMessageTool } = await import('../../src/tools/SendMessageTool/SendMessageTool.ts')
const { ResumeAgentTool } = await import('../../src/tools/ResumeAgentTool/ResumeAgentTool.ts')
const { getSwarmAttachments } = await import('../../src/utils/attachments/queuedCommands.ts')
const { drainPendingMessages } = await import('../../src/tasks/LocalAgentTask/LocalAgentTask.tsx')
const { operatorPauseGate } = await import('../../src/run-core/pauseGate.ts')
let checks = 0
function check(label: string, truth: unknown): void { assert(truth, label); checks++; console.log(`PASS ${label}`) }

check('cold, with nothing set, the master is on and no implementation is imported', seam.swarmMasterEnabled() && !seam.swarmModuleLoaded())
check('a new session starts on and offers the deferred board tool', seam.swarmSessionEnabled() && getAllBaseTools().some(t => t.name === 'CrewBoard' && t.shouldDefer))
runSwarmCommand('off')
check('off removes the board tool for this session', !getAllBaseTools().some(t => t.name === 'CrewBoard'))
updateSettingsForSource('userSettings', { swarm: { enabled: false } })
check('an explicit false is the opt-out: the command answers with the setting door', !seam.swarmMasterEnabled() && runSwarmCommand('on').includes('swarm.enabled') && !seam.swarmSessionEnabled())
updateSettingsForSource('projectSettings', { swarm: { enabled: true } })
check('a repository cannot enable the board', !seam.swarmMasterEnabled())
updateSettingsForSource('userSettings', { swarm: { enabled: undefined } })
updateSettingsForSource('projectSettings', { swarm: { enabled: false } })
check('with the user setting absent the master is on, and a repository cannot turn it off either', seam.swarmMasterEnabled())
updateSettingsForSource('userSettings', { swarm: { enabled: true } })
check('the master setting does not override a session switched off', seam.swarmMasterEnabled() && !seam.swarmSessionEnabled() && runSwarmCommand('status').startsWith('Swarm off'))
check('an earlier launch stays plain', await seam.latchSwarmAgent('earlier', 'Earlier') === false)
await writeAgentMetadata('earlier' as never, { agentType: 'mercury-crew', swarm: false })
const enabledResult = runSwarmCommand('on')
check(`the command turns enrollment back on (${enabledResult})`, enabledResult.startsWith('Swarm on') && seam.swarmModuleLoaded())
check('plain launch does not migrate', !await seam.latchSwarmAgent('earlier', 'Earlier'))
check('two later crewmates join', await seam.latchSwarmAgent('alpha', 'Alpha') && await seam.latchSwarmAgent('beta', 'Beta'))
const board = seam.swarmStore()!
let changes = 0
const unsubscribe = board.subscribe(() => { changes++ })
let state = getDefaultAppState()
for (const id of ['earlier', 'alpha', 'beta']) state.tasks[id] = { id, type: 'local_agent', status: 'running', description: id, agentId: id, agentType: 'mercury-crew', prompt: '', startTime: Date.now(), isBackgrounded: true, outputFile: '', outputOffset: 0, notified: false } as never
const set = (fn: (s: typeof state) => typeof state): void => { state = fn(state) }
const context = (agentId?: string): any => ({
  agentId,
  abortController: new AbortController(),
  options: { tools: [...seam.swarmTools(agentId), SendMessageTool, ResumeAgentTool], commands: [], engineModel: 'fixture-model', thinkingConfig: { type: 'adaptive' }, mcpClients: [], mcpResources: {}, isNonInteractiveSession: true, agentDefinitions: { activeAgents: [], allAgents: [] } },
  getAppState: () => state, setAppState: set, setAppStateForTasks: set,
  messages: [], readFileState: createFileStateCacheWithSizeLimit(100), setInProgressToolUseIDs() {}, setResponseLength() {}, updateFileHistoryState() {}, updateAttributionState() {},
})
let serial = 0
let dispatchedMessages: any[] = []
async function dispatch(agent: string | undefined, name: string, input: unknown, expectError = false): Promise<any> {
  const id = `board-call-${++serial}`
  const toolUse = { type: 'tool_use', id, name, input }
  const assistant = createAssistantMessage({ content: [toolUse] as never })
  dispatchedMessages = [assistant]
  const ctx = context(agent)
  const results: any[] = []
  for await (const update of runToolUse(toolUse as never, assistant, async (_tool, input) => ({ behavior: 'allow', updatedInput: input }) as never, ctx)) {
    const msg: any = update.message
    if (msg) dispatchedMessages.push(msg)
    if (msg?.type === 'user') for (const block of msg.message.content) if (block.type === 'tool_result') results.push(block)
  }
  assert.equal(results.length, 1, JSON.stringify(results))
  assert.equal(results[0].is_error === true, expectError, String(results[0].content))
  if (expectError) return results[0].content
  const text = typeof results[0].content === 'string' ? results[0].content : results[0].content.map((b: any) => b.text).join('')
  return name === 'CrewBoard' ? JSON.parse(text) : { success: !results[0].is_error, message: text }
}
const first = await dispatch(undefined, 'CrewBoard', { op: 'post', clientOpId: 'lead-question', kind: 'ask', text: 'Which parser handles the row?', taskId: 'parser', mentions: ['alpha'] })
check('lead posts through real dispatch', first.ok)
const second = await dispatch('alpha', 'CrewBoard', { op: 'post', clientOpId: 'alpha-answer', kind: 'answer', text: 'The row parser handles it.', replyTo: first.eventId, mentions: ['beta'] })
check('a peer answers in the same ordered thread', second.ok && second.seq === first.seq + 1)
const read = await dispatch('beta', 'CrewBoard', { op: 'read', since: 0 })
check('the second peer selectively reads typed events', read.events.length > 0 && read.events[0].eventId === first.eventId && read.snapshot === second.seq)
check('the subscribed view changes only after commit', changes === 2 && board.view().events.length === 2)
const sent = await dispatch('alpha', 'SendMessage', { to: 'beta', message: 'Check the row boundary.' })
check('SendMessage is stored once', sent.success && board.view().events.filter(e => e.text === 'Check the row boundary.').length === 1)
check('board recipients get no duplicate old-inbox body', drainPendingMessages('beta', () => state, set).length === 0)
const packet = getSwarmAttachments(context('beta'), [])
const packetText = JSON.stringify(packet)
const { createAttachmentMessage } = await import('../../src/utils/attachments.ts')
const packetMessages = packet.map(createAttachmentMessage)
check('the active boundary carries the message once', packetText.split('Check the row boundary.').length === 2)
check('prepared but undispatched notifications are retained', JSON.stringify(getSwarmAttachments(context('beta'), [])) === packetText)
seam.swarmPresented('beta', packetMessages, 'request-1')
check('dispatch acknowledgment removes the pending copy', getSwarmAttachments(context('beta'), []).length === 0)
check('replayed acknowledgment does not redeliver', (seam.swarmPresented('beta', packetMessages, 'request-1'), getSwarmAttachments(context('beta'), []).length === 0))
const plain = await dispatch('alpha', 'SendMessage', { to: 'earlier', message: 'Plain seat note.' })
check('pre-swarm recipient stays on its original inbox once', plain.success && drainPendingMessages('earlier', () => state, set).length === 1 && getSwarmAttachments(context('earlier'), []).length === 0)
operatorPauseGate.pause()
const paused = await SendMessageTool.call({ to: 'beta', message: 'Wait until resumed.' }, context())
check('a peer note cannot lift an owner pause', paused.data.success && operatorPauseGate.holds('beta') && getSwarmAttachments(context('beta'), []).length === 0)
const interrupted = await ResumeAgentTool.call({ to: 'beta', message: 'Interrupt', interrupt: true }, context('alpha'), (() => {}) as never, {} as never)
check('peer interrupt is refused without reopening pause', !interrupted.data.success && operatorPauseGate.holds('beta'))
operatorPauseGate.resume()
check('pause keeps the direct note queued until resumed', JSON.stringify(drainPendingMessages('beta', () => state, set)).includes('Wait until resumed.'))
runSwarmCommand('off')
check('off hides the lead board and stops lead delivery', !getAllBaseTools().some(t => t.name === 'CrewBoard') && !seam.swarmView().on && seam.swarmBoundary(undefined, new Set()).length === 0)
check('off preserves earlier board seats', seam.swarmRoad('alpha') && seam.swarmRoad('beta'))
check('off makes future seats plain', !await seam.latchSwarmAgent('later', 'Later'))
runSwarmCommand('on')
const post = { clientOpId: 'retry', kind: 'ask' as const, text: 'A retry-safe question.' }
const principal = seam.swarmPrincipal('beta')!
const original = board.post(principal, post)
const repeated = board.post(principal, post)
check('identical retry returns the committed identity', original.ok && repeated.ok && repeated.replay && original.eventId === repeated.eventId)
check('changed payload under a retry key refuses', !board.post(principal, { ...post, text: 'A different question.' }).ok)
const foreign = await dispatch('beta', 'CrewBoard', { op: 'post', ...post, clientOpId: 'foreign', to: ['outside'] }, true)
check('an unknown-only post returns a plain tool error through real dispatch', foreign === 'no seat named outside — a seat exists once Crewmate launches it')
const mixed = await dispatch('beta', 'CrewBoard', { op: 'post', ...post, clientOpId: 'foreign', to: ['outside', 'Alpha'] })
check('a mixed post lands and reports the unknown name', mixed.ok && mixed.unknownMentions?.[0] === 'outside')
const taskless = await dispatch('beta', 'CrewBoard', { op: 'post', clientOpId: 'taskless', kind: 'result', text: 'The parser accepts the row.', about: 'parser.ts' })
check('a taskless result lands through real dispatch', taskless.ok)
const teamAssigned = await dispatch(undefined, 'CrewBoard', { op: 'swarm_team', seat: 'Beta', team: 'parser' })
const peerTeam = await dispatch('alpha', 'CrewBoard', { op: 'swarm_team', seat: 'Beta', team: 'wrong' })
check('team assignment dispatch takes only the lead road', teamAssigned.ok && !peerTeam.ok)
check('a forged sender cannot post', !board.post({ ...principal, author: { ...principal.author, sessionId: 'another' } }, post).ok)
const schema = seam.swarmTools()[0]!.inputSchema
check('the tool refuses forged identity and phase-two operations', !schema.safeParse({ op: 'post', author: 'main' }).success && !schema.safeParse({ op: 'claim' }).success && !schema.safeParse({ op: 'takeover' }).success)
board.read(seam.swarmPrincipal('beta')!, { task: 'dependency', files: ['parser.ts'], watch: true })
const finding = board.post(seam.swarmPrincipal('alpha')!, { clientOpId: 'dependency-result', kind: 'blocker', text: 'The parser needs the missing field.', taskId: 'other-task', files: ['parser.ts'], refs: [{ uri: 'mercury://agent/alpha', digest: 'a'.repeat(64) }] })
check('declared file dependencies receive relevant events without mentions', finding.ok && seam.swarmBoundary('beta', new Set()).some(packet => packet.eventIds.includes(finding.eventId)))
const filtered = board.read(seam.swarmPrincipal('alpha')!, { task: 'missing-task' })
check('a filtered read of an unrelated topic returns nothing', filtered.events.length === 0)
const readSince = board.view().snapshot
await dispatch('alpha', 'SendMessage', { to: 'beta', message: 'Read this directly before the next boundary.' })
const directRead = await dispatch('beta', 'CrewBoard', { op: 'read', since: readSince })
check('an explicit read does not gain a second automatic body in the same request', directRead.events.length === 1 && !JSON.stringify(getSwarmAttachments(context('beta'), dispatchedMessages)).includes('Read this directly before the next boundary.'))
seam.swarmPresented('beta', dispatchedMessages, 'read-before-notify')
check('dispatched reads acknowledge their events', !JSON.stringify(getSwarmAttachments(context('beta'), [])).includes('Read this directly before the next boundary.'))
const resumeContext = { ...context(), toolUseId: 'resume-proof' }
const mirroredResume = seam.mirrorSwarmResume(resumeContext, 'alpha', 'Continue the parser work.')
seam.mirrorSwarmResume(resumeContext, 'alpha', 'Continue the parser work.')
check('lead continuation mirrors once without another inbox delivery', mirroredResume?.ok && board.view().events.filter(event => event.text === 'Continue the parser work.… (sent directly)').length === 1 && drainPendingMessages('alpha', () => state, set).length === 0)
updateSettingsForSource('userSettings', { swarm: { enabled: false } })
const masterHeld = seam.swarmPeerMessage(context('alpha'), 'beta', 'Held by the master switch.')
check('master off refuses rather than migrating a board member to the old inbox', masterHeld.handled && !masterHeld.result?.success && seam.swarmTools('beta').length === 0 && drainPendingMessages('beta', () => state, set).length === 0)
updateSettingsForSource('userSettings', { swarm: { enabled: true } })
unsubscribe()
const { open } = await import('../../src/services/crewBoard/store.ts')
let now = 0
const reopenFile = join(work, 'reopen.sqlite')
const opened = open(reopenFile, 'reopen-session', () => now)
const a = { author: { sessionId: 'reopen-session', agentId: 'one', executionId: 'execution' }, name: 'one' }
const b = { author: { sessionId: 'reopen-session', agentId: 'two', executionId: 'execution' }, name: 'two' }
opened.enroll(a); opened.enroll(b)
for (let i = 0; i < 8; i++) assert(opened.post(a, { clientOpId: `p${i}`, kind: 'ask', text: `Question ${i}`, mentions: ['two'] }).ok)
for (let i = 8; i < 120; i++) { now += 15000; assert(opened.post(a, { clientOpId: `wave${i}`, kind: 'ask', text: 'Work finding.' }).ok) }
const initial = opened.boundary(b, new Set())
assert(initial)
opened.close()
const recovered = open(reopenFile, 'reopen-session', () => now)
check('append-before-notify and prepare-before-dispatch survive reopening', recovered.view().snapshot === 122 && JSON.stringify(recovered.boundary(b, new Set())) === JSON.stringify(initial))
recovered.presented(b, initial.eventIds, 'sent')
recovered.presented(b, initial.eventIds, 'sent')
check('replayed acknowledgment does not replay the event', !recovered.boundary(b, new Set())?.eventIds.some(id => initial.eventIds.includes(id)))
check('every view batch stays bounded', recovered.view().events.length <= 32 && recovered.view().omitted === 88)
check('the board has no peer-started turns', recovered.view().peerTurns === 0)
const older = recovered.view(89)
check('the human can page earlier history', older.events.length === 32 && older.events.at(-1)!.seq === 88 && older.omitted === 54)
const member = { ...b, author: { ...b.author, executionId: 'new-execution' } }
recovered.enroll(member)
check('an earlier execution cannot post after same-seat continuation', !recovered.post(b, { clientOpId: 'stale', kind: 'ask', text: 'Stale execution.' }).ok)
recovered.close()
console.log(`${checks} board checks passed`)
process.exit(0)
