// ============================================================================
//  windowsHostSetup — the requirement card's dependency inventory (the
//  friend-path QoL).
//
//  RESPONSIBILITY: when the terminal-profile card tells a Windows operator
//  "relaunch in a supported terminal", it must also say what THIS machine
//  actually has — Windows Terminal (the gate), PowerShell 7 (the preferred
//  shell, NOT the gate), winget (the installer) — and offer the install as
//  an action instead of a bare instruction. Detection is `where.exe` per
//  executable with a bounded timeout; an inconclusive probe reports
//  'unknown', never a fabricated 'missing' (the card only offers installs
//  for a PROVEN absence).
//
//  Installs launch in a SEPARATE console window (`cmd /c start ...`): the
//  card stays interactive, the operator watches winget in its own window,
//  and no raw-mode/stdio surgery happens under Ink.
// ============================================================================

import { execFile } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'

export type PresenceState = 'present' | 'missing' | 'unknown'

export interface WindowsHostInventory {
  windowsTerminal: PresenceState
  pwsh7: PresenceState
  winget: PresenceState
}

export interface HostSetupAction {
  id: 'install-windows-terminal' | 'install-pwsh7'
  label: string
  /** The winget argv to run in a separate console, when winget is present. */
  command: string[] | null
  /** The install page for the no-winget fallback (shown in the note). */
  url: string
}

const WHERE_TIMEOUT_MS = 2500

/** Per-process presence cache: the setup card re-probes on every paint, and
 *  a where.exe spawn per paint is pure waste. The verdict lifetimes follow
 *  the never-stale law — the truth's writers live OUTSIDE this process
 *  (winget in its own console window, a manual installer), so a verdict may
 *  only stick as long as it cannot silently rot:
 *   · 'present' sticks for the process (an installed tool does not
 *     uninstall itself mid-run);
 *   · 'missing' sticks only for MISSING_RECHECK_MS — a forever-'missing'
 *     kept the card's rows red after the install landed, and the card's own
 *     install action could never clear the card);
 *   · 'unknown' (spawn/timeout surprises) is evicted at once so a transient
 *     failure can still resolve on a later probe. */
type PresenceEntry = {
  probe: Promise<PresenceState>
  /** null while in flight; the settled verdict afterwards. */
  settled: PresenceState | null
  at: number
}
const presenceCache = new Map<string, PresenceEntry>()
export const MISSING_RECHECK_MS = 30_000

/** The cache grammar over an injected prober — the seam the staleness pins
 *  drive (the real prober spawns where.exe, which no test box need have).
 *  Concurrent callers share one in-flight probe. */
export function cachedPresenceProbe(
  exe: string,
  probeFn: (exe: string) => Promise<PresenceState>,
  now: () => number = Date.now,
): Promise<PresenceState> {
  const entry = presenceCache.get(exe)
  if (entry !== undefined) {
    const missingExpired =
      entry.settled === 'missing' && now() - entry.at > MISSING_RECHECK_MS
    if (!missingExpired) return entry.probe
    presenceCache.delete(exe)
  }
  const record: PresenceEntry = {
    probe: Promise.resolve('unknown'),
    settled: null,
    at: now(),
  }
  record.probe = probeFn(exe).then(state => {
    if (state === 'unknown') presenceCache.delete(exe)
    else {
      record.settled = state
      record.at = now()
    }
    return state
  })
  presenceCache.set(exe, record)
  return record.probe
}

/** The install action's own eviction: the action just changed (or is about
 *  to change) the world, so its target's verdict is no longer worth a
 *  cache window — the next probe re-asks where.exe. */
export function evictHostPresence(exes: readonly string[]): void {
  for (const exe of exes) presenceCache.delete(exe)
}

/** Which cached verdicts an action's install can move. */
export function presenceTargetsForAction(id: HostSetupAction['id']): string[] {
  return id === 'install-windows-terminal' ? ['wt.exe'] : ['pwsh.exe']
}

/** `where.exe <exe>`: exit 0 = present, exit 1 = missing; a timeout or any
 *  other failure is inconclusive — report 'unknown', never guess. */
function rawWhereExists(exe: string): Promise<PresenceState> {
  return new Promise<PresenceState>(resolve => {
    execFile(
      'where.exe',
      [exe],
      { timeout: WHERE_TIMEOUT_MS, windowsHide: true, env: { ...subprocessEnv() } },
      err => {
        if (!err) return resolve('present')
        // A non-zero EXIT lands here with a numeric code (1 = not found); a
        // spawn/timeout failure carries a string errno — inconclusive.
        const code: unknown = (err as { code?: unknown }).code
        resolve(code === 1 ? 'missing' : 'unknown')
      },
    )
  })
}

function whereExists(exe: string): Promise<PresenceState> {
  return cachedPresenceProbe(exe, rawWhereExists)
}

/** Probe seam for table tests — the resolver never needs a real Windows. */
export interface HostInventoryProbe {
  platform?: NodeJS.Platform
  which?: (exe: string) => Promise<PresenceState>
}

export async function detectWindowsHostInventory(
  probe: HostInventoryProbe = {},
): Promise<WindowsHostInventory> {
  const platform = probe.platform ?? process.platform
  if (platform !== 'win32') {
    return { windowsTerminal: 'unknown', pwsh7: 'unknown', winget: 'unknown' }
  }
  const which = probe.which ?? whereExists
  const [windowsTerminal, pwsh7, winget] = await Promise.all([
    which('wt.exe'),
    which('pwsh.exe'),
    which('winget.exe'),
  ])
  return { windowsTerminal, pwsh7, winget }
}

/** The card's per-dependency status lines. PowerShell 7 is labeled for what
 *  it is — the preferred shell, never the gate — so an operator does not
 *  install it expecting the requirement card to clear. */
export function inventoryLines(
  inv: WindowsHostInventory,
): Array<{ label: string; state: PresenceState; note: string }> {
  return [
    {
      label: 'Windows Terminal',
      state: inv.windowsTerminal,
      note: 'the gate — the full profile renders here',
    },
    {
      label: 'PowerShell 7',
      state: inv.pwsh7,
      note: 'preferred shell (quality-of-life, not the gate)',
    },
  ]
}

/** Install actions for PROVEN absences only. With winget present the action
 *  carries the exact argv; without it the label points at the install page. */
export function hostSetupActions(inv: WindowsHostInventory): HostSetupAction[] {
  const wingetArgs = (id: string): string[] => [
    'winget',
    'install',
    '--id',
    id,
    '-e',
    '--source',
    'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
  ]
  const actions: HostSetupAction[] = []
  if (inv.windowsTerminal === 'missing') {
    actions.push({
      id: 'install-windows-terminal',
      label:
        inv.winget === 'present'
          ? 'Install Windows Terminal now (winget, separate window)'
          : 'Get Windows Terminal — https://aka.ms/terminal',
      command: inv.winget === 'present' ? wingetArgs('Microsoft.WindowsTerminal') : null,
      url: 'https://aka.ms/terminal',
    })
  }
  if (inv.pwsh7 === 'missing') {
    actions.push({
      id: 'install-pwsh7',
      label:
        inv.winget === 'present'
          ? 'Install PowerShell 7 now (winget, separate window)'
          : 'Get PowerShell 7 — https://aka.ms/PSWindows',
      command: inv.winget === 'present' ? wingetArgs('Microsoft.PowerShell') : null,
      url: 'https://aka.ms/PSWindows',
    })
  }
  return actions
}

/** Launch an install in its own console window (fire-and-forget; the card
 *  stays up and notes where the install went). */
export function launchHostSetupAction(action: HostSetupAction): boolean {
  if (!action.command) return false
  try {
    // `start` opens a new console window; the empty "" is start's window
    // title slot (its first quoted arg is otherwise eaten as the title).
    execFile(
      'cmd.exe',
      ['/c', 'start', '', ...action.command],
      { windowsHide: false, env: { ...subprocessEnv() } },
      () => {},
    )
    // The world is about to move by this card's own hand: drop the target's
    // cached verdict so the card's install-watch probes re-ask where.exe
    // instead of replaying the pre-install 'missing'.
    evictHostPresence(presenceTargetsForAction(action.id))
    return true
  } catch {
    return false
  }
}
