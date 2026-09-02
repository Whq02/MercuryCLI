#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

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
  const bindings = readFileSync(join(REPO, 'src/keybindings/defaultBindings.ts'), 'utf8')
  check('no queue keybindings', !bindings.includes('queueForNextTurn') && !bindings.includes('steerNow') && !bindings.includes('holdForNext'))
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

async function rigConnector(rows: Record<string, unknown>[], sends: SeatSendSeed[]): Promise<{
  c: InstanceType<typeof DaemonSessionConnector>
  paintedTexts: () => string[]
  sendIds: () => string[]
  echoCount: () => number
}> {
  await recordTranscript(rows as never)
  await flushSessionStorage()
  const sid = getSessionId()
  const home = dirname(getTranscriptPathForSession(sid))
  const c = new DaemonSessionConnector({
    sessionId: sid,
    home,
    workspaceId: '/tmp',
    title: 'rig',
    projectLabel: 'p',
  } as never)
  const g = c as unknown as { sends: SeatSendSeed[]; echoRows: Map<string, unknown>; tick: () => Promise<void>; reconcileSends: () => boolean; paint: () => void; attached: boolean }
  g.sends = sends
  for (const s of sends) {
    g.echoRows.set(s.clientMessageId, createUserMessage({ content: s.text }) as never)
  }
  g.attached = true
  await g.tick.call(c)
  g.attached = false
  return {
    c,
    paintedTexts: () =>
      (c.records() as Array<{ type?: string; message?: { content?: unknown } }>).map(m => JSON.stringify(m)),
    sendIds: () => (c as unknown as { sends: SeatSendSeed[] }).sends.map(s => s.clientMessageId),
    echoCount: () => (c as unknown as { echoRows: Map<string, unknown> }).echoRows.size,
  }
}

const now = Date.now()
const nowIso = new Date(now).toISOString()
const oldIso = new Date(now - 60 * 60_000).toISOString()

section('T2 — identity retirement: user-row uuid AND queued_command source_uuid')
{
  const idUser = randomUUID()
  const idDrained = randomUUID()
  const rig = await rigConnector(
    [
      { ...(createUserMessage({ content: 'ran immediately' }) as unknown as Record<string, unknown>), uuid: idUser, timestamp: nowIso },
      {
        ...(createAttachmentMessage({
          type: 'queued_command',
          prompt: 'folded in mid-turn',
          source_uuid: idDrained,
          commandMode: 'prompt',
        } as never) as unknown as Record<string, unknown>),
        timestamp: nowIso,
      },
      { ...(createAssistantMessage({ content: 'carrying on' }) as unknown as Record<string, unknown>), timestamp: nowIso },
    ],
    [
      { clientMessageId: idUser, text: 'ran immediately', sentAtMs: now - 5000, state: 'delivered', mode: 'prompt' },
      { clientMessageId: idDrained, text: 'folded in mid-turn', sentAtMs: now - 5000, state: 'delivered', mode: 'prompt' },
    ],
  )
  check('the user-row identity retired its echo', !rig.sendIds().includes(idUser), JSON.stringify(rig.sendIds()))
  check(
    'the queued_command source_uuid retired its echo (the double-paint kill: the old substring scan never matched this shape)',
    !rig.sendIds().includes(idDrained),
    JSON.stringify(rig.sendIds()),
  )
  check('no echo rows remain', rig.echoCount() === 0, String(rig.echoCount()))
  const texts = rig.paintedTexts().join('\n')
  check('each message paints exactly once', (texts.match(/folded in mid-turn/g) ?? []).length === 1)
}

section('T3 — a non-UUID identity never retires against OLD history')
{
  const oblId = 'obl-answer:some-question'
  const rig = await rigConnector(
    [
      { ...(createUserMessage({ content: 'yes, and the old yes stands' }) as unknown as Record<string, unknown>), timestamp: oldIso },
    ],
    [{ clientMessageId: oblId, text: 'yes', sentAtMs: now - 2000, state: 'delivered', mode: 'prompt' }],
  )
  check('the live send survives (the old row predates it)', rig.sendIds().includes(oblId), JSON.stringify(rig.sendIds()))
  check('its echo row still paints', rig.echoCount() === 1)
}

section('T4 — reconciliation never fabricates (no steered inference)')
{
  const id = randomUUID()
  const rig = await rigConnector(
    [{ ...(createUserMessage({ content: 'somebody else' }) as unknown as Record<string, unknown>), timestamp: nowIso }],
    [{ clientMessageId: id, text: 'still in flight', sentAtMs: now - 1000, state: 'delivered', mode: 'prompt' }],
  )
  const g = rig.c as unknown as { reconcileSends: () => boolean; echoRows: Map<string, unknown>; sends: unknown[] }
  const echoBefore = g.echoRows.size
  const sendsBefore = g.sends.length
  for (let i = 0; i < 3; i++) g.reconcileSends.call(rig.c)
  check('echoRows never grows across reconciliations', g.echoRows.size <= echoBefore, `${echoBefore} -> ${g.echoRows.size}`)
  check('sends never grow across reconciliations', g.sends.length <= sendsBefore)
}

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
