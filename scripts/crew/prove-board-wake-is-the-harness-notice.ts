#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { DIST, NODE, ROOT, closeWorld, findFiles, makeTally, makeWorld, record, sleep } from './crew-world.ts'
import { hostRunner } from '../lib/runnerHost.ts'

const { open } = await import('../../src/services/crewBoard/store.ts')
const { BOARD_PACKET_RULE } = await import('../../src/services/crewBoard/contracts.ts')

const SETTLE_MS = 4_000
const job = (seconds: number, word: string) => ({ kind: 'tool_use' as const, name: 'Bash', input: { command: `sleep ${seconds}; echo ${word}`, description: `Print ${word} after a while`, run_in_background: true } })
const world = await makeWorld('board-wake-notice', [
  { kind: 'text', text: 'Lead is waiting.' },
  { kind: 'text', text: 'WAKE-ALONE-REPLY.' },
  job(4, 'job-one-done'),
  { kind: 'text', text: 'Job one started.' },
  { kind: 'text', text: 'SHOWN-THEN-WAKE-REPLY.' },
  job(3, 'job-two-done'),
  { kind: 'text', text: 'Job two started.' },
  { kind: 'text', text: 'WAKE-THEN-SHOWN-REPLY.' },
])
const settings = join(world.config, 'settings.json')
writeFileSync(settings, JSON.stringify({ ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}), swarm: { enabled: true } }))
const tally = makeTally('board-wake-is-the-harness-notice')
let raw = ''
const host = hostRunner({ dist: DIST, node: NODE, cwd: world.project, home: world.config, env: { ...world.env, MERCURY_SETTLE_WINDOW_MS: String(SETTLE_MS) } as Record<string, string | undefined>, argv: ['--model', 'claude-fable-5-1', '--allowed-tools', 'Bash', 'CrewBoard'], raw: line => { raw += line } })
const until = async (label: string, test: () => boolean, timeoutMs = 90_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`${label}\n--- rows tail ---\n${raw.slice(-2000)}\n--- stderr tail ---\n${host.stderr().slice(-1500)}`)
    await sleep(25)
  }
}
const answered = async (label: string, from: number, answer: string): Promise<void> => until(label, () => raw.slice(from).includes(answer) && raw.slice(raw.indexOf(answer, from)).includes('"type":"outcome"'))
const prompt = async (text: string, answer: string): Promise<void> => {
  const from = raw.length
  await host.prompt(text)
  await answered(`${text} answered`, from, answer)
}

type Block = { type?: string; text?: string }
type Wire = { role: string; content: string | Block[] }
const textsOf = (message: Wire): string[] => (typeof message.content === 'string' ? [message.content] : message.content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])))
const enveloped = (text: string): boolean => {
  let rest = text
  for (let at = rest.indexOf(BOARD_PACKET_RULE); at !== -1; at = rest.indexOf(BOARD_PACKET_RULE)) {
    const opened = rest.lastIndexOf('<system-reminder>', at)
    const closed = rest.lastIndexOf('</system-reminder>', at)
    if (opened === -1 || closed > opened) return false
    rest = rest.slice(at + BOARD_PACKET_RULE.length)
  }
  return true
}
const requestFor = (word: string): Wire[] => {
  const found = world.fixture.messageRequests().find(request => JSON.stringify(request.body).includes(word))
  return ((found?.body as { messages?: Wire[] } | undefined)?.messages ?? []) as Wire[]
}
const ruleTexts = (messages: Wire[]): string[] => messages.filter(message => message.role === 'user').flatMap(textsOf).filter(text => text.includes(BOARD_PACKET_RULE))
const WAKE_ADVICE = 'Read reference-only posts with CrewBoard.'
const told = (messages: Wire[]): boolean => ruleTexts(messages).some(text => text.includes(WAKE_ADVICE)) && ruleTexts(messages).every(enveloped)

let board: ReturnType<typeof open> | undefined
let transcript = ''
try {
  await host.initialize({})
  await prompt('/swarm on', 'Swarm on for new crewmates')
  await prompt('Wait for crew questions.', 'Lead is waiting.')
  await sleep(500)
  const path = findFiles(world.config, 'board.sqlite')[0]!
  const sessionDir = dirname(dirname(dirname(path)))
  const sid = basename(sessionDir)
  transcript = join(dirname(sessionDir), `${sid}.jsonl`)
  board = open(path, sid)
  const sender = { author: { sessionId: sid, agentId: 'poster', executionId: 'run' }, name: 'poster', team: 'lists' }
  board.enroll(sender)
  const ask = (clientOpId: string, text: string): void => {
    const receipt = board!.post(sender, { clientOpId, kind: 'ask', text })
    assert(receipt.ok, JSON.stringify(receipt))
  }

  const alone = raw.length
  ask('alone', '@main ALONE-ASK which file first?')
  await answered('the wake alone was answered', alone, 'WAKE-ALONE-REPLY.')

  await prompt('start job one', 'Job one started.')
  await sleep(5_500)
  const shownFirst = raw.length
  ask('shown-first', '@main SHOWN-FIRST-ASK is the build green?')
  await answered('the finished job and the wake were answered in one turn', shownFirst, 'SHOWN-THEN-WAKE-REPLY.')

  const wakeFirst = raw.length
  await host.prompt('start job two')
  await answered('job two started', wakeFirst, 'Job two started.')
  ask('wake-first', '@main WAKE-FIRST-ASK may I take the README?')
  await answered('the wake and the finished job were answered in one turn', wakeFirst, 'WAKE-THEN-SHOWN-REPLY.')
  host.end()
  await host.stop(30_000)

  tally.section('§1 the wire: the board\'s wake reaches the model inside the harness\'s envelope, never as bare words in the user\'s turn')
  const aloneWire = requestFor('ALONE-ASK')
  const shownFirstWire = requestFor('SHOWN-FIRST-ASK')
  const wakeFirstWire = requestFor('WAKE-FIRST-ASK')
  tally.check('the scenes: each ask reached the model in its own request, and the two finished jobs rode with their asks', aloneWire.length > 0 && JSON.stringify(shownFirstWire).includes('job-one-done') && JSON.stringify(wakeFirstWire).includes('job-two-done'), `${aloneWire.length} · ${JSON.stringify(shownFirstWire).includes('job-one-done')} · ${JSON.stringify(wakeFirstWire).includes('job-two-done')}`)
  tally.check('woken alone: the wake\'s words reach the model, and every text that holds the rule holds it inside a system reminder', told(aloneWire), JSON.stringify(ruleTexts(aloneWire).map(text => text.slice(0, 160))))
  tally.check('behind a finished job: the same', told(shownFirstWire), JSON.stringify(ruleTexts(shownFirstWire).map(text => text.slice(0, 160))))
  tally.check('ahead of a finished job: the same', told(wakeFirstWire), JSON.stringify(ruleTexts(wakeFirstWire).map(text => text.slice(0, 160))))

  tally.section('§2 the record the screen paints from: one mark an item, so a hidden wake neither borrows a shown notice\'s face nor hides it')
  const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
  enableConfigs()
  const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
  const loaded = await loadTranscriptFile(transcript, { keepAllLeaves: true })
  type Row = { type: string; isMeta?: boolean; origin?: unknown; message?: { content?: string | Block[] } }
  const users = ([...loaded.messages.values()] as unknown as Row[]).filter(row => row.type === 'user')
  const wordsOf = (row: Row): string[] => (typeof row.message?.content === 'string' ? [row.message.content] : (row.message?.content ?? []).flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])))
  const holding = (word: string): Row[] => users.filter(row => wordsOf(row).some(text => text.includes(word)))
  const rule = holding(BOARD_PACKET_RULE)
  const jobOne = holding('job-one-done').filter(row => wordsOf(row).some(text => text.includes('<task-notification>')))
  const jobTwo = holding('job-two-done').filter(row => wordsOf(row).some(text => text.includes('<task-notification>')))
  tally.check('every row that holds the wake\'s words is hidden', rule.length >= 3 && rule.every(row => row.isMeta === true), JSON.stringify(rule.map(row => ({ meta: row.isMeta ?? false, head: wordsOf(row).map(text => text.slice(0, 60)) }))))
  tally.check('the first finished job has one row, shown, and that row holds nothing of the wake', jobOne.length === 1 && jobOne[0]!.isMeta !== true && !wordsOf(jobOne[0]!).some(text => text.includes(BOARD_PACKET_RULE)), JSON.stringify(jobOne.map(row => ({ meta: row.isMeta ?? false, blocks: wordsOf(row).map(text => text.slice(0, 60)) }))))
  tally.check('the second finished job, queued behind the wake, has one row, shown: the wake\'s mark did not hide it', jobTwo.length === 1 && jobTwo[0]!.isMeta !== true && !wordsOf(jobTwo[0]!).some(text => text.includes(BOARD_PACKET_RULE)), JSON.stringify(jobTwo.map(row => ({ meta: row.isMeta ?? false, blocks: wordsOf(row).map(text => text.slice(0, 60)) }))))

  tally.section('§3 the frame: the rows of the two finished jobs, painted')
  const React = (await import('react')).default
  const { render } = await import(join(ROOT, 'src/ink.ts'))
  const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
  const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
  const { UserTextMessage } = await import(join(ROOT, 'src/components/messages/UserTextMessage.tsx'))
  const { MessageMetaProvider } = await import(join(ROOT, 'src/components/messages/TranscriptNameplate.tsx'))
  const h = React.createElement as (...a: unknown[]) => React.ReactElement
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
  const paint = async (row: Row): Promise<string> => {
    let written = ''
    const stdout = Object.assign(new Writable({ write(chunk: Buffer, _enc, cb) { written += chunk.toString(); cb() } }), { columns: 100, rows: 30, isTTY: false }) as unknown as NodeJS.WriteStream
    const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
    const blocks = wordsOf(row).map((text, index) => h(UserTextMessage as never, { key: index, addMargin: false, param: { type: 'text', text }, verbose: false, origin: row.origin }))
    const instance = await render(h(AppStateProvider as never, { initialState: getDefaultAppState() }, h(MessageMetaProvider as never, { message: { type: 'user', timestamp: '2026-11-11T05:00:00.000Z' } }, ...blocks)), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
    await sleep(200)
    instance.unmount?.()
    await sleep(50)
    return strip(written).replace(/\s+/g, ' ')
  }
  for (const [name, rows, word] of [['the first', jobOne, 'job-one-done'], ['the second', jobTwo, 'job-two-done']] as const) {
    const frame = rows.length === 1 ? await paint(rows[0]!) : ''
    tally.check(`${name} finished job paints as its own notice, with none of the wake's words and no prompt caret`, frame.includes(`Print ${word} after a while`) && !frame.includes('Posts marked') && !frame.includes('❯'), frame.slice(0, 300))
  }
} finally {
  record('board-wake-notice-out.txt', raw)
  record('board-wake-notice-requests.json', JSON.stringify(world.fixture.messageRequests().map(request => request.body)))
  board?.close()
  await host.stop(5_000)
  await closeWorld(world)
}
tally.finish()
