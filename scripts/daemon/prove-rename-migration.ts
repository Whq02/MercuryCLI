#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-rename-migration.ts — the two parked wire/schema
//  renames, landed as two-phase migrations behind the daemon-version
// handshake (the recipe is the handshake receipt's
//  "THE MIGRATION LANES' DOOR").
//
//   A  THE ALIAS TABLE (structural): exactly the five concourse-era
//      spellings fold onto the five session-family handlers — one handler
//      each, no old case labels survive. POISON: a sixth alias row (a NEW
//      verb given an alias) breaks the exact-set equality.
//   B  THE REAL ROUTER (behavioral): a proto-2 client's old spelling still
//      answers, the same deps handler serves both spellings, the reply
//      echoes the ASKER's dialect, the release door reads runnerId AND the
//      legacy workerId, and the admit reply carries the workerId mirror
//      beside runnerId for proto≤2 readers. The NEW set-effort action
//      (rides the same proto-3 bump, NO alias) routes with its field
//      through BOTH op spellings onto the one handler.
//   C  THE ONE CLIENT CHOICE: sessionOpWireFrame re-spells per stamped
//      proto (op + the release field, both arms), normalizeSessionOpReply
//      folds an old reply home — and on the wire, daemonControlRpc's EPROTO
//      dialect retry RE-DERIVES the spelling at the lower proto, so an old
//      daemon is never sent a name its router lacks.
//   D  THE RECORD FOLD: an old-spelling record file loads forever
//      (workerId → runnerId at the one reader) and the NEXT write rewrites
//      it under the new spelling alone. POISON: a record written with the
//      old field turns the raw-file assertion red.
//  Hermetic: scratch config home + daemon dirs; the only server is this
//  process's own control server on a scratch socket — no daemon, no child.
//  Run:  ~/.bun/bin/bun run scripts/daemon/prove-rename-migration.ts
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = mkdtempSync(join(tmpdir(), 'rename-mig-'))
const DIR_B = join(SCRATCH, 'daemon-b')
const DIR_C = join(SCRATCH, 'daemon-c')
const DIR_D = join(SCRATCH, 'daemon-d')
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_DAEMON_DIR = DIR_B
delete process.env.MERCURY_HOME
for (const d of [process.env.MERCURY_CONFIG_DIR, DIR_B, DIR_C, DIR_D]) mkdirSync(d!, { recursive: true })

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(process.cwd(), rel), 'utf8')

const proto = await import('../../src/daemon/protocol.ts')
const sock = await import('../../src/daemon/controlSocket.ts')
const server = await import('../../src/daemon/controlServer.ts')
const sup = await import('../../src/daemon/concourseSupervisor.ts')

// ── A: the alias table, structurally ────────────────────────────────────────
console.log('A the alias table routes both spellings to one handler')
{
  const src = read('src/daemon/controlServer.ts')
  const aliases = new Map(
    Array.from(/const SESSION_OP_ALIASES[^]*?\}/.exec(src)?.[0].matchAll(/([A-Za-z]+):\s*'([A-Za-z-]+)'/g) ?? [], m => [m[1]!, m[2]!]),
  )
  const expected: Array<[string, string]> = [
    ['concourseAdmit', 'sessionAdmit'],
    ['concourseDispatch', 'sessionDispatch'],
    ['concourseList', 'sessionList'],
    ['concourseRelease', 'sessionRelease'],
    ['concourseControl', 'sessionControl'],
  ]
  check(
    'A1 the table is EXACTLY the five renamed spellings (poison: a new verb with an alias)',
    aliases.size === 5 && expected.every(([old, nu]) => aliases.get(old) === nu),
    JSON.stringify([...aliases]),
  )
  for (const [old, nu] of expected) {
    const one = src.split(`case '${nu}':`).length === 2 && !src.includes(`case '${old}':`)
    check(`A2 ${old} folds onto the ONE '${nu}' handler (no second door)`, one)
  }
  check('A3 concourseWithdraw and concourseWarm keep their own cases, un-aliased', src.includes("case 'concourseWithdraw':") && src.includes("case 'concourseWarm':") && !aliases.has('concourseWithdraw') && !aliases.has('concourseWarm'))
  const stamped = Array.from(/const AUTH_STAMPED_OPS[^]*?\]\)/.exec(read('src/daemon/controlSocket.ts'))?.[0].matchAll(/'([A-Za-z-]+)'/g) ?? [], m => m[1]!)
  check('A4 both spelling families stay auth-stamped (an untyped straggler never bounces EAUTH)', expected.every(([old, nu]) => stamped.includes(old) && stamped.includes(nu)))
}

// ── raw one-frame client (the transport contract, by hand) ──────────────────
function rawRequest(path: string, frame: unknown, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    const c = net.connect(path)
    const chunks: Buffer[] = []
    const t = setTimeout(() => {
      c.destroy()
      resolve({ __timeout: true })
    }, timeoutMs)
    c.on('connect', () => c.write(`${JSON.stringify(frame)}\n`))
    c.on('data', b => {
      chunks.push(b)
      const joined = Buffer.concat(chunks)
      const nl = joined.indexOf(10)
      if (nl < 0) return
      clearTimeout(t)
      c.destroy()
      try {
        resolve(JSON.parse(joined.subarray(0, nl).toString('utf8')) as Record<string, unknown>)
      } catch {
        resolve({ __bad: true })
      }
    })
    c.on('error', () => {
      clearTimeout(t)
      resolve({ __err: true })
    })
  })
}

// ── B: the real router serves both dialects through one handler ─────────────
console.log('B a proto-2 client\'s old spelling still answers (the real control server)')
{
  const controlCalls: string[] = []
  const releaseIds: string[] = []
  const deps = {
    roster: {} as never,
    breaker: { shouldSuppressFire: () => false } as never,
    dir: DIR_B,
    startedAt: Date.now(),
    maxInflight: 1,
    controlKey: 'k',
    isReady: () => true,
    onShutdown: () => ({ reaped: 0, workers: [] }),
    concourseControl: (req: { action: string; sessionId: string; effort?: string }) => {
      controlCalls.push(`${req.action}:${req.sessionId}${req.effort !== undefined ? `:${req.effort}` : ''}`)
      return { outcome: 'applied' as const }
    },
    concourseRelease: (runnerId: string) => {
      releaseIds.push(runnerId)
      return { settled: true, killed: false }
    },
    concourseAdmit: async () => ({ ok: true as const, runnerId: 'concourse-w1', sessionId: 's-1', workspaceId: '/ws' }),
  }
  const handle = await server.startControlServer(deps as unknown as Parameters<typeof server.startControlServer>[0])
  const path = sock.controlSockPath()
  try {
    const oldSpelling = await rawRequest(path, { op: 'concourseControl', proto: 2, auth: 'k', action: 'focus', sessionId: 's-old', by: 't' })
    check('B1 the proto-2 old spelling answers ok', oldSpelling.ok === true, JSON.stringify(oldSpelling))
    check('B2 the reply echoes the ASKER\'s spelling', oldSpelling.op === 'concourseControl', String(oldSpelling.op))
    const newSpelling = await rawRequest(path, { op: 'sessionControl', proto: 3, auth: 'k', action: 'focus', sessionId: 's-new', by: 't' })
    check('B3 the new spelling answers ok and echoes its own name', newSpelling.ok === true && newSpelling.op === 'sessionControl', JSON.stringify(newSpelling))
    check('B4 ONE handler served both spellings', controlCalls.join(',') === 'focus:s-old,focus:s-new', controlCalls.join(','))
    const relNew = await rawRequest(path, { op: 'sessionRelease', proto: 3, auth: 'k', runnerId: 'concourse-w9' })
    const relOld = await rawRequest(path, { op: 'concourseRelease', proto: 2, auth: 'k', workerId: 'concourse-w8' })
    check('B5 the release door reads runnerId AND the legacy workerId (R2 on the wire)', relNew.ok === true && relOld.ok === true && releaseIds.join(',') === 'concourse-w9,concourse-w8', releaseIds.join(','))
    const admit = await rawRequest(path, { op: 'concourseAdmit', proto: 2, auth: 'k', workspaceDir: '/ws' })
    check('B6 the admit reply carries the workerId MIRROR beside runnerId for proto≤2 readers', admit.ok === true && admit.runnerId === 'concourse-w1' && admit.workerId === 'concourse-w1', JSON.stringify(admit))
    // The NEW verb of the same release: set-effort rides the proto-3 bump,
    // routes with its field, and reaches the ONE handler through BOTH op
    // spellings (a proto-2 client that never sends it is untouched — B1).
    const effNew = await rawRequest(path, { op: 'sessionControl', proto: 3, auth: 'k', action: 'set-effort', sessionId: 's-eff', by: 't', effort: 'low' })
    const effOld = await rawRequest(path, { op: 'concourseControl', proto: 2, auth: 'k', action: 'set-effort', sessionId: 's-eff2', by: 't', effort: 'medium' })
    check('B7 set-effort routes WITH its field through both spellings onto the one handler', effNew.ok === true && effOld.ok === true && controlCalls.slice(-2).join(',') === 'set-effort:s-eff:low,set-effort:s-eff2:medium', controlCalls.join(','))
  } finally {
    await handle.close()
  }
}

// ── E: set-effort's arms at their owners (source pins) ──────────────────────
console.log('E set-effort mirrors set-model at every owner (poison: an effort write without the field)')
{
  const protocolSrc = read('src/daemon/protocol.ts')
  const serverSrc = read('src/daemon/controlServer.ts')
  const mainSrc = read('src/daemon/main.ts')
  const seatSrc = read('src/daemon/sessionSeat.ts')
  check('E1 the action rides the proto-3 union, typed off the CHILD union (one source of truth, no second enum)', protocolSrc.includes("| 'set-effort'") && protocolSrc.includes("effort?: SDKControlSetEffortRequest['effort']"))
  check('E2 the router forwards the effort field (bounded), and the requires-string names the action', serverSrc.includes("raw.action === 'set-effort'") && serverSrc.includes('raw.effort.slice(0, 32)') && serverSrc.includes('park-all|set-effort'))
  check('E3 an effort write WITHOUT the field refuses at the one handler (the poison inverted)', mainSrc.includes("detail: 'set-effort requires effort'") && mainSrc.includes('setSessionEffort(sessionId, effort, roster)'))
  // The ONE effort owner grew from a membership test to the normalizer
  // Plain spellings fold to ladder words and junk
  // refuses typed — the pin re-anchors on the normalizer call, the child
  // set_effort control spelling unchanged.
  check('E4 the seat verb validates the value against the ONE effort owner and speaks the child set_effort control', seatSrc.includes('normalizeEffortLevelString(effort)') && seatSrc.includes("request: { subtype: 'set_effort', effort }"))
  check('E5 the busy arm parks on the record and the idle edge applies it (the set-model grammar, mirrored)', seatSrc.includes('w.pendingEffort = effort') && seatSrc.includes('if (rec.pendingEffort !== undefined) applyEffortNow(rec, rec.pendingEffort, roster, dir)'))
  check('E6 the spec follows without a bounce (patchSeatEffort beside patchSeatModel)', seatSrc.includes('patchSeatEffort(short: string, effort: string): boolean') && read('src/daemon/roster.ts').includes('patchSeatEffort(short: string, effort: string): boolean'))
}

// ── C: the ONE client choice — spelling per negotiated proto, both arms ─────
console.log('C the client helper picks the spelling by negotiated proto (both arms)')
{
  const down2 = sock.sessionOpWireFrame({ op: 'sessionDispatch', proto: 2 })
  const keep3 = sock.sessionOpWireFrame({ op: 'sessionDispatch', proto: 3 })
  check('C1 at proto 2 the frame re-spells to the old dialect', down2.op === 'concourseDispatch')
  check('C2 at proto 3 the frame keeps the session spelling', keep3.op === 'sessionDispatch')
  const rel2 = sock.sessionOpWireFrame({ op: 'sessionRelease', proto: 2, runnerId: 'w-1' } as never) as Record<string, unknown>
  const rel3 = sock.sessionOpWireFrame({ op: 'sessionRelease', proto: 3, runnerId: 'w-1' } as never) as Record<string, unknown>
  check('C3 the release field re-spells with the op (runnerId → workerId below proto 3)', rel2.op === 'concourseRelease' && rel2.workerId === 'w-1' && rel2.runnerId === undefined)
  check('C4 at proto 3 the field stays runnerId', rel3.op === 'sessionRelease' && rel3.runnerId === 'w-1' && rel3.workerId === undefined)
  const home = sock.normalizeSessionOpReply({ ok: true, op: 'concourseAdmit', runnerId: undefined, workerId: 'w-2', sessionId: 's', workspaceId: '/w' } as never) as Record<string, unknown>
  check('C5 an old daemon\'s reply folds home (op + the R2 field)', home.op === 'sessionAdmit' && home.runnerId === 'w-2')

  // The wire: a scripted old daemon answers EPROTO naming proto 2 — the
  // dialect retry must RE-DERIVE the spelling, never resend the new name.
  process.env.MERCURY_DAEMON_DIR = DIR_C
  writeFileSync(join(DIR_C, 'control.key'), 'k2')
  const seen: Array<{ op: string; proto: number }> = []
  const scripted = net.createServer(c => {
    const chunks: Buffer[] = []
    c.on('data', b => {
      chunks.push(b)
      const joined = Buffer.concat(chunks)
      const nl = joined.indexOf(10)
      if (nl < 0) return
      const req = JSON.parse(joined.subarray(0, nl).toString('utf8')) as { op: string; proto: number }
      seen.push({ op: req.op, proto: req.proto })
      if (req.proto > 2) {
        c.end(`${JSON.stringify({ ok: false, code: 'EPROTO', error: 'proto mismatch (server=2)', serverProto: 2, serverVersion: '0.0.0-fixture' })}\n`)
      } else if (req.op === 'concourseControl') {
        c.end(`${JSON.stringify({ ok: true, op: 'concourseControl', outcome: 'applied' })}\n`)
      } else {
        c.end(`${JSON.stringify({ ok: false, code: 'EUNKNOWN', error: `unknown op: ${req.op}` })}\n`)
      }
    })
  })
  await new Promise<void>(res => scripted.listen(sock.controlSockPath(), res))
  try {
    sock.forgetDaemonProtoForTesting()
    const first = (await sock.daemonControlRpc({ op: 'sessionControl', action: 'focus', sessionId: 's', by: 't' } as never)) as Record<string, unknown>
    // The first frame speaks the CURRENT proto (the registered constant —
    // re-anchored off the literal when the daemon-wire bump moved 3 to 4;
    // a literal here rots on every lawful bump).
    const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
    check(
      'C6 the EPROTO retry re-spells at the LOWER proto (never the new name at an old router)',
      seen.length === 2 && seen[0]!.op === 'sessionControl' && seen[0]!.proto === MERCURY_DAEMON_PROTO && seen[1]!.op === 'concourseControl' && seen[1]!.proto === 2,
      JSON.stringify(seen),
    )
    check('C7 the retried reply folds home to the canonical spelling', first.ok === true && first.op === 'sessionControl', JSON.stringify(first))
    const second = (await sock.daemonControlRpc({ op: 'sessionControl', action: 'focus', sessionId: 's2', by: 't' } as never)) as Record<string, unknown>
    check(
      'C8 the REMEMBERED dialect speaks old on the first frame (both arms of the choice)',
      second.ok === true && seen.length === 3 && seen[2]!.op === 'concourseControl' && seen[2]!.proto === 2,
      JSON.stringify(seen),
    )
  } finally {
    sock.forgetDaemonProtoForTesting()
    await new Promise<void>(res => scripted.close(() => res()))
  }
}

// ── D: an old-spelling record file loads; the next write rewrites clean ─────
console.log('D the record fold: legacy workerId loads forever, writes land runnerId-only')
{
  const legacyRow = { schema: 1, workerId: 'concourse-w1', sessionId: 's-legacy', workspaceId: '/ws', isolation: 'exclusive', modelKey: 'm', spawnedAt: 1, lastLiveAt: 1 }
  writeFileSync(join(DIR_D, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { 'concourse-w1': legacyRow } }))
  const loaded = sup.readSessionWorkers(DIR_D)['concourse-w1'] as unknown as Record<string, unknown>
  check('D1 the old-spelling record loads with runnerId folded on', loaded !== undefined && loaded.runnerId === 'concourse-w1', JSON.stringify(loaded))
  check('D2 the fold drops the legacy key from what callers see', loaded !== undefined && !('workerId' in loaded))
  sup.updateConcourseWorkers(ws => {
    if (ws['concourse-w1']) ws['concourse-w1'].title = 'retitled'
  }, DIR_D)
  const rawAfter = readFileSync(join(DIR_D, 'concourse-workers.json'), 'utf8')
  check('D3 the NEXT write rewrites the record under the new spelling alone (poison: a record written with the old field)', rawAfter.includes('"runnerId"') && !rawAfter.includes('"workerId"'), rawAfter.slice(0, 200))
  const reread = sup.readSessionWorkers(DIR_D)['concourse-w1']
  check('D4 the rewritten record reads back whole', reread?.runnerId === 'concourse-w1' && reread?.title === 'retitled' && reread?.sessionId === 's-legacy')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL RENAME-MIGRATION PROOFS PASS')
else console.log(`❌ ${failures} RENAME-MIGRATION PROOF(S) FAILED`)
console.log('═'.repeat(76))
try {
  rmSync(SCRATCH, { recursive: true, force: true })
} catch {
  /* scratch reaping is best-effort */
}
process.exit(failures === 0 ? 0 : 1)
