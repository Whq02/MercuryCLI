
export type CommandDomain = {
  key: string
  label: string
  names: readonly string[]
}

export const COMMAND_DOMAINS: readonly CommandDomain[] = [
  {
    key: 'work',
    label: 'current work',
    names: ['run', 'tasks', 'workbench', 'diff', 'mission', 'supervisor', 'themis'],
  },
  {
    key: 'crew',
    label: 'crew & delegation',
    names: [
      'workflows', 'agents', 'subagents', 'agent-form', 'fleet',
      'teammates', 'crew', 'route', 'monitor', 'surfaces',
      'daemon', 'saturn', 'seats', 'halt', 'kill', 'unkill',
      'multiplayer', 'say', 'live', 'remote-control',
      'team', 'router', 'invite', 'handoff',
      'delegate', 'request', 'prompt', 'share',
    ],
  },
  {
    key: 'session',
    label: 'session & context',
    names: [
      'clear', 'compact', 'context', 'auto-compact-window', 'resume',
      'rewind', 'session', 'sessions', 'sessiontab', 'concourse', 'branches',
      'export', 'cost', 'usage',
      'debrief', 'summary', 'rename', 'title', 'tag', 'contract', 'think-back',
      'thinkback-play', 'copy', 'files',
      'realms', 'add-dir', 'insights',
    ],
  },
  {
    key: 'memory',
    label: 'memory & goals',
    names: [
      'cards', 'remember', 'memory', 'meh', 'good',
      'brief', 'console', 'tabula', 'note', 'minerva',
      'orient',
    ],
  },
  {
    key: 'model',
    label: 'model & effort',
    names: [
      'model', 'effort', 'strategy', 'supercode', 'submodels', 'ultraplan',
      'advisor', 'counsel', 'harness', 'caching',
    ],
  },
  {
    key: 'git',
    label: 'git & review',
    names: [
      'commit', 'commit-push-pr', 'branch', 'review',
      'security-review', 'pr-comments', 'tickets',
    ],
  },
  {
    key: 'health',
    label: 'health & introspection',
    names: [
      'health', 'verify', 'ledger', 'trace', 'substrate', 'stats', 'status',
      'capabilities', 'capabilities-detail', 'passes', 'provenance',
      'heapdump',
    ],
  },
  {
    key: 'config',
    label: 'config & setup',
    names: [
      'config', 'bootmenu', 'permissions', 'hooks', 'mcp', 'extensions', 'skills',
      'policy', 'authority', 'sovereign', 'sandbox',
      'terminal-setup', 'keybindings', 'keys',
      'statusline', 'vim', 'mouse', 'pings', 'ide', 'chrome', 'browser',
      'web-setup', 'init', 'init-verifiers', 'install',
      'speak', 'voice',
    ],
  },
  {
    key: 'appearance',
    label: 'appearance & cockpit',
    names: [
      'cockpit', 'home', 'palette', 'critter', 'showcase',
      'color', 'accent', 'fullscreen',
      'companion', 'appearance',
    ],
  },
  {
    key: 'account',
    label: 'account & app',
    names: [
      'logins', 'logout', 'accounts', 'defaultprovider', 'version', 'release-notes',
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
