#!/usr/bin/env bun
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const TMP = mkdtempSync(join(tmpdir(), 'mercury-livecomms-store-'))
process.env.MERCURY_CONFIG_DIR = TMP
process.env.MERCURY_CREWS_DIR = join(TMP, 'crews')

type AnyTool = {
  name: string
  aliases?: string[]
  inputSchema: { safeParse: (input: unknown) => { success: boolean } }
  call: (input: unknown, context: unknown) => Promise<{ data: unknown }>
  mapToolResultToToolResultBlockParam: (content: unknown, id: string) => { content: unknown }
}

const toolHome = 'src/tools/LiveCommsTool/LiveCommsTool.js'
const tool = (await import('../../src/tools/LiveCommsTool/LiveCommsTool.js')).LiveCommsTool as unknown as AnyTool
const { setDynamicCrewContext } = await import('../../src/utils/crewmate.js')
const { writeCrewFileAsync } = await import('../../src/utils/swarm/crewHelpers.js')
const { liveMessagesFor } = await import('../../src/services/crew/liveComms.js')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const CREW = 'live-crew'
const LEAD_ID = `lead@${CREW}`
const member = (id: string, name: string) => ({ agentId: id, name, joinedAt: Date.now(), tmuxPaneId: '', cwd: TMP, subscriptions: [] })
await writeCrewFileAsync(CREW, {
  name: CREW,
  createdAt: Date.now(),
  leadAgentId: LEAD_ID,
  members: [member(LEAD_ID, 'crew-lead'), member(`alice@${CREW}`, 'alice'), member(`bob@${CREW}`, 'bob')],
})

const asCrewmate = (name: string): void =>
  setDynamicCrewContext({ agentId: `${name}@${CREW}`, agentName: name, crewName: CREW, color: 'blue' })
const asLead = (): void => setDynamicCrewContext(null)
const leadContext = { getAppState: () => ({ crewContext: { crewName: CREW, leadAgentId: LEAD_ID } }) }
const crewmateContext = { getAppState: () => ({}) }

type Brief = {
  crewName: string | null
  openTasks: Array<{ id: string; subject: string; status: string; owner?: string }>
  unreadMessages: Array<{ from: string; text: string; summary?: string }>
  roster: Array<{ name: string; status: string; doing?: string }>
  leases: Array<{ agentId: string; globs: string[] }>
  wrote?: Array<{ kind: string; ok: boolean; detail: string }>
}
const call = async (input: unknown, context: unknown): Promise<Brief> => (await tool.call(input, context)).data as Brief
const rendered = (data: Brief): string => {
  const block = tool.mapToolResultToToolResultBlockParam(data, 'tu')
  return typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
}
const storeDir = join(TMP, 'crew', 'livecomms')
const storeFile = join(storeDir, `${CREW}.json`)
const storeJson = (): Record<string, unknown> => (existsSync(storeFile) ? (JSON.parse(readFileSync(storeFile, 'utf8')) as Record<string, unknown>) : {})

console.log('============================================================')
console.log(' LiveComms — the live store agents read AND write (real tool, real store)')
console.log('============================================================')
console.log(`  tool module: ${toolHome}`)

section('§1 the tool is LiveComms, answers to no other name, and takes a write')
{
  check('the tool is named LiveComms (RED on the base: the tool is LiveComms, a read-only snapshot)', tool.name === 'LiveComms', tool.name)
  check('the tool carries no alias — a call under any other name is a call to an unknown tool', (tool.aliases ?? []).length === 0, JSON.stringify(tool.aliases ?? []))
  const write = { say: { to: 'bob', message: 'LIVE-HELLO from alice', summary: 'hello' }, task: { subject: 'LIVE-TASK wire the store' }, claim: { paths: ['src/live/**'] }, busy: { busy: true, doing: 'LIVE-DOING' } }
  check('one call may carry a message, a task, a claim and a busy flag (RED on the base: the input is an empty strict object)', tool.inputSchema.safeParse(write).success)
  check('the empty read still parses', tool.inputSchema.safeParse({}).success)
}

section('§2 alice writes; bob and the lead read it live')
let taskId = ''
{
  asCrewmate('alice')
  const answer = await call(
    { say: { to: 'bob', message: 'LIVE-HELLO from alice', summary: 'hello' }, task: { subject: 'LIVE-TASK wire the store' }, claim: { paths: ['src/live/**'] }, busy: { busy: true, doing: 'LIVE-DOING' } },
    crewmateContext,
  )
  const wrote = answer.wrote ?? []
  check('the answer receipts four writes, every one ok (RED on the base: no write road — the input is ignored)', wrote.length === 4 && wrote.every(w => w.ok), JSON.stringify(wrote))
  check('the rendered answer lists what was written', /## Written \(4\)/.test(rendered(answer)), rendered(answer).slice(0, 200))
  taskId = answer.openTasks.find(t => t.subject === 'LIVE-TASK wire the store')?.id ?? ''

  asCrewmate('bob')
  const bob = await call({}, crewmateContext)
  check("bob's read carries alice's message unread (the message rides the message road)", bob.unreadMessages.some(m => m.from === 'alice' && m.text === 'LIVE-HELLO from alice' && m.summary === 'hello'), JSON.stringify(bob.unreadMessages))
  check("bob's read lists alice's task as open (RED on the base: no task written)", bob.openTasks.some(t => t.id === taskId && t.subject === 'LIVE-TASK wire the store' && t.status === 'pending'), JSON.stringify(bob.openTasks))
  check("bob's read lists alice's claim under her name (RED on the base: no claim written)", bob.leases.some(l => l.agentId === 'alice' && l.globs.includes('src/live/**')), JSON.stringify(bob.leases))
  check("bob's read shows alice busy with what she is doing (RED on the base: idle)", bob.roster.some(r => r.name === 'alice' && r.status === 'busy' && r.doing === 'LIVE-DOING'), JSON.stringify(bob.roster))
  const text = rendered(bob)
  check('the rendered read names the crew, the claim and the busy crewmate', /# Crew: live-crew/.test(text) && /## File claims \(1\)/.test(text) && /alice.*\[busy: LIVE-DOING\]/.test(text), text.slice(0, 400))

  asLead()
  const lead = await call({}, leadContext)
  check("the lead's read (its AppState crew context) lists the task, the claim and alice busy", lead.crewName === CREW && lead.openTasks.some(t => t.id === taskId) && lead.leases.some(l => l.agentId === 'alice') && lead.roster.some(r => r.name === 'alice' && r.status === 'busy'), JSON.stringify({ tasks: lead.openTasks, leases: lead.leases, roster: lead.roster }))
  const inbox = await liveMessagesFor(CREW, 'bob')
  check("the message landed in bob's inbox by the same road SendMessage uses", inbox.some(m => m.from === 'alice' && m.text === 'LIVE-HELLO from alice'), JSON.stringify(inbox))
}

section('§3 one file per crew on disk — the state any other process reads')
{
  const json = storeJson()
  const tasks = (json.tasks ?? {}) as Record<string, { subject: string }>
  const busy = (json.busy ?? {}) as Record<string, { busy: boolean }>
  check(`the store is one file under crew/livecomms/ (RED on the base: no such file)`, existsSync(storeFile), storeFile)
  check('it holds the task and the busy flag (the claim lives in the claim store the read merges)', Object.values(tasks).some(t => t.subject === 'LIVE-TASK wire the store') && busy.alice?.busy === true, JSON.stringify(json).slice(0, 300))
  const files = existsSync(storeDir) ? readdirSync(storeDir).filter(f => f.endsWith('.json')) : []
  check('no per-member file — one file for the whole crew', files.length === 1 && files[0] === `${CREW}.json`, JSON.stringify(files))
}

section('§4 a write by one is visible to the next read by any other, with no restart')
{
  asCrewmate('bob')
  const done = await call({ task: { id: taskId, status: 'completed' }, busy: false }, crewmateContext)
  check("bob completes alice's task and reads idle", (done.wrote ?? []).every(w => w.ok) && !done.openTasks.some(t => t.id === taskId) && done.roster.some(r => r.name === 'bob' && r.status === 'idle'), JSON.stringify({ wrote: done.wrote, tasks: done.openTasks, roster: done.roster }))
  asCrewmate('alice')
  const released = await call({ release: true, busy: false }, crewmateContext)
  check('alice releases her claim and reads idle; her next read shows the completed task gone', !released.leases.some(l => l.agentId === 'alice') && !released.openTasks.some(t => t.id === taskId) && released.roster.some(r => r.name === 'alice' && r.status === 'idle'), JSON.stringify({ leases: released.leases, roster: released.roster }))
  asLead()
  const lead = await call({}, leadContext)
  check("the lead's next read agrees: no claim, no open task, both idle", !lead.leases.some(l => l.agentId === 'alice') && !lead.openTasks.some(t => t.id === taskId) && lead.roster.filter(r => r.name === 'alice' || r.name === 'bob').every(r => r.status === 'idle'), JSON.stringify(lead.roster))
}

section('§5 the words: a message to nobody is refused, a read outside a crew says so')
{
  asCrewmate('alice')
  const refused = await call({ say: { to: 'nobody', message: 'x' } }, crewmateContext)
  const receipt = (refused.wrote ?? [])[0]
  check('a message to a name not on the crew is refused in the receipt, nothing written', receipt !== undefined && receipt.ok === false && /not on/.test(receipt.detail), JSON.stringify(refused.wrote))
  asLead()
  const solo = await call({}, { getAppState: () => ({}) })
  check('outside a crew the read is the honest empty state', solo.crewName === null && solo.openTasks.length === 0)
  check('and the rendered words say so in crew words', /Not part of a crew/.test(rendered(solo)), rendered(solo))
}

setDynamicCrewContext(null)
try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ PROOF PASSES — LiveComms is the live store crewmates read and write')
} else {
  console.log(` ❌ PROOF FAILED — ${failures} check(s) failed`)
  process.exit(1)
}
