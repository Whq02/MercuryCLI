#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scratch = process.env.MERCURY_CONFIG_DIR
assert(scratch, 'run with a scratch MERCURY_CONFIG_DIR')
if (process.env.WAKE_WORDS_PROOF_HOME === undefined) {
  const own = mkdtempSync(join(scratch, 'wake-words-home-'))
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, HOME: own, USERPROFILE: own, WAKE_WORDS_PROOF_HOME: own } })
  rmSync(own, { recursive: true, force: true })
  process.exit(child.status ?? 1)
}
assert.equal(homedir(), process.env.WAKE_WORDS_PROOF_HOME, 'the proof loads the product under its own scratch home')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(scratch, 'wake-words-config-'))
delete process.env.MERCURY_HOME

const { DIST, NODE, LEAD_MODEL, closeWorld, findFiles, makeTally, makeWorld, record, sleep } = await import('./crew-world.ts')
const { hostRunner } = await import('../lib/runnerHost.ts')
const { open } = await import('../../src/services/crewBoard/store.ts')
const { BOARD_PACKET_RULE } = await import('../../src/services/crewBoard/contracts.ts')
const { enqueueBoardWake } = await import('../../src/services/crewBoard/seam.ts')
const { getCommandQueue } = await import('../../src/utils/messageQueueManager.ts')
const { wrapInSystemReminder } = await import('../../src/utils/messages/text.ts')

const tally = makeTally('board-wake-says-its-advice')
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — the wake words proof exceeded 240s')
  process.exit(1)
}, 240_000)
watchdog.unref?.()

const ADVICE = 'Read reference-only posts with CrewBoard.'
const ADVICE_LINE = wrapInSystemReminder(ADVICE)
const RULE_LINE = wrapInSystemReminder(BOARD_PACKET_RULE)
const PACKET_HEAD = `<system-reminder>\n${BOARD_PACKET_RULE}\ncrew-board-event:`
type Block = { type?: string; text?: string }
type Wire = { role: string; content: string | Block[] }
const textsOf = (message: Wire | undefined): string[] => (message === undefined ? [] : typeof message.content === 'string' ? [message.content] : message.content.flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])))
const count = (texts: string[], needle: string): number => texts.reduce((sum, text) => sum + text.split(needle).length - 1, 0)
const j = (value: unknown): string => JSON.stringify(value)

tally.section('§1 the words the board\'s wake is given: its advice alone; with no advice, the rule alone')
{
  const before = getCommandQueue().length
  enqueueBoardWake(ADVICE)
  enqueueBoardWake()
  const [advised, bare] = getCommandQueue().slice(before)
  tally.check('a wake that carries advice says the advice alone, inside its reminder (the parent says the rule before it)', advised?.value === ADVICE_LINE, j(advised?.value))
  tally.check('a wake with no advice says the rule alone, as it did', bare?.value === RULE_LINE, j(bare?.value))
  tally.check('both stay what they were to the queue: a meta notification taken next', [advised, bare].every(command => command?.mode === 'task-notification' && command.isMeta === true && command.priority === 'next'), j([advised, bare].map(command => ({ mode: command?.mode, isMeta: command?.isMeta, priority: command?.priority }))))
}

tally.section('§2 the wire: in a wake\'s turn the rule is read once, at the head of the packet; with no packet the wake says its advice and the rule is not said again')
{
  assert(existsSync(DIST), `build first or pass --dist: ${DIST}`)
  const world = await makeWorld('board-wake-words', [
    { kind: 'text', text: 'Lead is waiting.' },
    { kind: 'text', text: 'ALONE-REPLY.' },
    { kind: 'text', text: 'LINE-FIRST-REPLY.' },
    { kind: 'text', text: 'LATE-WAKE-REPLY.' },
  ])
  const settings = join(world.config, 'settings.json')
  writeFileSync(settings, JSON.stringify({ ...(existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {}), swarm: { enabled: true } }))
  let raw = ''
  const host = hostRunner({ dist: DIST, node: NODE, cwd: world.project, home: world.config, env: { ...world.env, MERCURY_SETTLE_WINDOW_MS: '4000' } as Record<string, string | undefined>, argv: ['--model', LEAD_MODEL, '--allowed-tools', 'CrewBoard'], raw: line => { raw += line } })
  const until = async (label: string, test: () => boolean, timeoutMs = 90_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`${label}\n--- rows tail ---\n${raw.slice(-1500)}\n--- stderr tail ---\n${host.stderr().slice(-1000)}`)
      await sleep(25)
    }
  }
  const answered = async (label: string, from: number, answer: string): Promise<void> => until(label, () => raw.slice(from).includes(answer) && raw.slice(raw.indexOf(answer, from)).includes('"type":"outcome"'))
  const prompt = async (text: string, answer: string): Promise<void> => {
    const from = raw.length
    await host.prompt(text)
    await answered(`${text} answered`, from, answer)
  }
  let board: ReturnType<typeof open> | undefined
  let transcript = ''
  try {
    await host.initialize({})
    await prompt('/swarm on', 'Swarm on for new crewmates')
    await prompt('Wait for crew questions.', 'Lead is waiting.')
    await sleep(500)
    const sessionId = String(host.rows.find(row => row.type === 'session')?.session_id ?? '')
    const path = findFiles(world.config, 'board.sqlite').find(candidate => candidate.includes(sessionId))!
    const sid = basename(dirname(dirname(dirname(path))))
    transcript = join(dirname(dirname(dirname(dirname(path)))), `${sid}.jsonl`)
    board = open(path, sid)
    const sender = { author: { sessionId: sid, agentId: 'poster', executionId: 'run' }, name: 'poster' }
    board.enroll(sender)
    const ask = (clientOpId: string, text: string): void => {
      const receipt = board!.post(sender, { clientOpId, kind: 'ask', text })
      assert(receipt.ok, JSON.stringify(receipt))
    }
    const alone = raw.length
    ask('alone', '@main ALONE-ASK which file first?')
    await answered('the wake alone was answered', alone, 'ALONE-REPLY.')
    await sleep(500)
    const first = raw.length
    ask('line-first', '@main LINE-FIRST-ASK is the build green?')
    await sleep(700)
    await host.prompt('take this line first')
    await answered('the operator\'s line was answered first', first, 'LINE-FIRST-REPLY.')
    await answered('the wake was answered after it', first, 'LATE-WAKE-REPLY.')
    host.end()
    await host.stop(30_000)

    const requests = world.fixture.messageRequests().map(request => ((request.body as { messages?: Wire[] } | undefined)?.messages ?? []) as Wire[])
    const opening = (holding: string, lacking?: string): string[] => {
      const found = requests.find(messages => {
        const texts = textsOf(messages.at(-1))
        return messages.at(-1)?.role === 'user' && texts.some(text => text.includes(holding)) && (lacking === undefined || !texts.some(text => text.includes(lacking)))
      })
      return textsOf(found?.at(-1))
    }
    const aloneTurn = opening('ALONE-ASK')
    const lineTurn = opening('take this line first')
    const lateTurn = requests.map(messages => textsOf(messages.at(-1))).find(texts => texts.some(text => text.includes(ADVICE)) && !texts.some(text => text.includes('crew-board-event:')) && !texts.some(text => text.includes('take this line first'))) ?? []
    tally.check('the scenes reached the model: a wake alone with its packet, an operator\'s line that took the packet first, then the wake with none', aloneTurn.length > 0 && lineTurn.some(text => text.includes('LINE-FIRST-ASK')) && lateTurn.length > 0, `${aloneTurn.length} · ${lineTurn.length} · ${lateTurn.length}`)
    tally.check('woken alone: the rule is read once in the turn (the parent says it twice)', count(aloneTurn, BOARD_PACKET_RULE) === 1, `${count(aloneTurn, BOARD_PACKET_RULE)}: ${j(aloneTurn.map(text => text.slice(0, 140)))}`)
    tally.check('…at the head of the packet, the posts under it', aloneTurn.filter(text => text.startsWith(PACKET_HEAD) && text.includes('ALONE-ASK')).length === 1, j(aloneTurn.map(text => text.slice(0, 140))))
    tally.check('…and the wake\'s own line is its advice alone, inside its reminder', aloneTurn.filter(text => text === ADVICE_LINE).length === 1, j(aloneTurn.map(text => text.slice(0, 140))))
    tally.check('an operator\'s line that gets in first carries the packet: the rule once, at its head, and no wake line', count(lineTurn, BOARD_PACKET_RULE) === 1 && lineTurn.some(text => text.startsWith(PACKET_HEAD) && text.includes('LINE-FIRST-ASK')) && !lineTurn.some(text => text.includes(ADVICE)), j(lineTurn.map(text => text.slice(0, 140))))
    tally.check('the wake that follows it has no packet: it says its advice alone, inside its reminder', lateTurn.length > 0 && lateTurn.filter(text => text === ADVICE_LINE).length === 1, j(lateTurn.map(text => text.slice(0, 140))))
    tally.check('…and the rule is not said in that turn (the parent says it there, with nothing under it)', lateTurn.length > 0 && count(lateTurn, BOARD_PACKET_RULE) === 0, `${count(lateTurn, BOARD_PACKET_RULE)}: ${j(lateTurn.map(text => text.slice(0, 140)))}`)
    const last = requests.at(-1) ?? []
    const every = last.filter(message => message.role === 'user').flatMap(textsOf)
    tally.check('across the whole conversation the rule stands only at the head of a packet, once a packet', count(every, BOARD_PACKET_RULE) === every.filter(text => text.startsWith(PACKET_HEAD)).length && count(every, BOARD_PACKET_RULE) === 2, `${count(every, BOARD_PACKET_RULE)} rule(s) · ${every.filter(text => text.startsWith(PACKET_HEAD)).length} packet(s)`)

    tally.section('§3 the record and the request say the same words')
    const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
    enableConfigs()
    const { loadTranscriptFile } = await import('../../src/utils/sessionStorage/loading.ts')
    const loaded = await loadTranscriptFile(transcript, { keepAllLeaves: true })
    type Row = { type: string; isMeta?: boolean; message?: { content?: string | Block[] } }
    const users = ([...loaded.messages.values()] as unknown as Row[]).filter(row => row.type === 'user')
    const wordsOf = (row: Row): string[] => (typeof row.message?.content === 'string' ? [row.message.content] : (row.message?.content ?? []).flatMap(block => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])))
    const wakes = users.filter(row => wordsOf(row).some(text => text.includes(ADVICE)))
    tally.check('each wake is recorded as one hidden row holding the line the model was sent', wakes.length === 2 && wakes.every(row => row.isMeta === true && j(wordsOf(row)) === j([ADVICE_LINE])), j(wakes.map(row => ({ meta: row.isMeta ?? false, words: wordsOf(row).map(text => text.slice(0, 100)) }))))
    tally.check('no user row of the record holds the rule: it is recorded where it is sent, at the head of a packet', !users.some(row => wordsOf(row).some(text => text.includes(BOARD_PACKET_RULE))), j(users.filter(row => wordsOf(row).some(text => text.includes(BOARD_PACKET_RULE))).map(row => wordsOf(row).map(text => text.slice(0, 100)))))
  } finally {
    record('board-wake-words-out.txt', raw)
    record('board-wake-words-requests.json', JSON.stringify(world.fixture.messageRequests().map(request => request.body)))
    board?.close()
    await host.stop(5_000)
    await closeWorld(world)
  }
}

clearTimeout(watchdog)
tally.finish()
