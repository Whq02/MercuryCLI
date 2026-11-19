#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { rowsBinding, shippedKeyForms } from '../lib/shippedKeyForms.ts'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'one-truth-home-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'one-truth-daemon-'))

const bootstrap = await import('../../src/bootstrap/state.ts')
bootstrap.setIsInteractive(false)
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { DaemonSessionConnector } = await import(
  '../../src/services/engine-connector/daemonConnector.ts'
)
const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages/factories.ts')
const { createAttachmentMessage } = await import('../../src/utils/attachments/orchestrator.ts')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const watchdog = setTimeout(() => {
  console.log('\nTIMEOUT — one-truth prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()


section('T1 — the pen is gone (class members, files, vocabulary)')
{
  const home = mkdtempSync(join(tmpdir(), 'one-truth-t1-'))
  const sid = randomUUID()
  const c = new DaemonSessionConnector({
    sessionId: sid,
    home,
    workspaceId: '/tmp',
    title: 't1',
    projectLabel: 'p',
  } as never)
  const cAny = c as unknown as Record<string, unknown>
  for (const door of [
    'queue',
    'subscribeQueue',
    'enqueue',
    'removeQueued',
    'clearQueue',
    'restageQueuedPrompt',
    'popAllEditable',
    'popNewestEditable',
  ]) {
    check(`connector exposes NO ${door}()`, typeof cAny[door] !== 'function')
  }
  for (const field of ['optimisticQueue', 'queueSnapshot']) {
    check(`connector carries NO ${field} state`, !(field in cAny))
  }
  const queueRows = rowsBinding(shippedKeyForms(), (action, chord) => /queueForNextTurn|steerNow|holdForNext/.test(`${chord} ${action}`))
  check('no queue keybindings', queueRows.length === 0, queueRows.slice(0, 3).join(' · '))
}

type SeatSendSeed = {
  clientMessageId: string
  text: string
  sentAtMs: number
  state: 'pending' | 'delivered'
  mode: 'prompt' | 'bash'
}

const { recordTranscript, flushSessionStorage } = await import('../../src/utils/sessionStorage.ts')
const { getTranscriptPathForSession } = await import('../../src/utils/sessionStorage/paths.ts')
const { getSessionId } = bootstrap
const { dirname } = await import('node:path')

const now = Date.now()
const nowIso = new Date(now).toISOString()
const oldIso = new Date(now - 60 * 60_000).toISOString()

section('T5 — the status sentence and the receipt vocabulary')
{
  const home = mkdtempSync(join(tmpdir(), 'one-truth-t5-'))
  const c = new DaemonSessionConnector({
    sessionId: randomUUID(),
    home,
    workspaceId: '/tmp',
    title: 't5',
    projectLabel: 'p',
  } as never)
  const status = c.status() as unknown as Record<string, unknown>
  check('SeatStatus carries no waitingWords', !('waitingWords' in status), JSON.stringify(Object.keys(status)))
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`ONE-TRUTH-DELIVERY: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`ONE-TRUTH-DELIVERY: all ${checks} checks passed`)
process.exit(0)
