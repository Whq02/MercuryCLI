import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { BoardLimits, BoardPost, BoardPrincipal } from '../../src/services/crewBoard/contracts.ts'

const suiteHome = process.env.MERCURY_CONFIG_DIR
assert(suiteHome, 'run with a scratch MERCURY_CONFIG_DIR')
const home = mkdtempSync(join(suiteHome, 'mentions-home-'))
process.env.MERCURY_CONFIG_DIR = home
const { open } = await import('../../src/services/crewBoard/store.ts')
const { DEFAULT_BOARD_LIMITS } = await import('../../src/services/crewBoard/contracts.ts')
let checks = 0
const check = (label: string, value: unknown) => { assert(value, label); console.log(`PASS ${label}`); checks++ }
function world(id: string, limits: Partial<BoardLimits> = {}) {
  let now = 0, serial = 0
  const board = open(join(home!, `${id}.sqlite`), id, { ...DEFAULT_BOARD_LIMITS, ...limits }, () => now)
  const seat = (agentId: string, name = agentId, team?: string): BoardPrincipal => {
    const principal = { author: { sessionId: id, agentId, executionId: 'run' }, name, team }
    board.enroll(principal)
    return principal
  }
  const main = seat('main')
  const alpha = seat('alpha', 'Alpha', 'engine')
  const beta = seat('beta', 'Beta', 'view')
  const post = (sender: BoardPrincipal, text: string, extra: Partial<BoardPost> = {}, delivery: 'body' | 'index' = 'index') => {
    now += 15000
    const receipt = board.post(sender, { clientOpId: `p${++serial}`, kind: 'result', text, ...extra }, delivery)
    assert(receipt.ok, JSON.stringify(receipt))
    return receipt
  }
  return { board, main, alpha, beta, seat, post }
}
{
  const w = world('whole')
  try {
    const text = '@Beta ' + 'Whole words " quoted \\ and Unicode é. '.repeat(80)
    const mention = w.post(w.alpha, text, { about: 'src/parser.ts', threadId: 'whole-thread' })
    const packet = w.board.boundary(w.beta, new Set())!
    check('a mention longer than the old packet ceiling arrives whole with about and thread', packet.text.includes(`[Alpha] [engine] [result]: ${text}`) && packet.text.includes('"about":"src/parser.ts"') && packet.text.includes('"thread":"whole-thread"'))
    const paid = w.board.view().admitted
    check('the prepared packet is retry-safe and charged once', JSON.stringify(w.board.boundary(w.beta, new Set())) === JSON.stringify(packet) && w.board.view().admitted === paid && paid > 768)
    w.board.presented(w.beta, packet.eventIds, 'whole')
    const read = w.board.read(w.beta, {})
    check('whole mentions are seen once without another read charge', read.events.length === 0 && read.skippedSeen === 1 && read.tokens === 0 && w.board.boundary(w.beta, new Set()) === null)
    check('whole mentions remain deliberately rereadable', w.board.read(w.beta, { since: mention.seq - 1 }).events[0]?.text === text)
    const question = w.post(w.beta, 'Which parser?', { kind: 'ask', threadId: 'reply-thread' })
    const reply = w.post(w.alpha, 'The row parser.', { kind: 'answer', replyTo: question.eventId, about: 'row.ts' })
    const third = w.seat('third', 'Third')
    const followup = w.post(third, 'The footer agrees.', { threadId: 'reply-thread', replyTo: reply.eventId })
    const replies = w.board.boundary(w.beta, new Set())!
    check('a thread starter receives both direct and nested replies whole', replies.eventIds.includes(reply.eventId) && replies.eventIds.includes(followup.eventId) && replies.text.includes('[Alpha] [engine] [answer]: The row parser.') && replies.text.includes('[Third] [result]: The footer agrees.') && replies.text.includes('"about":"row.ts"'))
    const team = w.post(w.alpha, '@view a label delivers words too.')
    const all = w.post(w.alpha, '@all common words.')
    const addressed = w.board.boundary(w.beta, new Set(replies.eventIds))!
    check('team and all mentions carry bodies', addressed.eventIds.includes(team.eventId) && addressed.eventIds.includes(all.eventId) && addressed.text.includes('@view a label delivers words too.') && addressed.text.includes('@all common words.'))
    w.board.assignTeam(w.main, 'main', 'leads')
    w.post(w.alpha, '@leads a label is not an idle-lead wake.', { kind: 'ask' })
    check('a team addressing the lead is not a direct main or all wake', w.board.leadMention() === null)
  } finally { w.board.close() }
}
{
  const w = world('mixed', { seatAllowance: 6000, waveAllowance: 2000, postChars: 0 })
  try {
    const filling = w.seat('filling')
    w.post(w.alpha, 'x'.repeat(5000))
    w.board.read(filling, { limitTokens: 1300 })
    w.board.read(w.beta, { task: 'relevant', watch: true })
    const relevantText = 'r'.repeat(200)
    const relevant = w.post(w.alpha, relevantText, { taskId: 'relevant' }, 'body')
    const mention = w.post(w.alpha, '@Beta this is addressed.')
    const packet = w.board.boundary(w.beta, new Set())!
    check('under refuse-last the same packet has a whole mention and a relevance reference', packet.eventIds[0] === mention.eventId && packet.eventIds.includes(relevant.eventId) && packet.text.includes('@Beta this is addressed.') && !packet.text.includes(relevantText))
    w.board.presented(w.beta, packet.eventIds, 'mixed')
    const unread = w.board.read(w.beta, { task: 'relevant' })
    check('the reference stays unread while the mention is seen', unread.events[0]?.text === relevantText && w.board.read(w.beta, { mentions: 'beta' }).events.length === 0)
  } finally { w.board.close() }
}
{
  const w = world('spent', { seatAllowance: 1000, waveAllowance: 1000, postChars: 0 })
  try {
    w.post(w.alpha, 'x'.repeat(5000))
    assert.equal(w.board.read(w.beta, {}).tokens, 1000)
    const mention = w.post(w.alpha, '@Beta this cannot become a silent reference.')
    check('a seat with zero remaining allowance gets no mention reference', w.board.boundary(w.beta, new Set()) === null)
    const notice = w.board.boundary(w.main, new Set())!
    check('a refused mention raises the lead notice with the seat and uncap road', notice.text.includes('Beta:') && notice.text.includes('swarm.seatAllowance') && notice.text.includes('/swarm uncap'))
    w.board.presented(w.main, notice.eventIds, 'cap-notice')
    w.board.boundary(w.beta, new Set())
    check('a mention cap raises one notice per seat and allowance', w.board.boundary(w.main, new Set()) === null)
    w.board.setUncapped(w.main, true)
    check('uncap delivers the retained mention whole', w.board.boundary(w.beta, new Set())?.eventIds.includes(mention.eventId) && w.board.boundary(w.beta, new Set())?.text.includes('@Beta this cannot become a silent reference.'))
  } finally { w.board.close() }
}
{
  const w = world('unlimited', { seatAllowance: 0, waveAllowance: 0, postChars: 0 })
  try {
    const text = '@Beta ' + 'unlimited '.repeat(1000)
    w.post(w.alpha, text)
    check('configured zero still means unlimited rather than a spent allowance', w.board.boundary(w.beta, new Set())?.text.includes(text))
  } finally { w.board.close() }
}

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setOriginalCwd(home); bootstrap.setCwdState(home); bootstrap.setProjectRoot(home)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')
updateSettingsForSource('userSettings', { swarm: { enabled: true } })
const seam = await import('../../src/services/crewBoard/seam.ts')
const { runSwarmCommand } = await import('../../src/commands/swarm/swarm.ts')
const { operatorPauseGate } = await import('../../src/run-core/pauseGate.ts')
runSwarmCommand('on')
await seam.latchSwarmAgent('sender', 'Sender')
let wakes = 0
const painted: string[] = []
let idle = true
const context = new AsyncLocalStorage<string>()
const contexts: (string | undefined)[] = []
const watch = context.run('lead', () => seam.watchSwarmLead(() => idle, () => { contexts.push(context.getStore()); wakes++ }, event => { contexts.push(context.getStore()); painted.push(event.eventId) }))
const sourceBoard = seam.swarmStore()!
const sender = seam.swarmPrincipal('sender')!
const ask = context.run('seat', () => sourceBoard.post(sender, { clientOpId: 'wake-source', kind: 'ask', text: '@main a source ask' }))
assert(ask.ok)
check('the live seam queues one wake and paints one row for an idle ask', wakes === 1 && painted.length === 1)
sourceBoard.post(sender, { clientOpId: 'wake-source-batch', kind: 'blocker', text: '@all a second source post' })
check('the live seam coalesces pending main asks', wakes === 1 && painted.length === 2)
const packet = seam.swarmBoundary(undefined, new Set())[0]!
sourceBoard.presented(seam.swarmPrincipal()!, packet.eventIds, 'source-wake')
idle = false
sourceBoard.post(sender, { clientOpId: 'active-source', kind: 'ask', text: '@main an active ask' })
check('active turns receive the next packet without a new wake', wakes === 1 && seam.swarmBoundary(undefined, new Set())[0]?.text.includes('an active ask'))
operatorPauseGate.pause()
idle = true
watch.check()
check('a pending board ask cannot lift a pause or wake a paused lead', wakes === 1 && operatorPauseGate.holds('main'))
operatorPauseGate.resume()
check('the existing resume boundary can deliver a pending ask', wakes === 2)
check('wake and screen callbacks keep the lead context rather than the posting seat context', contexts.every(value => value === 'lead'))
sourceBoard.read(seam.swarmPrincipal()!, { task: 'relevant', watch: true })
sourceBoard.post(sender, { clientOpId: 'relevant-source', kind: 'result', text: 'Relevance is only for Crew chat.', taskId: 'relevant' })
check('relevance-only traffic neither paints a lead notice nor wakes it', painted.length === 3 && wakes === 2)
watch.stop()
const painted2: string[] = []
const watch2 = context.run('lead', () => seam.watchSwarmLead(() => idle, () => {}, event => { painted2.push(event.eventId) }))
check('a restarted runner paints no mention twice: the painted cursor persists in the board', painted2.length === 0 && sourceBoard.leadPainted() > 0)
sourceBoard.post(sender, { clientOpId: 'after-restart', kind: 'ask', text: '@main an ask after the restart' })
check('the restarted watcher paints only the mention newer than the cursor', painted2.length === 1 && painted.length === 3)
watch2.stop()
runSwarmCommand('off')
seam.settleSwarmAgent('sender')
const { bootLead, closeWorld, findFiles, makeWorld, record, userTextsOf } = await import('./crew-world.ts')
const live = await makeWorld('swarm-mentions', [
  { kind: 'text', text: 'Lead is waiting.' },
  { kind: 'text', text: 'Handled the named result.' },
  { kind: 'text', text: 'Handled one mention.' },
  { kind: 'text', text: 'Handled the mention batch.' },
  { kind: 'text', text: 'Handled the named correction.' },
  { kind: 'text', text: 'Handled the all blocker.' },
])
const settingsPath = join(live.config, 'settings.json')
writeFileSync(settingsPath, JSON.stringify({ ...(existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}), swarm: { enabled: true } }))
const session = bootLead(live, [], ['CrewBoard'])
let board: ReturnType<typeof open> | undefined
try {
  session.submit('/swarm on')
  await session.waitFor('swarm opens', () => session.stdout().includes('Swarm on for new crewmates'))
  session.submit('Wait for crew questions.')
  await session.waitFor('the lead is idle', () => session.stdout().includes('Lead is waiting.'))
  const path = findFiles(live.config, 'board.sqlite')[0]!
  assert(path)
  const sessionDir = dirname(dirname(dirname(path)))
  const sid = basename(sessionDir)
  const transcript = join(dirname(sessionDir), `${sid}.jsonl`)
  board = open(path, sid)
  const sender = { author: { sessionId: sid, agentId: 'poster', executionId: 'run' }, name: 'Poster', team: 'engine' }
  board.enroll(sender)
  const saved = () => readFileSync(transcript, 'utf8')
  const plain = board.post(sender, { clientOpId: 'idle-all-result', kind: 'result', text: '@all a result for everyone, no wake.' })
  assert(plain.ok)
  await session.waitFor('the all result paints', () => saved().includes('a result for everyone, no wake.'))
  await new Promise(resolve => setTimeout(resolve, 400))
  check('an idle result addressed to all paints without a model turn', live.fixture.messageRequests().length === 1)
  const result = board.post(sender, { clientOpId: 'idle-result', kind: 'result', text: '@main the fold is verified green.' })
  assert(result.ok)
  await session.waitFor('a result addressed to main by name wakes the lead', () => session.stdout().includes('Handled the named result.')).finally(() => record('swarm-mention-transcript.jsonl', saved()))
  check('an idle result addressed to main by name starts one lead model turn with its packet', live.fixture.messageRequests().length === 2 && userTextsOf(live).some(text => text.includes('[Poster] [engine] [result]: @main the fold is verified green.')))
  const ask = board.post(sender, { clientOpId: 'idle-ask', kind: 'ask', text: '@main Please check the proposed law.', about: 'law.ts', threadId: 'idle-ask-thread' })
  assert(ask.ok)
  await session.waitFor('one addressed ask wakes the lead', () => session.stdout().includes('Handled one mention.')).finally(() => record('swarm-mention-transcript.jsonl', saved()))
  check('one idle main ask starts exactly one lead model turn with its whole packet', live.fixture.messageRequests().length === 3 && userTextsOf(live).some(text => text.includes('[Poster] [engine] [ask]: @main Please check the proposed law.') && text.includes('"about":"law.ts"') && text.includes('"thread":"idle-ask-thread"')))
  assert(board.post(sender, { clientOpId: 'batch-ask', kind: 'ask', text: '@main First in the batch.' }).ok)
  assert(board.post(sender, { clientOpId: 'batch-blocker', kind: 'blocker', text: '@main Second in the batch.' }).ok)
  await session.waitFor('the batch wakes once', () => session.stdout().includes('Handled the mention batch.'))
  await new Promise(resolve => setTimeout(resolve, 400))
  check('two main posts in one idle stretch start one turn carrying both', live.fixture.messageRequests().length === 4 && userTextsOf(live).some(text => text.includes('First in the batch.') && text.includes('Second in the batch.')))
  assert(board.post(sender, { clientOpId: 'idle-correction', kind: 'correction', corrects: result.eventId, text: '@main corrected: verified green on the final tree.' }).ok)
  await session.waitFor('a correction addressed to main by name wakes the lead', () => session.stdout().includes('Handled the named correction.')).finally(() => record('swarm-mention-transcript.jsonl', saved()))
  check('an idle correction addressed to main by name starts one lead model turn', live.fixture.messageRequests().length === 5)
  assert(board.post(sender, { clientOpId: 'all-blocker', kind: 'blocker', text: '@all A blocker for the lead too.' }).ok)
  await session.waitFor('all blocker wakes the lead', () => session.stdout().includes('Handled the all blocker.'))
  check('a seat all blocker wakes the idle lead once', live.fixture.messageRequests().length === 6)
  check('screen-only rows never duplicate board words on the model wire', live.fixture.messageRequests().every(request => !JSON.stringify(request.body).includes('<crew-board>')))
  assert.equal(await session.end(), 0, session.stderr())
} finally {
  record('swarm-mention-requests.json', JSON.stringify(live.fixture.messageRequests().map(request => request.body)))
  record('swarm-mention-out.txt', session.stdout())
  board?.close()
  await session.terminate()
  await closeWorld(live)
}
console.log(`${checks} mention delivery and built idle-wake checks passed`)
process.exit(0)
