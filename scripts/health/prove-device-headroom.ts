#!/usr/bin/env bun
import { freemem } from 'node:os'
import { parseMemAvailable, parseVmStat, deviceHeadroom } from '../../src/utils/cockpit/deviceHeadroom.ts'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

console.log('§1 pure parsers')
const VM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                4843.
Pages active:                            136957.
Pages inactive:                          134320.
Pages speculative:                         2166.
Pages throttled:                              0.
Pages purgeable:                           9000.
`
const expected = (4843 + 134320 + 2166 + 9000) * 16384
t('vm_stat: free+inactive+speculative+purgeable × header page size', parseVmStat(VM) === expected, `${parseVmStat(VM)} vs ${expected}`)
t('vm_stat: unrecognizable shape → null (caller falls back)', parseVmStat('nonsense') === null)
t('vm_stat: zero-page pathology → null, never a fabricated 0-available', parseVmStat('page size of 16384 bytes\nPages wired: 5.\n') === null)
t('meminfo: MemAvailable kB → bytes', parseMemAvailable('MemTotal: 16000000 kB\nMemAvailable:  8123456 kB\n') === 8123456 * 1024)
t('meminfo: absent → null', parseMemAvailable('MemTotal: 1 kB\n') === null)

console.log('§2 live read (this machine)')
const live = await deviceHeadroom()
t('live source is the platform-honest one', process.platform === 'darwin' ? live.source === 'vm_stat' : live.source !== 'vm_stat', live.source)
t('available ≥ the freemem() floor (free pages are a subset of available)', live.availableB >= freemem(), `${Math.round(live.availableB / 1048576)}MB avail vs ${Math.round(freemem() / 1048576)}MB free`)
t('available is a finite positive number (no NaN-as-live)', Number.isFinite(live.availableB) && live.availableB > 0)

console.log('§3 the row (run here)')
const { runtimeChecks } = await import('../../src/utils/health/sections/runtime.ts')
const resourcesRow = runtimeChecks().find(row => row.id === 'resources')
const says = await resourcesRow?.run()
const now = await deviceHeadroom()
const shown = Number(/^(\d+)MB available/.exec(says?.evidence ?? '')?.[1] ?? NaN)
t('resources check reads deviceHeadroom()', says?.evidence.endsWith(`(${now.source})`) === true && Math.abs(shown - now.availableB / 1048576) <= Math.max(512, now.availableB / 1048576 / 10), says?.evidence)
t('resources check carries NO bare freemem() call (comments may name the trap)', shown >= Math.floor(freemem() / 1048576 / 2), `${shown}MB shown vs ${Math.round(freemem() / 1048576)}MB free`)
t('no phantom mechanism named (the "spawn failsafe" prose is dead)', !/near the spawn failsafe/.test(`${says?.evidence} ${says?.fix ?? ''}`))
t('busy = sustained oversubscription (≥1.25/core), not a gate run', /load \d+\.\d\d\/core \(\d+ cores\)/.test(says?.evidence ?? '') && (says?.status === 'warn') === (now.availableB < 256 * 1048576 || (now.availableB < 768 * 1048576 && Number(/load (\d+\.\d\d)\/core/.exec(says?.evidence ?? '')?.[1] ?? 0) >= 1.25)), says?.evidence)

{
  const platformNow = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platformNow, value: 'win32' })
  let onWindows: { status: string; evidence: string } | undefined
  try {
    onWindows = await resourcesRow?.run()
  } catch {
    onWindows = undefined
  } finally {
    Object.defineProperty(process, 'platform', platformNow)
  }
  t(
    'FC-094: the row forks on load knowability (win32 renders n/a, never 0.00/core)',
    onWindows?.evidence.includes('load n/a (win32 has no loadavg)') === true && !/load \d/.test(onWindows.evidence),
    onWindows?.evidence,
  )
}

console.log(failures ? '\n❌ DEVICE-HEADROOM RED' : '\n✅ DEVICE-HEADROOM GREEN')
process.exit(failures)
