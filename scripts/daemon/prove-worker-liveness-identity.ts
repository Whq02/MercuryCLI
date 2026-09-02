#!/usr/bin/env bun
// ============================================================================
//  prove-worker-liveness-identity — session-runner liveness is identity,
//  not a bare pid (release-hardening audit rank 46).
//
//  The gap: every liveness read in the session estate was a bare
//  isProcessAlive(rec.pid); the record carried pid and lastLiveAt but no
//  start token. A background session whose runner died while its recorded
//  pid was later reused by an unrelated process was pinned
//  running-but-dead: the boot reconcile refreshed lastLiveAt and listed it
//  live instead of settling it (never the "crashed — enter to resume"
//  row), enter answered already-live onto nothing, stop was refused with
//  no-kill-channel, and a record attached when its terminal died refused
//  re-attach for a terminal that no longer existed. The tree had already
//  solved this identity for the supervisor record and pidLock holders;
//  the session estate was not given it.
//
//   L1 the stamp: markConcourseWorkerRespawn writes the runner's start
//      token beside the pid (the one ownerWatch vocabulary)
//   L2 the read: a record whose pid is ALIVE but whose stamped token does
//      not match the live process reads DEAD (the reused-pid verdict) —
//      driven through pendingParkRequests, an exported reader on the one
//      liveness owner
//   L3 controls: the true token reads ALIVE; a pre-token record (no
//      procStart) keeps the old pid-alone verdict; a dead pid reads dead
//   L4 structural: the admission/revive/reactivate stamps ride pidFieldsOf
//      and the reads ride workerPidAlive (no bare rec-pid liveness left)
//
//  PROVE_SRC names another checkout's src (the A/B control: L1, L2 and L4
//  read red there).
// ============================================================================
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const supervisor = await import(join(SRC, 'daemon/concourseSupervisor.ts'))
const ownerWatch = await import(join(SRC, 'daemon/ownerWatch.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const dir = mkdtempSync(join(tmpdir(), 'worker-identity-'))
const stranger = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 30_000)'], { stdout: 'ignore', stderr: 'ignore' })
const strangerToken = await ownerWatch.getProcessStartTokenAsync(stranger.pid)
// Warm the cached reader the liveness owner consults.
ownerWatch.getProcessStartTokenCachedOrRefresh(stranger.pid)
await new Promise(resolve => setTimeout(resolve, 400))

const baseRecord = (runnerId: string, extra: Record<string, unknown>): Record<string, unknown> => ({
  runnerId,
  sessionId: `${runnerId}-session`,
  workspaceId: '/scratch/ws',
  modelKey: 'test-model',
  spawnedAt: Date.now(),
  lastLiveAt: Date.now(),
  parkRequestedAt: Date.now(),
  ...extra,
})

try {
  // ── L1: the respawn stamp ────────────────────────────────────────────────
  console.log('L1 the respawn stamp carries the token')
  {
    supervisor.updateConcourseWorkers((workers: Record<string, unknown>) => {
      workers['runner-stamp'] = baseRecord('runner-stamp', {})
    }, dir)
    supervisor.markConcourseWorkerRespawn('runner-stamp', stranger.pid, dir)
    const rec = supervisor.readSessionWorkers(dir)['runner-stamp'] as { pid?: number; procStart?: string }
    t('the respawn stamps the pid', rec?.pid === stranger.pid)
    t('…and the start token beside it (the one ownerWatch vocabulary)', typeof rec?.procStart === 'string' && rec.procStart.length > 0 && (strangerToken === null || rec.procStart === strangerToken), `procStart=${JSON.stringify(rec?.procStart)} live=${JSON.stringify(strangerToken)}`)
  }

  // ── L2: the reused-pid verdict ───────────────────────────────────────────
  console.log('L2 a live pid with a mismatched token reads DEAD')
  {
    supervisor.updateConcourseWorkers((workers: Record<string, unknown>) => {
      workers['runner-reused'] = baseRecord('runner-reused', { pid: stranger.pid, procStart: 'FORGED Mon Jan 1 00:00:00 1990' })
    }, dir)
    const pending = supervisor.pendingParkRequests(dir) as string[]
    if (strangerToken === null) {
      t('the reused-pid verdict (token unreadable on this box — conservative alive accepted)', true)
    } else {
      t('the reused-pid record is NOT counted live', !pending.includes('runner-reused'), `pending=${JSON.stringify(pending)}`)
    }
  }

  // ── L3: controls ─────────────────────────────────────────────────────────
  console.log('L3 controls')
  {
    supervisor.updateConcourseWorkers((workers: Record<string, unknown>) => {
      workers['runner-true'] = baseRecord('runner-true', { pid: stranger.pid, ...(strangerToken ? { procStart: strangerToken } : {}) })
      workers['runner-pretoken'] = baseRecord('runner-pretoken', { pid: stranger.pid })
      workers['runner-dead'] = baseRecord('runner-dead', { pid: 3_999_999 })
    }, dir)
    const pending = supervisor.pendingParkRequests(dir) as string[]
    t('the true identity reads ALIVE', pending.includes('runner-true'), JSON.stringify(pending))
    t('a pre-token record keeps the pid-alone verdict (alive)', pending.includes('runner-pretoken'))
    t('a dead pid reads dead', !pending.includes('runner-dead'))
  }

  // ── L4: structural ───────────────────────────────────────────────────────
  console.log('L4 structural — one liveness owner, stamped writers')
  {
    const src = readFileSync(join(SRC, 'daemon/concourseSupervisor.ts'), 'utf8')
    t('the liveness owner exists', src.includes('function workerPidAlive('))
    const stamps = (src.match(/pidFieldsOf\(/g) ?? []).length
    t('the record writers ride pidFieldsOf (admission, revive, reactivate, respawn)', stamps >= 5, `${stamps} sites`)
    const bare = (src.match(/\w+\.pid !== undefined && isProcessAlive\(\w+\.pid\)/g) ?? []).length
    t('no bare record-pid liveness read remains', bare === 0, `${bare} left`)
  }
} finally {
  stranger.kill()
}

console.log(failures === 0 ? 'WORKER LIVENESS IDENTITY: ALL PASS' : 'WORKER LIVENESS IDENTITY: RED')
process.exit(failures)
