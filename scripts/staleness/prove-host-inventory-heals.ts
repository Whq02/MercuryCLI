#!/usr/bin/env bun
// ============================================================================
//  scripts/staleness/prove-host-inventory-heals.ts — the Windows host
//  inventory can HEAL (the finding
//  windows-host-inventory-missing-verdict-sticks-forever).
//
//  The law: the terminal-profile card's dependency rows are written by
//  actors OUTSIDE this process (winget in its own console, a manual
//  installer) — so a 'missing' verdict may not stick for process life, and
//  the card's OWN install action must reach the cache it paints from.
//   · 'present' sticks for the process;
//   · 'missing' re-checks after MISSING_RECHECK_MS;
//   · 'unknown' is evicted at once;
//   · launchHostSetupAction evicts its target's verdict;
//   · the card watches a launched install and re-probes until it lands.
//
//  NEEDS-REAL-BOX (the live leg; the operator's driver line): on the
//  Windows box, launch a SOURCE build from conhost (not Windows Terminal)
//  with wt.exe absent → the card's inventory row reads ✗ Windows Terminal →
//  pick "Install Windows Terminal now (winget…)" → let winget finish in its
//  window → WITHOUT relaunching, the row flips to ✓ within ~35s (one
//  install-watch beat past the winget exit).
// ============================================================================
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

// A scripted prober + fake clock: each call consumes the next verdict.
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

// ── the cache grammar, driven ───────────────────────────────────────────────
{
  let clock = 1_000
  const now = (): number => clock

  // 1) missing sticks INSIDE the recheck window (one probe serves two reads).
  const p1 = makeProber(['missing', 'present'])
  const r1a = await host.cachedPresenceProbe('stale-a.exe', p1.fn, now)
  clock += 5_000
  const r1b = await host.cachedPresenceProbe('stale-a.exe', p1.fn, now)
  check('missing sticks inside the window (no second spawn)', r1a === 'missing' && r1b === 'missing' && p1.calls() === 1)

  // 2) …and RE-CHECKS after the window: the outside install lands.
  clock += host.MISSING_RECHECK_MS + 1
  const r1c = await host.cachedPresenceProbe('stale-a.exe', p1.fn, now)
  check('missing re-checks after MISSING_RECHECK_MS (the install is seen)', r1c === 'present' && p1.calls() === 2)

  // 3) present sticks for the process, however old.
  clock += host.MISSING_RECHECK_MS * 10
  const r1d = await host.cachedPresenceProbe('stale-a.exe', p1.fn, now)
  check('present sticks (no re-probe of an installed tool)', r1d === 'present' && p1.calls() === 2)

  // 4) unknown is evicted at once — the next read re-probes.
  const p2 = makeProber(['unknown', 'present'])
  const r2a = await host.cachedPresenceProbe('stale-b.exe', p2.fn, now)
  const r2b = await host.cachedPresenceProbe('stale-b.exe', p2.fn, now)
  check('unknown never sticks', r2a === 'unknown' && r2b === 'present' && p2.calls() === 2)

  // 5) the install action's eviction: a fresh 'missing' re-probes at once.
  const p3 = makeProber(['missing', 'present'])
  await host.cachedPresenceProbe('stale-c.exe', p3.fn, now)
  host.evictHostPresence(['stale-c.exe'])
  const r3 = await host.cachedPresenceProbe('stale-c.exe', p3.fn, now)
  check('evictHostPresence forces the next probe (the install-action law)', r3 === 'present' && p3.calls() === 2)

  // 6) concurrent callers share ONE in-flight probe.
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

// ── the action → targets mapping ────────────────────────────────────────────
{
  check('the terminal action evicts wt.exe', host.presenceTargetsForAction('install-windows-terminal').join() === 'wt.exe')
  check('the pwsh action evicts pwsh.exe', host.presenceTargetsForAction('install-pwsh7').join() === 'pwsh.exe')
}

// ── the probe seam stays honest (table-driven, no Windows needed) ───────────
{
  const inv = await host.detectWindowsHostInventory({
    platform: 'win32',
    which: exe => Promise.resolve(exe === 'wt.exe' ? 'missing' : 'present'),
  })
  check('the inventory seam maps per-exe verdicts', inv.windowsTerminal === 'missing' && inv.pwsh7 === 'present' && inv.winget === 'present')
  const off = await host.detectWindowsHostInventory({ platform: 'darwin' })
  check('non-win32 reports unknown, never fabricated absence', off.windowsTerminal === 'unknown' && off.pwsh7 === 'unknown')
}

// ── source pins: the writer reaches the reader ──────────────────────────────
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
