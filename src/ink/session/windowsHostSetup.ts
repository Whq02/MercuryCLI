
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
  command: string[] | null
  url: string
}

const WHERE_TIMEOUT_MS = 2500

type PresenceEntry = {
  probe: Promise<PresenceState>
  settled: PresenceState | null
  at: number
}
const presenceCache = new Map<string, PresenceEntry>()
export const MISSING_RECHECK_MS = 30_000

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

export function evictHostPresence(exes: readonly string[]): void {
  for (const exe of exes) presenceCache.delete(exe)
}

export function presenceTargetsForAction(id: HostSetupAction['id']): string[] {
  return id === 'install-windows-terminal' ? ['wt.exe'] : ['pwsh.exe']
}

function rawWhereExists(exe: string): Promise<PresenceState> {
  return new Promise<PresenceState>(resolve => {
    execFile(
      'where.exe',
      [exe],
      { timeout: WHERE_TIMEOUT_MS, windowsHide: true, env: { ...subprocessEnv() } },
      err => {
        if (!err) return resolve('present')
        const code: unknown = (err as { code?: unknown }).code
        resolve(code === 1 ? 'missing' : 'unknown')
      },
    )
  })
}

function whereExists(exe: string): Promise<PresenceState> {
  return cachedPresenceProbe(exe, rawWhereExists)
}

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

export function launchHostSetupAction(action: HostSetupAction): boolean {
  if (!action.command) return false
  try {
    execFile(
      'cmd.exe',
      ['/c', 'start', '', ...action.command],
      { windowsHide: false, env: { ...subprocessEnv() } },
      () => {},
    )
    evictHostPresence(presenceTargetsForAction(action.id))
    return true
  } catch {
    return false
  }
}
