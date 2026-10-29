#!/usr/bin/env bun

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const workers = await import(join(SRC, 'daemon/concourseWorkers.ts'))
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
const tokenDeadline = Date.now() + 5_000
while (ownerWatch.getProcessStartTokenCachedOrRefresh(stranger.pid) === null && Date.now() < tokenDeadline) {
  await new Promise(resolve => setTimeout(resolve, 25))
}

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
    workers.updateConcourseWorkers((workers: Record<string, unknown>) => {
      workers['runner-stamp'] = baseRecord('runner-stamp', {})
    }, dir)
    workers.markConcourseWorkerRespawn('runner-stamp', stranger.pid, dir)
    const rec = workers.readSessionWorkers(dir)['runner-stamp'] as { pid?: number; procStart?: string }
    t('the respawn stamps the pid', rec?.pid === stranger.pid)
    t('…and the start token beside it (the one ownerWatch vocabulary)', typeof rec?.procStart === 'string' && rec.procStart.length > 0 && (strangerToken === null || rec.procStart === strangerToken), `procStart=${JSON.stringify(rec?.procStart)} live=${JSON.stringify(strangerToken)}`)
  }

  console.log('L2 a live pid with a mismatched token reads DEAD')
  {
    workers.updateConcourseWorkers((workers: Record<string, unknown>) => {
      workers['runner-reused'] = baseRecord('runner-reused', { pid: stranger.pid, procStart: 'FORGED Mon Jan 1 00:00:00 1990' })
    }, dir)
    const pending = workers.pendingParkRequests(dir) as string[]
    if (strangerToken === null) {
      t('the reused-pid verdict (token unreadable on this box — conservative alive accepted)', true)
    } else {
      t('the reused-pid record is NOT counted live', !pending.includes('runner-reused'), `pending=${JSON.stringify(pending)}`)
    }
  }

  console.log('L3 controls')
  {
    workers.updateConcourseWorkers((workers: Record<string, unknown>) => {
      workers['runner-true'] = baseRecord('runner-true', { pid: stranger.pid, ...(strangerToken ? { procStart: strangerToken } : {}) })
      workers['runner-pretoken'] = baseRecord('runner-pretoken', { pid: stranger.pid })
      workers['runner-dead'] = baseRecord('runner-dead', { pid: 3_999_999 })
    }, dir)
    const pending = workers.pendingParkRequests(dir) as string[]
    t('the true identity reads ALIVE', pending.includes('runner-true'), JSON.stringify(pending))
    t('a pre-token record keeps the pid-alone verdict (alive)', pending.includes('runner-pretoken'))
    t('a dead pid reads dead', !pending.includes('runner-dead'))
  }

  console.log('L3b an older build stamped the token in the user\'s locale; this build reads it under LC_ALL=C — the two forms of one start are one identity, never a stranger')
  {
    const form = /^(\w{3}) (\w{3}) +(\d{1,2}) (\d\d:\d\d:\d\d) (\d{4})$/.exec(strangerToken ?? '')
    const enGB = form === null ? null : `${form[1]} ${form[3]} ${form[2]} ${form[4]} ${form[5]}`
    const deDE = form === null ? null : `${form[1].slice(0, 2)}. ${form[3]} ${form[2] === 'Oct' ? 'Okt' : form[2] === 'Mar' ? 'Mär' : form[2] === 'May' ? 'Mai' : form[2] === 'Dec' ? 'Dez' : form[2]}. ${form[4]} ${form[5]}`
    const psUnder = (locale: string): string => Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(stranger.pid)], { env: { ...process.env, LC_ALL: locale, LANG: locale } }).stdout.toString().trim()
    const liveGB = psUnder('en_GB.UTF-8')
    t('the pinned token has the C form (weekday, month, day, time, year)', form !== null, JSON.stringify(strangerToken))
    t(`this box's own ps under en_GB.UTF-8 writes the day before the month (${JSON.stringify(liveGB)}) — the shape an older build stamped here — or has no such locale`, liveGB === enGB || liveGB === strangerToken, `en_GB=${JSON.stringify(liveGB)} synthesized=${JSON.stringify(enGB)}`)
    workers.updateConcourseWorkers((workers: Record<string, unknown>) => {
      workers['runner-engb'] = baseRecord('runner-engb', { pid: stranger.pid, ...(enGB ? { procStart: enGB } : {}) })
      workers['runner-dede'] = baseRecord('runner-dede', { pid: stranger.pid, ...(deDE ? { procStart: deDE } : {}) })
      workers['runner-engb-dead'] = baseRecord('runner-engb-dead', { pid: 3_999_998, ...(enGB ? { procStart: enGB } : {}) })
    }, dir)
    const pending = workers.pendingParkRequests(dir) as string[]
    t(`an en_GB-shaped older token (${JSON.stringify(enGB)}) against the live pid reads ALIVE (the two forms parse to one start)`, strangerToken === null || pending.includes('runner-engb'), JSON.stringify(pending))
    t(`a de_DE-shaped older token (${JSON.stringify(deDE)}) against the live pid reads ALIVE (no English month to parse: uncertain, never a stranger)`, strangerToken === null || pending.includes('runner-dede'), JSON.stringify(pending))
    t('an en_GB-shaped token against a dead pid reads dead', !pending.includes('runner-engb-dead'))
    t('the reused-pid verdict of L2 still stands beside them (a token of another start is a stranger)', strangerToken === null || !pending.includes('runner-reused'), JSON.stringify(pending))
  }

  console.log('L4 structural — one liveness owner, stamped writers')
  {
    const src = readFileSync(join(SRC, 'daemon/concourseWorkers.ts'), 'utf8')
    const identity = await import(join(SRC, 'daemon/workerIdentity.ts'))
    const identitySource = readFileSync(join(SRC, 'daemon/workerIdentity.ts'), 'utf8')
    t('the liveness owner exists and the daemon exports that same owner', identitySource.includes('function workerPidAlive(') && workers.workerPidAlive === identity.workerPidAlive)
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
