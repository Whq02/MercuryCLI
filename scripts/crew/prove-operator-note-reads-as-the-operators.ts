#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ScriptedTurn } from '../lib/fixtureApi.ts'

const scratch = process.env.MERCURY_CONFIG_DIR
assert(scratch, 'run with a scratch MERCURY_CONFIG_DIR')
if (process.env.OPERATOR_NOTE_PROOF_HOME === undefined) {
  const own = mkdtempSync(join(scratch, 'operator-note-home-'))
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HOME: own, USERPROFILE: own, OPERATOR_NOTE_PROOF_HOME: own } })
  rmSync(own, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
assert.equal(homedir(), process.env.OPERATOR_NOTE_PROOF_HOME, 'the proof loads the product under its own scratch home')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(scratch, 'operator-note-config-'))
delete process.env.MERCURY_HOME

const { DIST, NODE, LEAD_GATE, LEAD_MODEL, closeWorld, makeTally, makeWorld, sleep } = await import('./crew-world.ts')
const { hostRunner } = await import('../lib/runnerHost.ts')
const { getQueuedCommandAttachments } = await import('../../src/utils/attachments/queuedCommands.ts')
const { normalizeAttachmentForAPI } = await import('../../src/utils/messages/attachmentText.ts')
const { enqueuePendingNotification, getCommandQueue } = await import('../../src/utils/messageQueueManager.ts')

const tally = makeTally('operator-note-reads-as-the-operators')
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the operator note proof exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

type Command = ReturnType<typeof getCommandQueue>[number]
const NOTE = 'NOTE-FROM-THE-OPERATOR stop after the first file'
const OPERATOR = 'The operator sent a new message while you were working:'
const COMPLETED = 'A background crewmate completed a task:'
const RUNTIME = 'Mercury runtime notice:'
const j = (value: unknown): string => JSON.stringify(value)
const queued = (fields: Record<string, unknown>): Command => {
  const before = getCommandQueue().length
  enqueuePendingNotification(fields as never)
  return getCommandQueue().slice(before)[0]!
}
async function drained(command: Command): Promise<{ text: string; hidden: boolean }> {
  const rows = (await getQueuedCommandAttachments([command])).flatMap(attachment => normalizeAttachmentForAPI(attachment)) as Array<{ message: { content: unknown }; isMeta?: boolean }>
  const content = rows[0]?.message.content
  return { text: typeof content === 'string' ? content : j(content), hidden: rows.length === 1 && rows[0]!.isMeta === true }
}

tally.section('§1 the frame: a note that carries the operator\'s mark reads as the operator\'s words do')
{
  const own = await drained(queued({ value: NOTE, mode: 'prompt', priority: 'next' }))
  const marked = await drained(queued({ value: NOTE, mode: 'task-notification', agentId: 'a1b2c3', origin: { kind: 'human' }, priority: 'next' }))
  const bare = await drained(queued({ value: NOTE, mode: 'task-notification', agentId: 'a1b2c3', priority: 'next' }))
  tally.check('the operator\'s own words drained in mid-turn: the operator\'s head, the words, the tail that says how to take them', own.text.startsWith(`<system-reminder>\n${OPERATOR}\n${NOTE}\n\nIMPORTANT: Read this message before taking your next action`) && own.text.endsWith('Do not silently drop it.\n</system-reminder>'), own.text.slice(0, 200))
  tally.check('a note to a crewmate that carries the operator\'s mark reads byte for byte the same, as a hidden reminder', marked.text === own.text && marked.hidden, marked.text.slice(0, 200))
  tally.check('the same note without the mark is not told as the operator\'s: it takes the head that claims nothing', bare.text === `<system-reminder>\n${RUNTIME}\n${NOTE}\n</system-reminder>` && bare.hidden, bare.text.slice(0, 200))
}

tally.section('§2 the wire: a note sent to a crewmate that is inside a tool, through a runner')
{
  assert(existsSync(DIST), `build first or pass --dist: ${DIST}`)
  const PEER_MODEL = 'claude-opus-4-6'
  const lead = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: LEAD_MODEL, whenModel: LEAD_GATE }) as ScriptedTurn
  const peer = (turn: Record<string, unknown>): ScriptedTurn => ({ ...turn, model: PEER_MODEL, whenModel: 'opus-4-6' }) as ScriptedTurn
  const world = await makeWorld('operator-note', [
    lead({ kind: 'tool_use', name: 'Crewmate', input: { name: 'worker', model: PEER_MODEL, crewmate_type: 'mercury-crew', description: 'Hold a tool open', prompt: 'Wait in a tool, then report.', run_in_background: true } }),
    lead({ kind: 'text', text: 'LEAD-WAITS.' }),
    lead({ kind: 'text', text: 'WORKER-NOTED.' }),
    lead({ kind: 'text', text: 'LEAD-SPARE.' }),
    peer({ kind: 'tool_use', name: 'Bash', input: { command: 'sleep 5', description: 'Hold the tool open' } }),
    peer({ kind: 'text', text: 'WORKER-DONE.' }),
  ])
  let raw = ''
  const host = hostRunner({ node: NODE, dist: DIST, argv: ['--model', LEAD_MODEL, '--allowed-tools', 'Bash', 'Crewmate', '--mode', 'sovereign'], cwd: world.project, env: world.env as Record<string, string | undefined>, home: world.env.MERCURY_CONFIG_DIR ?? world.project, raw: text => { raw += text } })
  const until = async (label: string, test: () => boolean, timeoutMs = 90_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`${label}\n--- rows tail ---\n${raw.slice(-1500)}\n--- stderr tail ---\n${host.stderr().slice(-1000)}`)
      await sleep(25)
    }
  }
  try {
    await host.initialize({})
    await host.prompt('Launch the worker and wait.')
    await until('the crewmate was launched', () => /agentId: (\w+)/.test(raw))
    const agentId = /agentId: (\w+)/.exec(raw)![1]!
    const receipt = await host.request('queue/add', { type: 'note', to: agentId, content: NOTE } as never, 10_000)
    tally.check('the runner takes a note addressed to the crewmate', (receipt as { accepted?: boolean }).accepted === true, j(receipt))
    await until('the lead noted the crewmate\'s end', () => raw.includes('WORKER-NOTED.'))
    host.end()
    await host.stop(30_000)
    type Part = { type?: string; text?: string }
    const requests = world.fixture.messageRequests().map(request => request.body as { model?: string; messages?: Array<{ role: string; content: string | Part[] }> })
    const partsOf = (request: (typeof requests)[number]): string[] => (request.messages ?? []).flatMap(message => (typeof message.content === 'string' ? [message.content] : message.content.flatMap(part => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))))
    const crewParts = requests.filter(request => request.model?.includes('opus-4-6') === true).flatMap(partsOf)
    const leadParts = requests.filter(request => request.model?.includes(LEAD_GATE) === true).flatMap(partsOf)
    const told = [...new Set(crewParts.filter(part => part.includes(NOTE)))]
    tally.check('the crewmate\'s request after its tool carries the note once, as one reminder', told.length === 1 && told[0]!.startsWith('<system-reminder>\n') && told[0]!.endsWith('\n</system-reminder>'), j(told.map(part => part.slice(0, 160))))
    tally.check('…headed as the operator\'s, with the operator\'s own frame (the parent heads the operator\'s words as a notice of the runtime, and the build before it as a crewmate\'s completion)', told[0]?.startsWith(`<system-reminder>\n${OPERATOR}\n${NOTE}\n\nIMPORTANT: Read this message before taking your next action`) === true && told[0]!.endsWith('Do not silently drop it.\n</system-reminder>'), j(told[0]?.slice(0, 200)))
    tally.check('…and no request says a crewmate completed a task, or the runtime gave notice, over the operator\'s words', !crewParts.some(part => part.includes(NOTE) && (part.includes(COMPLETED) || part.includes(RUNTIME))), j(crewParts.filter(part => part.includes(NOTE)).map(part => part.slice(0, 120))))
    tally.check('the note is the crewmate\'s alone: no request of the lead carries it', !leadParts.some(part => part.includes(NOTE)), j(leadParts.filter(part => part.includes(NOTE)).map(part => part.slice(0, 120))))
    tally.check('the crewmate went on and the lead was told of its end as before', crewParts.length > 0 && leadParts.some(part => part.includes('<summary>Crewmate "Hold a tool open" completed</summary>') && part.includes('<result>WORKER-DONE.</result>')), j(leadParts.filter(part => part.includes('<task-notification>')).map(part => part.slice(0, 200))))
  } finally {
    host.end()
    await host.stop(10_000).catch(() => undefined)
    await closeWorld(world)
  }
}

clearTimeout(watchdog)
tally.finish()
