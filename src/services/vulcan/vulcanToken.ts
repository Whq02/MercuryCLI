// vulcanToken — the VULCAN session credential, exchanged via a project-private
// file (the loopback listener's auth floor — deliberately STRONGER than the
// editor's own unauthenticated LSP/DAP listeners).
//
// The token lives at <project>/.godot/mercury-vulcan-token (the editor-private
// dir, gitignored by Godot convention), mode 0600, created on first ARMED use
// and stable per project (two concurrent Mercury sessions must agree on it —
// a per-session rotate would fight over the file; the design doc records this
// refinement). MERCURY_GODOT_TOOLS_TOKEN overrides for proofs/embedders and is
// never written to disk. NOTHING here runs when the flag is off (callers gate).

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { vulcanTokenOverride } from '../../utils/vulcan/vulcanGates.js'

export function vulcanTokenPath(projectRoot: string): string {
  return path.join(projectRoot, '.godot', 'mercury-vulcan-token')
}

/** Read-or-create the project token. Callers MUST be flag-gated (this writes). */
export function ensureVulcanToken(projectRoot: string): string {
  const override = vulcanTokenOverride()
  if (override) return override
  const file = vulcanTokenPath(projectRoot)
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return existing
    // Malformed (hand-edited?) — regenerate below rather than trusting it.
  }
  const token = randomBytes(32).toString('hex')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, token + '\n', { mode: 0o600 })
  chmodSync(file, 0o600) // writeFileSync mode is umask-filtered; pin it
  return token
}

/** Read-only probe (never creates). Undefined when absent/malformed. */
export function readVulcanToken(projectRoot: string): string | undefined {
  const override = vulcanTokenOverride()
  if (override) return override
  try {
    const existing = readFileSync(vulcanTokenPath(projectRoot), 'utf8').trim()
    return /^[0-9a-f]{64}$/.test(existing) ? existing : undefined
  } catch {
    return undefined
  }
}
