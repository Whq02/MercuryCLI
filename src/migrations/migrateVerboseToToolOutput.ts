import { saveGlobalConfig } from '../utils/config.js'

const RETIRED_KEY = 'verbose'

export function migrateVerboseToToolOutput(): void {
  saveGlobalConfig(current => {
    const record = current as Record<string, unknown>
    if (!(RETIRED_KEY in record)) return current
    const next: Record<string, unknown> = {
      ...current,
      toolOutput: record[RETIRED_KEY] === true ? 'full' : 'compact',
    }
    delete next[RETIRED_KEY]
    return next as typeof current
  })
}
