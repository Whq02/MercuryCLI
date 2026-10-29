#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const host = await import('../../src/ink/session/windowsHostSetup.js')
type Presence = 'present' | 'missing' | 'unknown'

function makeProber(script: Presence[]): { fn: (exe: string) => Promise<Presence>; calls: () => number } {
  let n = 0
  return {
    fn: () => {
      const next = script[Math.min(n, script.length - 1)]!
      n += 1
      return Promise.resolve(next)
    },
    calls: () => n,
  }
}

{
  let clock = 1_000
  const now = (): number => clock

  const p1 = makeProber(['missing', 'present'])
  const r1a = await host.cachedPresenceProbe('stale-a.exe', p1.fn, now)
  clock += 5_000
  const r1b = await host.cachedPresenceProbe('stale-a.exe', p1.fn, now)
  check('missing sticks inside the window (no second spawn)', r1a === 'missing' && r1b === 'missing' && p1.calls() === 1)

  clock += host.MISSING_RECHECK_MS + 1
  const r1c = await host.cachedPresenceProbe('stale-a.exe', p1.fn, now)
  check('missing re-checks after MISSING_RECHECK_MS (the install is seen)', r1c === 'present' && p1.calls() === 2)

  clock += host.MISSING_RECHECK_MS * 10
  const r1d = await host.cachedPresenceProbe('stale-a.exe', p1.fn, now)
  check('present sticks (no re-probe of an installed tool)', r1d === 'present' && p1.calls() === 2)

  const p2 = makeProber(['unknown', 'present'])
  const r2a = await host.cachedPresenceProbe('stale-b.exe', p2.fn, now)
  const r2b = await host.cachedPresenceProbe('stale-b.exe', p2.fn, now)
  check('unknown never sticks', r2a === 'unknown' && r2b === 'present' && p2.calls() === 2)

  const p3 = makeProber(['missing', 'present'])
  await host.cachedPresenceProbe('stale-c.exe', p3.fn, now)
  host.evictHostPresence(['stale-c.exe'])
  const r3 = await host.cachedPresenceProbe('stale-c.exe', p3.fn, now)
  check('evictHostPresence forces the next probe (the install-action law)', r3 === 'present' && p3.calls() === 2)

  let resolveProbe: ((s: Presence) => void) | null = null
  let probes = 0
  const slow = (): Promise<Presence> => {
    probes += 1
    return new Promise<Presence>(res => {
      resolveProbe = res
    })
  }
  const c1 = host.cachedPresenceProbe('stale-d.exe', slow, now)
  const c2 = host.cachedPresenceProbe('stale-d.exe', slow, now)
  resolveProbe!('present')
  const [v1, v2] = await Promise.all([c1, c2])
  check('concurrent callers share one in-flight probe', v1 === 'present' && v2 === 'present' && probes === 1)
}

{
  check('the terminal action evicts wt.exe', host.presenceTargetsForAction('install-windows-terminal').join() === 'wt.exe')
  check('the pwsh action evicts pwsh.exe', host.presenceTargetsForAction('install-pwsh7').join() === 'pwsh.exe')
}

{
  const inv = await host.detectWindowsHostInventory({
    platform: 'win32',
    which: exe => Promise.resolve(exe === 'wt.exe' ? 'missing' : 'present'),
  })
  check('the inventory seam maps per-exe verdicts', inv.windowsTerminal === 'missing' && inv.pwsh7 === 'present' && inv.winget === 'present')
  const off = await host.detectWindowsHostInventory({ platform: 'darwin' })
  check('non-win32 reports unknown, never fabricated absence', off.windowsTerminal === 'unknown' && off.pwsh7 === 'unknown')
}

{
  const src = readFileSync(join(repoRoot, 'src/ink/session/windowsHostSetup.ts'), 'utf8')
  check('launchHostSetupAction evicts its target after the launch', src.includes('evictHostPresence(presenceTargetsForAction(action.id))'))
  const card = readFileSync(join(repoRoot, 'src/components/TerminalProfileCard.tsx'), 'utf8')
  check('the card arms an install watch on a launched install', card.includes('setInstallWatch(action.id)'))
  check('the watch re-probes the inventory and repaints the rows', card.includes('INSTALL_WATCH_TICK_MS') && card.includes('setInventory(inv)'))
  check('the watch is bounded (a stalled install stops it)', card.includes('INSTALL_WATCH_TICKS'))
}

console.log(failures === 0 ? 'prove-host-inventory-heals: GREEN' : `prove-host-inventory-heals: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
