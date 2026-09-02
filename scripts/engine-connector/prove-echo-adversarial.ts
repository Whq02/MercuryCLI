#!/usr/bin/env bun
// ============================================================================
//  scripts/engine-connector/prove-echo-adversarial.ts — ADVERSARIAL echo
//  interleavings on the one-truth connector (delivery-verifier lane).
//
//  prove-one-truth-delivery pins T1-T5 (pen absence, identity retirement,
//  no old-history theft, no fabrication, vocabulary). These legs attack
//  the shapes between those pins:
//
//    B1  SAME-TEXT TWIN SENDS — two in-flight non-UUID sends carrying
//        IDENTICAL text (two obligation answers "yes"): ONE landing row
//        must retire at most ONE of them. The text fallback's scan used to
//        let one row retire BOTH — the still-unlanded twin's echo vanished
//        early (the under-paint mirror of the double-paint class).
//    B2  IDENTITY BEATS TEXT — a landing user row whose uuid IS the
//        clientMessageId retires the echo even when its text DIFFERS
//        (a held-replay's enriched landing): identity is the law.
//    B3  LEGACY-TRANSCRIPT REPLAY — an old-world transcript carrying
//        queued_command attachment rows (source_uuid present AND absent)
//        with NO matching send paints each exactly once, fabricates no
//        echo, grows no send state — entering a session paints no phantom.
//    B4  THE STRANDED ANCHOR — a display row anchored beyond a SHRUNK
//        record array (the compaction shape) still paints exactly once,
//        at the tail, without a crash.
//    B5  THE TIME BOUNDARY — the non-UUID text fallback retires against a
//        row stamped AT the send instant (not older), and never against
//        one stamped over a second earlier.
//
//  Run: ~/.bun/bin/bun run scripts/engine-connector/prove-echo-adversarial.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'echo-adv-home-'))
process.env.MERCURY_DAEMON_DIR = mkdtempSync(join(tmpdir(), 'echo-adv-daemon-'))

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
  console.log('\nTIMEOUT — echo-adversarial prover exceeded 60s')
  process.exit(1)
}, 60_000)
watchdog.unref?.()

// ── the transcript fixture rig (prove-one-truth-delivery's sibling) ─────────
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

type Rigged = {
  c: InstanceType<typeof DaemonSessionConnector>
  sendIds: () => string[]
  echoCount: () => number
  paintedJson: () => string
}

async function rigConnector(rows: Record<string, unknown>[], sends: SeatSendSeed[]): Promise<Rigged> {
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
  const g = c as unknown as { sends: SeatSendSeed[]; echoRows: Map<string, unknown>; tick: () => Promise<void>; attached: boolean }
  g.sends = sends
  for (const s of sends) {
    g.echoRows.set(s.clientMessageId, createUserMessage({ content: s.text }) as never)
  }
  g.attached = true
  await g.tick.call(c)
  g.attached = false
  return {
    c,
    sendIds: () => (c as unknown as { sends: SeatSendSeed[] }).sends.map(s => s.clientMessageId),
    echoCount: () => (c as unknown as { echoRows: Map<string, unknown> }).echoRows.size,
    paintedJson: () => JSON.stringify(c.records()),
  }
}

const now = Date.now()
const nowIso = new Date(now).toISOString()

// ── B1 — same-text twin sends: one landing retires at most one ──────────────
section('B1 — same-text twins: one landing row retires at most ONE send')
{
  const rig = await rigConnector(
    [{ ...(createUserMessage({ content: 'twin answer yes' }) as unknown as Record<string, unknown>), timestamp: nowIso }],
    [
      { clientMessageId: 'obl-answer:twin-q1', text: 'twin answer yes', sentAtMs: now - 2000, state: 'delivered', mode: 'prompt' },
      { clientMessageId: 'obl-answer:twin-q2', text: 'twin answer yes', sentAtMs: now - 1500, state: 'delivered', mode: 'prompt' },
    ],
  )
  const left = rig.sendIds()
  check(
    'exactly ONE twin retired — a single landing row never retires two sends (the still-in-flight twin keeps its echo)',
    left.length === 1,
    `sends left=${JSON.stringify(left)}`,
  )
  check('the surviving twin still paints its echo', rig.echoCount() === 1, String(rig.echoCount()))
  check('the sent words still paint for the survivor', (rig.paintedJson().match(/twin answer yes/g) ?? []).length >= 2)
}

// ── B2 — identity beats text ────────────────────────────────────────────────
section('B2 — a landing row with the SAME identity and DIFFERENT text retires the echo')
{
  const id = randomUUID()
  const rig = await rigConnector(
    [
      {
        ...(createUserMessage({ content: 'the enriched landing (images rode along)' }) as unknown as Record<string, unknown>),
        uuid: id,
        timestamp: nowIso,
      },
    ],
    [{ clientMessageId: id, text: 'the plain words as typed', sentAtMs: now - 3000, state: 'delivered', mode: 'prompt' }],
  )
  check('the identity retired the echo despite the text difference', !rig.sendIds().includes(id), JSON.stringify(rig.sendIds()))
  check('no echo rows remain', rig.echoCount() === 0, String(rig.echoCount()))
}

// ── B3 — legacy-transcript replay paints no phantom ─────────────────────────
section('B3 — an old-world transcript (queued_command rows) replays without a phantom')
{
  const legacyWithUuid = createAttachmentMessage({
    type: 'queued_command',
    prompt: 'old world steered words',
    source_uuid: randomUUID(),
    commandMode: 'prompt',
  } as never) as unknown as Record<string, unknown>
  const legacyBare = createAttachmentMessage({
    type: 'queued_command',
    prompt: 'old world bare fold-in',
    commandMode: 'prompt',
  } as never) as unknown as Record<string, unknown>
  const rig = await rigConnector(
    [
      { ...legacyWithUuid, timestamp: nowIso },
      { ...legacyBare, timestamp: nowIso },
      { ...(createAssistantMessage({ content: 'the old reply that followed' }) as unknown as Record<string, unknown>), timestamp: nowIso },
    ],
    [],
  )
  const painted = rig.paintedJson()
  check('the sourced legacy row paints exactly once', (painted.match(/old world steered words/g) ?? []).length === 1, String((painted.match(/old world steered words/g) ?? []).length))
  check('the bare legacy row paints exactly once', (painted.match(/old world bare fold-in/g) ?? []).length === 1)
  check('no send state fabricated from the replay', rig.sendIds().length === 0, JSON.stringify(rig.sendIds()))
  check('no echo rows fabricated from the replay', rig.echoCount() === 0, String(rig.echoCount()))
  const live = rig.c.live() as unknown as Record<string, unknown>
  check('the live projection claims nothing in flight for a settled legacy transcript', live.inFlight !== true, JSON.stringify(live))
}

// ── B4 — the stranded anchor ────────────────────────────────────────────────
section('B4 — a display row anchored beyond a shrunk record array paints once, at the tail')
{
  const rig = await rigConnector(
    [{ ...(createUserMessage({ content: 'anchor base row' }) as unknown as Record<string, unknown>), timestamp: nowIso }],
    [],
  )
  const g = rig.c as unknown as {
    rawRecords: unknown[]
    displayRows: Array<{ row: unknown; anchor: number }>
    paint: () => void
  }
  // The compaction shape: the anchor was minted against a longer array.
  g.displayRows = [{ row: createUserMessage({ content: 'the stranded notice' }) as never, anchor: g.rawRecords.length + 10 }]
  g.paint.call(rig.c)
  const painted = rig.paintedJson()
  check('the stranded notice still paints', painted.includes('the stranded notice'))
  check('…exactly once', (painted.match(/the stranded notice/g) ?? []).length === 1)
  const rows = rig.c.records() as Array<Record<string, unknown>>
  check('…at the tail (never spliced into a position that no longer exists)', JSON.stringify(rows[rows.length - 1]).includes('the stranded notice'))
}

// ── B5 — the time boundary of the text fallback ─────────────────────────────
section('B5 — the text fallback honors the not-older-than boundary exactly')
{
  const atInstant = new Date(now - 2000).toISOString()
  const rigA = await rigConnector(
    [{ ...(createUserMessage({ content: 'boundary words at the instant' }) as unknown as Record<string, unknown>), timestamp: atInstant }],
    [{ clientMessageId: 'obl-answer:boundary-at', text: 'boundary words at the instant', sentAtMs: now - 2000, state: 'delivered', mode: 'prompt' }],
  )
  check('a row stamped AT the send instant retires (not older)', !rigA.sendIds().includes('obl-answer:boundary-at'), JSON.stringify(rigA.sendIds()))
  const oldStamp = new Date(now - 10_000).toISOString()
  const rigB = await rigConnector(
    [{ ...(createUserMessage({ content: 'boundary words from the past' }) as unknown as Record<string, unknown>), timestamp: oldStamp }],
    [{ clientMessageId: 'obl-answer:boundary-old', text: 'boundary words from the past', sentAtMs: now - 2000, state: 'delivered', mode: 'prompt' }],
  )
  check('a row stamped seconds BEFORE the send never retires it', rigB.sendIds().includes('obl-answer:boundary-old'), JSON.stringify(rigB.sendIds()))
}

console.log('\n' + '='.repeat(76))
if (failures > 0) {
  console.log(`ECHO-ADVERSARIAL: ${failures} of ${checks} checks FAILED`)
  process.exit(1)
}
console.log(`ECHO-ADVERSARIAL: all ${checks} checks passed`)
process.exit(0)
