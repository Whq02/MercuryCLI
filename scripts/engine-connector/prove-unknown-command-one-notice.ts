#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../../src/types/message.js'
import type { SessionFactsV1 } from '../../src/services/engine-connector/seatProjections.js'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'unknown-one-notice-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.CI

const { setIsInteractive } = await import('../../src/bootstrap/state.ts')
setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
const { createUserMessage } = await import('../../src/utils/messages/factories.ts')
const { createSystemMessage } = await import('../../src/utils/messages/systemMessages.ts')
const { processSlashCommand, resolveUnknownSlashName, unknownCommandLine } = await import('../../src/utils/processUserInput/processSlashCommand.tsx')
const { expandPastedTextRefs } = await import('../../src/history.ts')
const { requestConversationPlan } = await import('../../src/utils/messages/apiPlan.ts')

type Send = { clientMessageId: string; text: string; sentAtMs: number; state: 'queued' | 'taken' | 'delivered'; mode: 'prompt' }
type Guts = {
  sends: Send[]
  echoRows: Map<string, Message>
  rawRecords: Message[]
  reconcileQueuedSends(facts: SessionFactsV1): void
  reconcileSends(): boolean
  paint(): void
}

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)

const PARAGRAPH = 'some long text here\nsecond line of the paste\nthird line of the paste'
const roster = [
  { name: 'model', type: 'local', description: 'pick', aliases: [], isEnabled: true, isHidden: false, async call() {}, userFacingName: () => 'model' },
  { name: 'compact', type: 'local', description: 'fold', aliases: [], isEnabled: true, isHidden: false, async call() {}, userFacingName: () => 'compact' },
] as never[]

section('§1 the runner\'s unknown branch: one notice carrying the frame identity, nothing the model reads')
{
  const uuid = randomUUID() as import('node:crypto').UUID
  const context = { options: { commands: roster, isNonInteractiveSession: true }, abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: { mode: 'default' } }) } as never
  const result = await processSlashCommand(`/nosuch ${PARAGRAPH}`, [], [], [], context, () => {}, uuid)
  const line = unknownCommandLine('nosuch', roster)
  check('the turn is refused and does not query the model', result.shouldQuery === false && result.commandRefused === true)
  check('the result text is the unknown-command sentence', result.resultText === line, String(result.resultText))
  check('exactly ONE row comes back', result.messages.length === 1, `${result.messages.length} rows: ${result.messages.map(m => m.type).join(',')}`)
  const only = result.messages[0] as { type?: string; subtype?: string; level?: string; content?: unknown; uuid?: string } | undefined
  check('the row is a warning notice, never a user row', only?.type === 'system' && only.subtype === 'informational' && only.level === 'warning', JSON.stringify(only).slice(0, 200))
  check('the notice reads the unknown-command sentence', only?.content === line, String(only?.content))
  check('the notice carries the frame uuid (the delivery law\'s one identity)', only?.uuid === uuid, `${String(only?.uuid)} vs ${uuid}`)
  const serialized = JSON.stringify(result.messages)
  check('POISON: no row echoes the operator\'s words', !serialized.includes('some long text here') && !serialized.includes('second line of the paste'))
  check('POISON: no "was not found; its arguments were" second notice', !serialized.includes('was not found') && !serialized.includes('its arguments were'))
  const planned = requestConversationPlan([...result.messages, createUserMessage({ content: 'the next prompt' })] as Message[])
  const wire = JSON.stringify(planned.messages)
  check('the model\'s next request carries the next prompt alone — not the refusal, not the paragraph', wire.includes('the next prompt') && !wire.includes('Unknown command') && !wire.includes('local-command-caveat') && !wire.includes('some long text here'), wire.slice(0, 300))
}

section('§2 the seat retires the send\'s echo on the notice row that carries its identity')
{
  const now = Date.now()
  const stamp = (offset: number): string => new Date(now + offset).toISOString()
  const rig = () => {
    const connector = new DaemonSessionConnector({ sessionId: randomUUID(), runnerId: 'runner', title: 'check', projectLabel: 'check', workspaceId: 'check', home: tmpdir() })
    const guts = connector as unknown as Guts
    const id = randomUUID()
    const text = `/nosuch ${PARAGRAPH}`
    guts.sends = [{ clientMessageId: id, text, sentAtMs: now, state: 'delivered', mode: 'prompt' }]
    guts.echoRows.set(id, { ...createUserMessage({ content: text }), uuid: id, timestamp: stamp(0) } as Message)
    guts.reconcileQueuedSends({ runnerGeneration: 1, atMs: now + 1, queueReady: true, queue: [] } as unknown as SessionFactsV1)
    guts.paint()
    const land = (rows: Message[]): void => {
      guts.rawRecords = rows
      guts.reconcileSends()
      guts.paint()
    }
    return { connector, guts, id, text, land }
  }
  const line = unknownCommandLine('nosuch', roster)
  {
    const r = rig()
    check('before any record lands the echo row paints (the send is in flight)', r.guts.sends.length === 1 && r.connector.records().some(row => JSON.stringify(row).includes('nosuch some long text')))
    r.land([{ ...createSystemMessage(line, 'warning'), uuid: r.id, timestamp: stamp(500) } as Message])
    check('RED on the base: the notice carrying the identity retires the send', r.guts.sends.length === 0 && r.guts.echoRows.size === 0, `${r.guts.sends.length} sends, ${r.guts.echoRows.size} echoes`)
    const painted = r.connector.records()
    check('the screen shows the one notice and no echo of the words', painted.length === 1 && painted[0]?.type === 'system' && !JSON.stringify(painted).includes('nosuch some long text'), `${painted.length} rows`)
  }
  {
    const r = rig()
    r.land([{ ...createSystemMessage(line, 'warning'), uuid: randomUUID(), timestamp: stamp(500) } as Message])
    check('a notice under another identity retires nothing', r.guts.sends.length === 1 && r.guts.echoRows.size === 1)
  }
  {
    const r = rig()
    r.land([{ ...createUserMessage({ content: r.text }), uuid: r.id, timestamp: stamp(500) } as Message])
    check('a user row carrying the identity still retires the send (unchanged)', r.guts.sends.length === 0 && r.guts.echoRows.size === 0)
  }
}

section('§3 the screen\'s honesty reads the words the session reads: a pasted chip resolves like a typed line')
{
  const pastes = { 1: { id: 1, type: 'text', content: `/nosuch ${PARAGRAPH}`, contentHash: 'h1' } } as never
  const chip = '[Pasted text #1 +3 lines]'
  check('the chip alone is not a slash line', !chip.startsWith('/'))
  const words = expandPastedTextRefs(chip, pastes).trim()
  check('expanded, the chip is the slash line the session would read', words.startsWith('/nosuch '), words.slice(0, 40))
  check('the resolver names the unknown command from the expanded words (the screen\'s read after the fix)', resolveUnknownSlashName(words, roster) === 'nosuch', String(resolveUnknownSlashName(words, roster)))
  check('a pasted KNOWN command never resolves as unknown', resolveUnknownSlashName(expandPastedTextRefs('[Pasted text #2 +1 lines]', { 2: { id: 2, type: 'text', content: '/compact\nnow', contentHash: 'h2' } } as never), roster) === undefined)
  check('a pasted // escape never resolves (words to the session)', resolveUnknownSlashName(expandPastedTextRefs('[Pasted text #3 +1 lines]', { 3: { id: 3, type: 'text', content: '//nosuch\nliteral', contentHash: 'h3' } } as never), roster) === undefined)
  check('a pasted paragraph with no slash never resolves', resolveUnknownSlashName(expandPastedTextRefs('[Pasted text #4 +1 lines]', { 4: { id: 4, type: 'text', content: 'plain words\nmore words', contentHash: 'h4' } } as never), roster) === undefined)
}

console.log(`\nprove-unknown-command-one-notice: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
