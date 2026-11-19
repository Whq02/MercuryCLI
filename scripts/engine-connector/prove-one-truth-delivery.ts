#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

const REPO = join(import.meta.dir, '..', '..')

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
  for (const dead of [
    'src/components/PromptInput/PromptInputQueuedCommands.tsx',
    'src/components/PromptInput/QueuedSteeringHint.tsx',
    'src/context/QueuedMessageContext.tsx',
    'src/hooks/useCommandQueue.ts',
    'src/utils/handlePromptSubmit.ts',
    'src/utils/QueryGuard.ts',
    'src/hooks/useQueueProcessor.ts',
    'src/utils/queueProcessor.ts',
  ]) {
    check(`${dead} does not exist`, !existsSync(join(REPO, dead)))
  }
  const placeholder = readFileSync(join(REPO, 'src/components/PromptInput/usePromptInputPlaceholder.ts'), 'utf8')
  check('placeholder carries no steer/queue sentence', !placeholder.includes('steers this turn') && !placeholder.includes('queued messages back'))
  const tagBar = readFileSync(join(REPO, 'src/components/SwitchboardTagBar.tsx'), 'utf8')
  check('tag bar carries no waiting-words copy', !tagBar.includes('waiting for') && !tagBar.includes('land after this reply'))
  const queueRows = rowsBinding(shippedKeyForms(), (action, chord) => /queueForNextTurn|steerNow|holdForNext/.test(`${chord} ${action}`))
  check('no queue keybindings', queueRows.length === 0, queueRows.slice(0, 3).join(' · '))
  const connectorSrc = readFileSync(join(REPO, 'src/services/engine-connector/daemonConnector.ts'), 'utf8')
  check(
    'connector source: no steered/queued send state, no optimisticQueue (call-shaped)',
    !connectorSrc.includes('.steered') && !connectorSrc.includes('steered:') && !connectorSrc.includes('optimisticQueue'),
  )
  const spinner = readFileSync(join(REPO, 'src/components/Spinner.tsx'), 'utf8')
  check('spinner: no steer receipt', !spinner.includes('steered') && !spinner.includes('steerReceipt'))
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
  const typesSrc = readFileSync(join(REPO, 'src/services/engine-connector/types.ts'), 'utf8')
  check("SendReceiptV1 has no 'queued' state", !/SendReceiptV1 =[\s\S]{0,200}state: 'queued'/.test(typesSrc))
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`ONE-TRUTH-DELIVERY: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`ONE-TRUTH-DELIVERY: all ${checks} checks passed`)
process.exit(0)
