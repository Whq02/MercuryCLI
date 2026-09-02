#!/usr/bin/env bun
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
