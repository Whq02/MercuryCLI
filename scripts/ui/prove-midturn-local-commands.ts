#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { bootRunner, bound, childEnv, DIST, isOutcome, makeTally, transcriptFiles } from '../daemon/dupline-world.ts'
import { seedScratchHome, startScriptedFixture } from '../lib/scriptedTurn.ts'
import { mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'
import type { Message } from '../../src/types/message.ts'

const tally = makeTally('midturn-local-commands')
if (!existsSync(DIST)) throw new Error(`build first: ${DIST}`)
console.log(`build under proof: ${DIST}`)
const parent = process.env.MERCURY_CONFIG_DIR ?? tmpdir()
mkdirSync(parent, { recursive: true })
const scratch = mkdtempSync(join(parent, 'midturn-local-commands-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'reader')
process.env.MERCURY_TURN_RECEIPT = '1'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { readTranscriptChainSince } = await import('../../src/utils/sessionStorage/transcriptReader.ts')
const { normalizeMessages } = await import('../../src/utils/messages/normalize.ts')
const { injectTurnReceipts } = await import('../../src/utils/cockpit/turnReceipt.ts')
const React = await import('react')
const { Box } = await import('../../src/ink.ts')
const { AppStateProvider } = await import('../../src/state/AppState.tsx')
const { Message: MessageRow } = await import('../../src/components/Message.tsx')
const { buildMessageLookups } = await import('../../src/utils/messages/lookups.ts')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()

async function deadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('the scripted request never arrived')), bound(30_000)) })])
  } finally {
    clearTimeout(timer)
  }
}

let mounted: Awaited<ReturnType<typeof mountOffscreen>> | undefined
try {
  for (const bare of [false, true]) {
    tally.section(bare ? 'bare attachment drain' : 'ordinary attachment drain')
    const home = join(scratch, bare ? 'bare-home' : 'home')
    const cwd = join(scratch, bare ? 'bare-work' : 'work')
    seedScratchHome(home, cwd)
    const file = join(cwd, 'input.txt')
    writeFileSync(file, 'midturn fixture input\n')
    const first = 'MIDTURN_FIRST_PROMPT'
    const steering = 'MIDTURN_STEERING_PROMPT'
    const later = 'MIDTURN_LATER_PROMPT'
    const textOnly = 'MIDTURN_WITHOUT_TOOLS'
    const after = 'MIDTURN_AFTER_LOCAL'
    const slash = ['/swarmchat', '/swarmchat main', '/swarmchat all', '/midturn-unknown-command']
    const image = { type: 'image' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5r8AAAAASUVORK5CYII=' }
    const shell = "printf 'MIDTURN_SHELL_DONE\\n'"
    const ids = slash.map(() => randomUUID())
    const shellId = randomUUID()
    let requestArrived!: () => void
    let textArrived!: () => void
    const requested = new Promise<void>(resolve => { requestArrived = resolve })
    const textRequested = new Promise<void>(resolve => { textArrived = resolve })
    const fixture = await startScriptedFixture(req => {
      if (req.n === 1) {
        requestArrived()
        return [{ type: 'tool_use', name: 'Read', input: { file_path: file } }]
      }
      if (req.ask === textOnly) textArrived()
      return [{ type: 'text', text: req.ask === later ? 'MIDTURN_LATER_DONE' : req.ask === after ? 'MIDTURN_AFTER_DONE' : req.ask === textOnly ? 'MIDTURN_TEXT_DONE' : 'MIDTURN_FIRST_DONE' }]
    }, { answerDelayMs: req => req.n === 1 || req.ask === textOnly ? bound(2_500) : 0 })
    const env: NodeJS.ProcessEnv = { ...childEnv(home, Number(new URL(fixture.base).port)), MERCURY_BARE: bare ? '1' : '0' }
    delete env.MERCURY_HOME
    delete env.MERCURY_CRITTER
    const runner = bootRunner({ cwd, env, asks: 'allow' })
    try {
      await runner.prompt(first, randomUUID())
      await deadline(requested)
      await runner.prompt(slash[0]!, ids[0])
      await runner.request('queue/add', { type: 'prompt', content: [{ type: 'text', text: slash[1]! }], id: ids[1]! })
      await runner.request('queue/add', { type: 'prompt', content: [{ type: 'text', text: slash[2]! }, image], id: ids[2]! })
      await runner.prompt(slash[3]!, ids[3])
      await runner.request('queue/add', { type: 'shell', command: shell, id: shellId })
      await runner.prompt(steering, randomUUID())
      tally.check('all commands were typed while the first request was in flight', !runner.frames.some(isOutcome))
      await runner.waitFor('first turn outcome', isOutcome, bound(30_000))
      await runner.waitFor('bash command settled', f => isOutcome(f) && String(f.answer).includes('MIDTURN_SHELL_DONE'), bound(15_000))
      const firstOutcome = runner.frames.findIndex(isOutcome)
      const outputs = runner.frames.filter(f => f.type === 'command_output' && f.command !== shell)
      const forbidden = fixture.requests.flatMap(req => req.allTexts).filter(text => slash.some(command => text.includes(command)) || text.includes(shell))
      tally.check('no local command or bash line entered the running model request bodies', forbidden.length === 0, JSON.stringify(forbidden))
      tally.check('the prompt typed after the commands still steers the running turn', fixture.requests[1]?.allTexts.some(text => text.includes(steering)) === true)
      tally.check('the queued local commands made no model requests', fixture.requests.length === 2)
      const starts = ids.map(id => runner.frames.findIndex(f => f.type === 'turn' && Array.isArray(f.message_ids) && f.message_ids.length === 1 && f.message_ids[0] === id))
      const endings = starts.map(index => runner.frames.findIndex((f, at) => at > index && isOutcome(f) && f.turn === runner.frames[index]?.turn))
      tally.check('every local command ran as its own turn in typed order after the first receipt', starts.every((at, index) => at > (index === 0 ? firstOutcome : endings[index - 1]!)) && endings.every(at => at >= 0), JSON.stringify({ starts, endings }))
      tally.check('string, text-block and image-attached commands ran locally and the unknown name was refused locally', outputs.length === 3 && outputs.every((row, index) => row.turn === runner.frames[starts[index]!]?.turn) && endings.slice(0, 3).every(at => runner.frames[at]?.status === 'completed') && runner.frames[endings[3]!]!.status === 'refused', JSON.stringify(outputs))
      const shellTurn = runner.frames.findIndex(f => f.type === 'turn' && Array.isArray(f.message_ids) && f.message_ids[0] === shellId)
      tally.check('bash runs after the slash commands, not at the attachment boundary', endings.at(-1)! >= 0 && shellTurn > endings.at(-1)! && shellTurn > firstOutcome)
      await runner.prompt(later, randomUUID())
      await runner.waitFor('the next prompt settled', f => isOutcome(f) && f.answer === 'MIDTURN_LATER_DONE', bound(30_000))
      tally.check('later requests carry no local command framed as mid-turn operator input', fixture.requests.every(req => !req.allTexts.some(text => slash.some(command => text.includes(`The operator sent a new message while you were working:\n${command}`)))))
      const from = runner.frames.length
      await runner.prompt(textOnly, randomUUID())
      await deadline(textRequested)
      const localId = randomUUID(), promptId = randomUUID()
      await runner.prompt('/swarmchat all', localId)
      await runner.prompt(after, promptId)
      tally.check('the command and following prompt arrived before the text-only turn ended', !runner.frames.slice(from).some(isOutcome))
      await runner.waitFor('prompt after the local command settled', f => isOutcome(f) && f.answer === 'MIDTURN_AFTER_DONE', bound(30_000), from)
      const tail = runner.frames.slice(from)
      const localStart = tail.findIndex(f => f.type === 'turn' && Array.isArray(f.message_ids) && f.message_ids.length === 1 && f.message_ids[0] === localId)
      const promptStart = tail.findIndex(f => f.type === 'turn' && Array.isArray(f.message_ids) && f.message_ids.length === 1 && f.message_ids[0] === promptId)
      const localOutput = tail.findIndex(f => f.type === 'command_output' && f.turn === tail[localStart]?.turn)
      tally.check('a queued local command is not batched with the next prompt when no mid-turn drain runs', localStart > tail.findIndex(isOutcome) && localOutput > localStart && promptStart > localOutput && tail.slice(localOutput + 1, promptStart).some(isOutcome), JSON.stringify(tail.map(f => ({ type: f.type, command: f.command, ids: f.message_ids }))))
      const outcomes = runner.frames.filter(isOutcome)
      tally.check('only the unknown command was refused; no turn was interrupted or failed', outcomes.filter(f => f.status === 'refused').length === 1 && outcomes.every(f => f.status === 'completed' || (f.status === 'refused' && f.turn === runner.frames[starts[3]!]?.turn)), JSON.stringify(outcomes.map(f => ({ status: f.status, error: f.error }))))
    } finally {
      await runner.stop(bound(5_000))
      await fixture.close()
    }
    const session = runner.frames.find(f => typeof f.session_id === 'string')?.session_id
    const transcript = transcriptFiles(join(home, 'projects')).find(path => path.endsWith(`/${session}.jsonl`))
    tally.check('the built product wrote its transcript', transcript !== undefined)
    if (transcript !== undefined) {
      const read = await readTranscriptChainSince(transcript, null)
      const records = [...read.rows] as Message[]
      const normalized = normalizeMessages(records).filter(row => row.type !== 'progress')
      const rows = injectTurnReceipts(normalized, scratch)
      const text = (row: unknown): string => JSON.stringify(row)
      const answerAt = rows.findIndex(row => row.type === 'assistant' && text(row).includes('MIDTURN_FIRST_DONE'))
      const receiptAt = rows.findIndex((row, index) => index > answerAt && row.type === 'turn_receipt')
      const commandAt = rows.findIndex(row => row.type === 'user' && text(row).includes('<command-name>/swarmchat</command-name>'))
      const imageCommandAt = rows.findIndex(row => row.type === 'user' && text(row).includes('<command-name>/swarmchat</command-name>') && text(row).includes('<command-args>all</command-args>'))
      const promptAt = rows.findIndex(row => row.type === 'user' && text(row).includes(later))
      tally.check('the screen row order is reply → turn receipt → local commands including the image → next prompt', answerAt >= 0 && receiptAt > answerAt && commandAt > receiptAt && imageCommandAt > commandAt && promptAt > imageCommandAt, JSON.stringify({ answerAt, receiptAt, commandAt, imageCommandAt, promptAt }))
      const lookups = buildMessageLookups(normalized, records)
      const body = React.createElement(Box, { flexDirection: 'column' }, ...rows.slice(answerAt, promptAt + 1).map(message => React.createElement(MessageRow, {
        key: message.uuid, message, messages: normalized, tools: [], commands: [], verbose: false, addMargin: false, shouldAnimate: false, shouldShowDot: false, isTranscriptMode: false, isStatic: true, inProgressToolUseIDs: new Set<string>(), progressMessagesForMessage: [], lookups, width: 120,
      })))
      const element = React.createElement(AppStateProvider, { children: body })
      if (mounted) mounted.resize(element, 120, 44)
      else mounted = await mountOffscreen(element, 120, 44)
      await waitFor(() => mounted!.screen().includes('/swarmchat all') && mounted!.screen().includes(later), bound(5_000))
      const frame = mounted.screen()
      const reply = frame.indexOf('MIDTURN_FIRST_DONE'), receipt = frame.indexOf('1 read'), command = frame.indexOf('/swarmchat'), imageCommand = frame.indexOf('/swarmchat all'), next = frame.indexOf(later)
      tally.check('the rendered frame keeps the image-attached command below the receipt and above the next prompt', reply >= 0 && receipt > reply && command > receipt && imageCommand > command && next > imageCommand, frame)
    }
  }
} finally {
  mounted?.unmount()
  rmSync(scratch, { recursive: true, force: true })
}
tally.finish()
