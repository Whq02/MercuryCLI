#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../../src/engine/message-shapes/message.js'
import type { SessionFactsV1 } from '../../src/engine/connector/seatProjections.js'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'unknown-one-notice-home-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
delete process.env.CI

const { setIsInteractive } = await import('../../src/boot/process-state/processState.ts')
setIsInteractive(false)
const { enableConfigs } = await import('../../src/platform/config/globalConfig.ts')
enableConfigs()
const { DaemonSessionConnector } = await import('../../src/engine/connector/daemonConnector.ts')
const { createUserMessage } = await import('../../src/engine/message-shapes/factories.ts')
const { createSystemMessage } = await import('../../src/engine/message-shapes/systemMessages.ts')
const { processSlashCommand, resolveUnknownSlashName, unknownCommandLine } = await import('../../src/engine/user-input/processSlashCommand.tsx')
const { expandPastedTextRefs } = await import('../../src/sessions/promptHistory.ts')
const { requestConversationPlan } = await import('../../src/engine/messages/apiPlan.ts')

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
let sectionFixHint = ''
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  const shown = !ok ? [sectionFixHint, detail.slice(0, 400)].filter(Boolean).join(' | ') : ''
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}
const SECTION_FIX_HINTS: Record<string, string> = {
  '§1': 'fix the unknown-command branch of processSlashCommand and unknownCommandLine in src/engine/user-input/processSlashCommand.tsx (one warning notice, nothing the model reads), or requestConversationPlan in src/engine/messages/apiPlan.ts for the last check',
  '§3': 'fix resolveUnknownSlashName in src/engine/user-input/processSlashCommand.tsx or expandPastedTextRefs in src/sessions/promptHistory.ts',
}
const section = (title: string): void => {
  sectionFixHint = SECTION_FIX_HINTS[title.slice(0, 2)] ?? ''
  console.log(`\n${title}`)
}

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
