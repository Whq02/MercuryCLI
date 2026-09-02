#!/usr/bin/env bun
// ============================================================================
//  prove-device-headroom — the Device-headroom probe reads HONEST availability
//  (operator repro: "300MB free · load 0.87/core — near the spawn
//  failsafe" WARNED on a healthy Mac while the green gate ran).
//
//  The HONESTY class: a gauge keyed on os.freemem() — free
//  PAGES, not available memory — plus a load modifier that fires during any
//  gate run, plus prose naming a "spawn failsafe" that does not exist.
//
//  Locks:
//   §1 pure parsers — canned vm_stat / meminfo → exact available bytes
//   §2 live floor  — deviceHeadroom() ≥ freemem() on darwin/linux, honest
//                    provenance tag
//   §3 source ratchet — the resources check calls deviceHeadroom(), carries
//                    no bare freemem(), and never names a phantom failsafe;
//                    the busy modifier means sustained oversubscription
//                    (≥1.25/core), not a busy gate run (0.87 was a repro)
// ============================================================================
import { readFileSync } from 'node:fs'
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

console.log('§3 source ratchet (the class stays dead)')
const report = readFileSync('src/utils/healthReport.ts', 'utf8')
const check = report.slice(report.indexOf("id: 'resources'"), report.indexOf("id: 'resources'") + 2600)
t('resources check reads deviceHeadroom()', check.includes('await deviceHeadroom()'))
const checkCode = check.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
t('resources check carries NO bare freemem() call (comments may name the trap)', !checkCode.includes('freemem('))
t('no phantom mechanism named (the "spawn failsafe" prose is dead)', !/near the spawn failsafe/.test(check))
t('busy = sustained oversubscription (≥1.25/core), not a gate run', /perCore >= 1\.25/.test(check))
t('healthReport imports no freemem at all', !/import \{[^}]*freemem[^}]*\} from 'node:os'/.test(report))


// ── FC-094: win32 has no loadavg — the row says so and keeps its floor ──────
{
  const { readFileSync: readSrc94 } = await import('node:fs')
  const { join: join94 } = await import('node:path')
  const src94 = readSrc94(join94(import.meta.dir, '..', '..', 'src', 'utils', 'healthReport.ts'), 'utf8')
  t(
    'FC-094: the row forks on load knowability (win32 renders n/a, never 0.00/core)',
    src94.includes('load n/a (win32 has no loadavg)'),
  )
  t(
    'FC-094: unknowable load counts BUSY — the 768 MB warn floor survives the platform',
    /const busy = loadKnown \? perCore >= 1\.25 : true/.test(src94),
  )
}

console.log(failures ? '\n❌ DEVICE-HEADROOM RED' : '\n✅ DEVICE-HEADROOM GREEN')
process.exit(failures)
