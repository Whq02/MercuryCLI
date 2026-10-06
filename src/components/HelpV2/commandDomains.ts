
export type CommandDomain = {
  key: string
  label: string
  names: readonly string[]
}

export const COMMAND_DOMAINS: readonly CommandDomain[] = [
  {
    key: 'work',
    label: 'current work',
    names: ['run', 'runs', 'workbench', 'diff', 'mission', 'samples'],
  },
  {
    key: 'crew',
    label: 'crew & delegation',
    names: [
      'workflows', 'agents', 'subagents', 'fleet',
      'crewmates', 'crew', 'monitor', 'surfaces',
      'daemon', 'saturn', 'seats', 'halt', 'kill', 'unkill',
      'live', 'router',
    ],
  },
  {
    key: 'session',
    label: 'session & context',
    names: [
      'clear', 'compact', 'context', 'auto-compact-window', 'resume',
      'rewind', 'sessions', 'sessiontab', 'concourse', 'branches',
      'export', 'usage',
      'debrief', 'rename', 'title', 'contract',
      'copy',
      'realms',
    ],
  },
  {
    key: 'memory',
    label: 'memory & goals',
    names: [
      'memory',
      'console',
      'orient',
    ],
  },
  {
    key: 'model',
    label: 'model & effort',
    names: [
      'model', 'effort', 'submodels', 'advise',
      'counsel', 'harness', 'caching',
    ],
  },
  {
    key: 'git',
    label: 'git & review',
    names: [
      'branch', 'review',
      'audit',
    ],
  },
  {
    key: 'health',
    label: 'health & introspection',
    names: [
      'health', 'verify', 'ledger', 'trace', 'substrate', 'status',
      'capabilities', 'provenance',
    ],
  },
  {
    key: 'config',
    label: 'config & setup',
    names: [
      'config', 'jev', 'jevor', 'localsetup', 'bootmenu', 'permissions', 'hooks', 'mcp', 'extensions', 'skills',
      'policy', 'authority', 'sovereign', 'sandbox',
      'keysetup', 'keybindings', 'keys',
      'vim', 'mouse', 'browser',
      'init',
      'speak', 'voice',
    ],
  },
  {
    key: 'appearance',
    label: 'appearance & cockpit',
    names: [
      'cockpit', 'home', 'palette', 'critter', 'view', 'showcase',
      'accent', 'fullscreen',
      'appearance',
    ],
  },
  {
    key: 'account',
    label: 'account & app',
    names: [
      'logins', 'logout', 'accounts', 'defaultprovider', 'update-notes',
      'feedback', 'help', 'exit',
    ],
  },
]

export const FALLBACK_DOMAIN_LABEL = 'everything else'

export type DomainGroup<T> = { key: string; label: string; commands: T[] }

export function groupCommandsByDomain<T extends { name: string }>(
  commands: readonly T[],
): DomainGroup<T>[] {
  const domainByName = new Map<string, string>()
  for (const d of COMMAND_DOMAINS) {
    for (const n of d.names) {
      if (!domainByName.has(n)) domainByName.set(n, d.key)
    }
  }
  const buckets = new Map<string, T[]>()
  for (const cmd of commands) {
    const key = domainByName.get(cmd.name) ?? '__other'
    const list = buckets.get(key)
    if (list) list.push(cmd)
    else buckets.set(key, [cmd])
  }
  const byName = (a: T, b: T) => a.name.localeCompare(b.name)
  const out: DomainGroup<T>[] = []
  for (const d of COMMAND_DOMAINS) {
    const list = buckets.get(d.key)
    if (list && list.length > 0) out.push({ key: d.key, label: d.label, commands: list.sort(byName) })
  }
  const other = buckets.get('__other')
  if (other && other.length > 0) {
    out.push({ key: 'other', label: FALLBACK_DOMAIN_LABEL, commands: other.sort(byName) })
  }
  return out
}
