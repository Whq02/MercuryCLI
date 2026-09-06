
const RETIRED_ENTRY_KINDS: Readonly<Record<string, string>> = {
  'marble-origami-commit': 'context-collapse-commit',
  'marble-origami-snapshot': 'context-collapse-snapshot',
}

export function migrateTranscriptEntryKind<T extends { type?: unknown }>(entry: T): T {
  const kind = entry.type
  if (typeof kind !== 'string') return entry
  const current = RETIRED_ENTRY_KINDS[kind]
  return current === undefined ? entry : { ...entry, type: current }
}
