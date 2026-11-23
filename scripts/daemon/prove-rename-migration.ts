#!/usr/bin/env bun
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
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${cond || hint === '' ? '' : ` — to fix: ${hint}`}`)
}

const proto = await import('../../src/daemon/control/protocol.ts')
const sock = await import('../../src/daemon/control/controlSocket.ts')
const server = await import('../../src/daemon/control/controlServer.ts')
const sup = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')


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
    check('B1 the proto-2 old spelling answers ok', oldSpelling.ok === true, JSON.stringify(oldSpelling), 'the control server in src/daemon/control/controlServer.ts must still answer a proto-2 concourseControl request')
    check('B2 the reply echoes the ASKER\'s spelling', oldSpelling.op === 'concourseControl', String(oldSpelling.op), 'the reply op in src/daemon/control/controlServer.ts must echo the spelling the asker sent (requestedOp)')
    const newSpelling = await rawRequest(path, { op: 'sessionControl', proto: 3, auth: 'k', action: 'focus', sessionId: 's-new', by: 't' })
    check('B3 the new spelling answers ok and echoes its own name', newSpelling.ok === true && newSpelling.op === 'sessionControl', JSON.stringify(newSpelling), 'the control server in src/daemon/control/controlServer.ts must answer sessionControl ok and echo that name')
    check('B4 ONE handler served both spellings', controlCalls.join(',') === 'focus:s-old,focus:s-new', controlCalls.join(','), 'both op spellings must reach the one concourseControl handler in answerSessionControl (src/daemon/control/controlServer.ts)')
    const relNew = await rawRequest(path, { op: 'sessionRelease', proto: 3, auth: 'k', runnerId: 'concourse-w9' })
    const relOld = await rawRequest(path, { op: 'concourseRelease', proto: 2, auth: 'k', workerId: 'concourse-w8' })
    check('B5 the release door reads runnerId AND the legacy workerId (R2 on the wire)', relNew.ok === true && relOld.ok === true && releaseIds.join(',') === 'concourse-w9,concourse-w8', releaseIds.join(','), 'the release door in src/daemon/control/controlServer.ts must read raw.runnerId and fall back to raw.workerId')
    const admit = await rawRequest(path, { op: 'concourseAdmit', proto: 2, auth: 'k', workspaceDir: '/ws' })
    check('B6 the admit reply carries the workerId MIRROR beside runnerId for proto≤2 readers', admit.ok === true && admit.runnerId === 'concourse-w1' && admit.workerId === 'concourse-w1', JSON.stringify(admit), 'the admit reply in src/daemon/control/controlServer.ts must carry workerId equal to runnerId')
    const effNew = await rawRequest(path, { op: 'sessionControl', proto: 3, auth: 'k', action: 'set-effort', sessionId: 's-eff', by: 't', effort: 'low' })
    const effOld = await rawRequest(path, { op: 'concourseControl', proto: 2, auth: 'k', action: 'set-effort', sessionId: 's-eff2', by: 't', effort: 'medium' })
    check('B7 set-effort routes WITH its field through both spellings onto the one handler', effNew.ok === true && effOld.ok === true && controlCalls.slice(-2).join(',') === 'set-effort:s-eff:low,set-effort:s-eff2:medium', controlCalls.join(','), 'answerSessionControl in src/daemon/control/controlServer.ts must pass the effort field through for both op spellings')
  } finally {
    await handle.close()
  }
}


console.log('C the client helper picks the spelling by negotiated proto (both arms)')
{
  const down2 = sock.sessionOpWireFrame({ op: 'sessionDispatch', proto: 2 })
  const keep3 = sock.sessionOpWireFrame({ op: 'sessionDispatch', proto: 3 })
  check('C1 at proto 2 the frame re-spells to the old dialect', down2.op === 'concourseDispatch', '', 'sessionOpWireFrame in src/daemon/control/controlSocket.ts must re-spell the op to the old name at proto 2')
  check('C2 at proto 3 the frame keeps the session spelling', keep3.op === 'sessionDispatch', '', 'sessionOpWireFrame in src/daemon/control/controlSocket.ts must keep the session spelling at proto 3')
  const rel2 = sock.sessionOpWireFrame({ op: 'sessionRelease', proto: 2, runnerId: 'w-1' } as never) as Record<string, unknown>
  const rel3 = sock.sessionOpWireFrame({ op: 'sessionRelease', proto: 3, runnerId: 'w-1' } as never) as Record<string, unknown>
  check('C3 the release field re-spells with the op (runnerId → workerId below proto 3)', rel2.op === 'concourseRelease' && rel2.workerId === 'w-1' && rel2.runnerId === undefined, '', 'sessionOpWireFrame in src/daemon/control/controlSocket.ts must re-spell the release op and move runnerId to workerId below proto 3')
  check('C4 at proto 3 the field stays runnerId', rel3.op === 'sessionRelease' && rel3.runnerId === 'w-1' && rel3.workerId === undefined, '', 'sessionOpWireFrame in src/daemon/control/controlSocket.ts must leave runnerId as it is at proto 3')
  const home = sock.normalizeSessionOpReply({ ok: true, op: 'concourseAdmit', runnerId: undefined, workerId: 'w-2', sessionId: 's', workspaceId: '/w' } as never) as Record<string, unknown>
  check('C5 an old daemon\'s reply folds home (op + the R2 field)', home.op === 'sessionAdmit' && home.runnerId === 'w-2', '', 'normalizeSessionOpReply in src/daemon/control/controlSocket.ts must fold an old reply to the sessionAdmit op and fill runnerId from workerId')

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
    const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/control/protocol.ts')
    check(
      'C6 the EPROTO retry re-spells at the LOWER proto (never the new name at an old router)',
      seen.length === 2 && seen[0]!.op === 'sessionControl' && seen[0]!.proto === MERCURY_DAEMON_PROTO && seen[1]!.op === 'concourseControl' && seen[1]!.proto === 2,
      JSON.stringify(seen),
      'daemonControlRpc in src/daemon/control/controlSocket.ts must retry once after an EPROTO reply, re-spelled with sessionOpWireFrame at the proto the server named',
    )
    check('C7 the retried reply folds home to the canonical spelling', first.ok === true && first.op === 'sessionControl', JSON.stringify(first), 'daemonControlRpc in src/daemon/control/controlSocket.ts must pass the retried reply through normalizeSessionOpReply')
    const second = (await sock.daemonControlRpc({ op: 'sessionControl', action: 'focus', sessionId: 's2', by: 't' } as never)) as Record<string, unknown>
    check(
      'C8 the REMEMBERED dialect speaks old on the first frame (both arms of the choice)',
      second.ok === true && seen.length === 3 && seen[2]!.op === 'concourseControl' && seen[2]!.proto === 2,
      JSON.stringify(seen),
      'daemonControlRpc in src/daemon/control/controlSocket.ts must remember the lower proto after an EPROTO reply and use it on the next first frame',
    )
  } finally {
    sock.forgetDaemonProtoForTesting()
    await new Promise<void>(res => scripted.close(() => res()))
  }
}

console.log('D the record fold: legacy workerId loads forever, writes land runnerId-only')
{
  const legacyRow = { schema: 1, workerId: 'concourse-w1', sessionId: 's-legacy', workspaceId: '/ws', isolation: 'exclusive', modelKey: 'm', spawnedAt: 1, lastLiveAt: 1 }
  writeFileSync(join(DIR_D, 'concourse-workers.json'), JSON.stringify({ version: 1, workers: { 'concourse-w1': legacyRow } }))
  const loaded = sup.readSessionWorkers(DIR_D)['concourse-w1'] as unknown as Record<string, unknown>
  check('D1 the old-spelling record loads with runnerId folded on', loaded !== undefined && loaded.runnerId === 'concourse-w1', JSON.stringify(loaded), 'readSessionWorkers in src/daemon/concourse-workers/store.ts must set runnerId from a legacy workerId')
  check('D2 the fold drops the legacy key from what callers see', loaded !== undefined && !('workerId' in loaded), '', 'readSessionWorkers in src/daemon/concourse-workers/store.ts must delete the legacy workerId key from the record it returns')
  sup.updateConcourseWorkers(ws => {
    if (ws['concourse-w1']) ws['concourse-w1'].title = 'retitled'
  }, DIR_D)
  const rawAfter = readFileSync(join(DIR_D, 'concourse-workers.json'), 'utf8')
  check('D3 the NEXT write rewrites the record under the new spelling alone (poison: a record written with the old field)', rawAfter.includes('"runnerId"') && !rawAfter.includes('"workerId"'), rawAfter.slice(0, 200), 'updateConcourseWorkers in src/daemon/concourse-workers/store.ts must write records with runnerId only')
  const reread = sup.readSessionWorkers(DIR_D)['concourse-w1']
  check('D4 the rewritten record reads back whole', reread?.runnerId === 'concourse-w1' && reread?.title === 'retitled' && reread?.sessionId === 's-legacy', '', 'readSessionWorkers and updateConcourseWorkers in src/daemon/concourse-workers/store.ts must keep runnerId, title and sessionId through the rewrite')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL RENAME-MIGRATION PROOFS PASS')
else console.log(`❌ ${failures} RENAME-MIGRATION PROOF(S) FAILED`)
console.log('═'.repeat(76))
try {
  rmSync(SCRATCH, { recursive: true, force: true })
} catch {
}
process.exit(failures === 0 ? 0 : 1)
