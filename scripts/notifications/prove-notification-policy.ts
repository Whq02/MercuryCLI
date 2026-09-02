#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-notification-policy.ts — (§7's
//  alert half): the policy layer ABOVE the notifier.
//
//  §1  per-user policy defaults (started host-OFF/opt-in; needs-you ON;
//      settled configurable) — the notifier's own law untouched.
//  §2  obligation-backed dedup: ONE host emission per revision (the
//      obligation row's own per-destination state); a revision bump
//      re-emits exactly once.
//  §3  non-obligation dedup: the durable bounded store is monotonic and
//      an ACKNOWLEDGED revision never re-emits — replayed after a
//      simulated restart (fresh reads over the same durable file).
//  §4  host denial/failure never touches in-app attention: the
//      attention projection input (open rows) is identical either way.
//  §5  the privacy floor: detail reaches the host ONLY with
//      detailedPreview on; the generic title is what ships otherwise.
//  §6  sibling settlements COALESCE into one emission.
//  §7  the durable dedup store stays bounded (compaction in-line).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker, scratchRoot } from '../engine-durability/harness.ts'

const t = checker()
const root = scratchRoot('notification-policy')
process.env.MERCURY_CREW_DIR = join(root, 'crew')

// Config reads are boot-gated — the policy layer's per-user settings ride
// getGlobalConfig, so the proof enables config access the way boot does
// (the scratch root already re-homed every config path to scratch).
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()

const policy = await import('../../src/services/notificationPolicy.js')
const obl = await import('../../src/services/crew/obligations.js')

const sent: Array<{ message: string; title: string; notificationType: string }> = []
const send = async (args: { message: string; title: string; notificationType: string }): Promise<string> => {
  sent.push(args)
  return 'terminal_bell'
}

t.section('§1 — per-user policy defaults (the §7 table)')
{
  t.check("started is host-OPT-IN (default off; in-app is not this layer's job)", policy.hostSignalEnabled('started') === false, 'off')
  t.check('needs-you host emission defaults ON', policy.hostSignalEnabled('needs-you') === true, 'on')
  t.check('ready-to-review defaults ON', policy.hostSignalEnabled('ready-to-review') === true, 'on')
  t.check('settled (completed/failed) defaults ON', policy.hostSignalEnabled('completed') === true && policy.hostSignalEnabled('failed') === true, 'on')
  t.check('detailed preview defaults OFF (privacy floor)', policy.detailedPreviewEnabled() === false, 'off')
}

t.section('§2 — obligation-backed dedup: one emission per revision')
{
  sent.length = 0
  const row = await obl.upsertObligation({ ref: 'np-q1', sessionId: 'sess-np', question: 'emit me once?', owner: 'op', scope: 'switchboard' })
  const sig = {
    kind: 'needs-you' as const,
    targetId: row.obligationId,
    revision: row.revision,
    title: 'a session needs you',
    detail: 'emit me once?',
    obligationBacked: true,
  }
  const first = await policy.emitConcourseSignal(sig, { send })
  const second = await policy.emitConcourseSignal(sig, { send })
  t.check('the first evaluation EMITS', first.emitted === true, JSON.stringify(first))
  t.check('the second evaluation is a duplicate-revision no-op', second.emitted === false && second.reason === 'duplicate-revision', JSON.stringify(second))
  t.check('exactly one host emission', sent.length === 1, String(sent.length))
  const bumped = await obl.upsertObligation({ ref: 'np-q1', sessionId: 'sess-np', question: 'emit me once? (clarified)', owner: 'op', scope: 'switchboard' })
  const third = await policy.emitConcourseSignal({ ...sig, revision: bumped.revision, detail: 'clarified' }, { send })
  t.check('a REVISION BUMP re-emits exactly once (edge-triggered)', third.emitted === true && bumped.revision === row.revision + 1 && sent.length === 2, JSON.stringify(third))
  await obl.resolveObligation(row.obligationId, { kind: 'resolved' })
}

t.section('§3 — non-obligation dedup: durable, monotonic, ack survives restart')
{
  sent.length = 0
  const dir = mkdtempSync(join(tmpdir(), 'np-dedup-'))
  const sig = { kind: 'ready-to-review' as const, targetId: 'sess-r1', revision: 3, title: 'ready to review' }
  const a = await policy.emitConcourseSignal(sig, { send, dir })
  const b = await policy.emitConcourseSignal(sig, { send, dir })
  t.check('first emits, replay refuses', a.emitted === true && b.emitted === false && sent.length === 1, JSON.stringify({ a, b }))
  const acked = await policy.acknowledgeSignal(sig, 'host', { dir })
  t.check('acknowledgement records', acked === true, String(acked))
  // Simulated reconnect replay: same durable file, same revision — and even
  // an OLDER revision — never re-emit an acknowledged state.
  const replay = await policy.emitConcourseSignal(sig, { send, dir })
  const older = await policy.emitConcourseSignal({ ...sig, revision: 2 }, { send, dir })
  t.check('reconnect replay never re-emits the acknowledged revision', replay.emitted === false && older.emitted === false && sent.length === 1, JSON.stringify({ replay, older }))
  const newer = await policy.emitConcourseSignal({ ...sig, revision: 4 }, { send, dir })
  t.check('a genuinely NEWER revision emits again', newer.emitted === true && sent.length === 2, JSON.stringify(newer))
}

t.section('§4 — host denial/failure never hides in-app attention')
{
  const row = await obl.upsertObligation({ ref: 'np-q2', sessionId: 'sess-np', question: 'still visible?', owner: 'op', scope: 'switchboard' })
  const failingSend = async (): Promise<string> => {
    throw new Error('host said no')
  }
  const out = await policy.emitConcourseSignal(
    { kind: 'needs-you', targetId: row.obligationId, revision: 99, title: 'x', obligationBacked: true },
    { send: failingSend },
  )
  t.check('the host emission failed honestly', out.emitted === false && out.reason === 'emit-failed', JSON.stringify(out))
  const stillOpen = await obl.openObligations({ sessionId: 'sess-np', scope: 'switchboard' })
  t.check(
    'the durable row (the in-app attention input) is untouched by host denial',
    stillOpen.some(o => o.obligationId === row.obligationId && o.status === 'open'),
    `${stillOpen.length} open`,
  )
  await obl.resolveObligation(row.obligationId, { kind: 'resolved' })
}

t.section('§5 — the privacy floor (no private content without detailedPreview)')
{
  sent.length = 0
  const sig = { kind: 'ready-to-review' as const, targetId: 'sess-priv', revision: 1, title: 'a session is ready to review', detail: 'SECRET prompt content' }
  const dir = mkdtempSync(join(tmpdir(), 'np-priv-'))
  await policy.emitConcourseSignal(sig, { send, dir })
  t.check(
    'without detailedPreview the host copy is the GENERIC title (no detail leak)',
    sent.length === 1 && sent[0]!.message === 'a session is ready to review' && !sent[0]!.message.includes('SECRET'),
    JSON.stringify(sent[0]),
  )
}

t.section('§6 — sibling settlements coalesce into one emission')
{
  sent.length = 0
  policy._resetNotificationPolicyForTesting()
  const dir = mkdtempSync(join(tmpdir(), 'np-coal-'))
  const mk = (id: string) => ({ kind: 'completed' as const, targetId: id, revision: 1, title: `${id} settled` })
  const outs = await Promise.all([
    policy.emitConcourseSignal(mk('s1'), { send, dir, coalesceMs: 60 }),
    policy.emitConcourseSignal(mk('s2'), { send, dir, coalesceMs: 60 }),
    policy.emitConcourseSignal(mk('s3'), { send, dir, coalesceMs: 60 }),
  ])
  t.check('each settlement is accepted into the window (coalesced)', outs.every(o => o.emitted === false && o.reason === 'coalesced'), JSON.stringify(outs))
  for (const deadline = Date.now() + 2000; sent.length < 1 && Date.now() < deadline; ) {
    await new Promise(r => setTimeout(r, 25))
  }
  await new Promise(r => setTimeout(r, 100))
  t.check('ONE host emission for the burst, naming the count', sent.length === 1 && /3 sessions settled/.test(sent[0]!.message), JSON.stringify(sent))
  policy._resetNotificationPolicyForTesting()
}

t.section('§7 — the durable dedup store stays bounded')
{
  const dir = mkdtempSync(join(tmpdir(), 'np-bound-'))
  for (let i = 0; i < 520; i++) {
    await policy.claimEmission('ready-to-review', `sess-${i}`, 'host', 1, { dir })
  }
  const raw = JSON.parse(await Bun.file(join(dir, 'notification-dedup.json')).text()) as { rows?: Record<string, unknown> }
  const count = Object.keys(raw.rows ?? {}).length
  t.check('rows stay ≤ the 500 bound (in-line compaction)', count <= 500, String(count))
}

t.section('§journal — the cross-process pair emits EXACTLY ONCE')
{
  const sig = {
    kind: 'completed' as const,
    targetId: 'jw-1',
    revision: 7,
    title: 'session settled',
    detail: 'worker jw-1 released',
    deepLink: { sessionId: 'sess-j1' },
    obligationBacked: false,
  }
  const first = await policy.journalConcourseSignal(sig)
  t.check('the daemon-side decision journals once', first.journaled === true, JSON.stringify(first))
  const dup = await policy.journalConcourseSignal(sig)
  t.check('a double decision dedupes JOURNAL-side (duplicate-revision)', dup.journaled === false && dup.reason === 'duplicate-revision', JSON.stringify(dup))
  const unseen = await policy.readUnseenJournalSignals()
  t.check('exactly ONE unseen row awaits replay', unseen.length === 1 && unseen[0]!.signal.targetId === 'jw-1', String(unseen.length))

  sent.length = 0
  const replayed = await policy.emitConcourseSignal(unseen[0]!.signal, { send, coalesceMs: 1 })
  for (const deadline = Date.now() + 2000; sent.length < 1 && Date.now() < deadline; ) {
    await new Promise(r => setTimeout(r, 25))
  }
  await new Promise(r => setTimeout(r, 100))
  t.check('the visible replay reaches the host (its OWN destination claim)', sent.length === 1, String(sent.length))
  const again = await policy.emitConcourseSignal(unseen[0]!.signal, { send, coalesceMs: 1 })
  await new Promise(r => setTimeout(r, 150))
  t.check('a re-replay (crash between replay and cursor) refuses duplicate-revision — never a second toast', again.emitted === false && again.reason === 'duplicate-revision' && sent.length === 1, JSON.stringify(again))
  void replayed

  await policy.markJournalConsumed(unseen[0]!.seq)
  t.check('the cursor advance empties the unseen set', (await policy.readUnseenJournalSignals()).length === 0)

  const off = await policy.journalConcourseSignal({ ...sig, kind: 'started' as const, revision: 8 })
  t.check("a policy-OFF kind journals NOTHING (started is host opt-in by default)", off.journaled === false && off.reason === 'policy-off', JSON.stringify(off))
}

t.section('§activation — the deep-link round-trip points the rail')
{
  const act = await import('../../src/services/concourse/pendingActivation.ts')
  act._resetPendingActivationForTesting()
  const sig = {
    kind: 'needs-you' as const,
    targetId: 'obl-act-1',
    revision: 3,
    title: 'a session needs you',
    detail: 'which migration first?',
    deepLink: { sessionId: 'sess-act', obligationId: 'obl-act-1' },
    obligationBacked: false,
  }
  await policy.journalConcourseSignal(sig)
  const rows = await policy.readUnseenJournalSignals()
  sent.length = 0
  const outcome = await policy.emitConcourseSignal(rows[rows.length - 1]!.signal, { send, coalesceMs: 1 })
  if (outcome.emitted) act.notePendingActivation(rows[rows.length - 1]!.signal.deepLink)
  t.check('the emitted toast points the activation memory at the EXACT target', JSON.stringify(act.readPendingActivation()) === JSON.stringify({ sessionId: 'sess-act', obligationId: 'obl-act-1' }), JSON.stringify(act.readPendingActivation()))
  const before = act.readPendingActivation()
  const deduped = await policy.emitConcourseSignal(rows[rows.length - 1]!.signal, { send, coalesceMs: 1 })
  if (deduped.emitted) act.notePendingActivation(rows[rows.length - 1]!.signal.deepLink)
  t.check('a DEDUPED emission never re-points (emitted:true is the only writer)', act.readPendingActivation() === before)
  act.clearPendingActivation()
  t.check('consume-on-use clears the pointer', act.readPendingActivation() === null)
  // The rail preseed is the pointer's ONE consumer (structural — the render
  // half is the component initializer; the B1 arena pins the rail render).
  const screenSrc = (await import('node:fs')).readFileSync('src/components/concourse/ConcourseScreen.tsx', 'utf8')
  t.check('the rail preseeds its selection from the pointer (consume-on-use)', screenSrc.includes('readPendingActivation()') && screenSrc.includes('clearPendingActivation()'))
}

t.finish('prove-notification-policy')
