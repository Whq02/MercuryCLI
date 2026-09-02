// bridgeToken — the Unity-bridge session credential, exchanged via a
// project-private file (the vulcanToken sibling; the loopback listener's
// auth floor). The token lives at <project>/Library/mercury-unity-bridge-token
// — Library/ is the editor-private, machine-local, conventionally-gitignored
// dir (the same home as Library/EditorInstance.json, which the landed unity
// attach road already reads), mode 0600, created on first ARMED use and
// stable per project (concurrent Mercury sessions must agree on it; a
// deleted Library/ simply rotates it on the next armed use).
// MERCURY_UNITY_BRIDGE_TOKEN overrides for proofs/embedders and is never
// written to disk. NOTHING here runs when the flag is off (callers gate).

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { unityBridgeTokenOverride } from '../../utils/unity/bridgeGates.js'

export function unityBridgeTokenPath(projectRoot: string): string {
  return path.join(projectRoot, 'Library', 'mercury-unity-bridge-token')
}

/** Read-or-create the project token. Callers MUST be flag-gated (this writes). */
export function ensureUnityBridgeToken(projectRoot: string): string {
  const override = unityBridgeTokenOverride()
  if (override) return override
  const file = unityBridgeTokenPath(projectRoot)
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
export function readUnityBridgeToken(projectRoot: string): string | undefined {
  const override = unityBridgeTokenOverride()
  if (override) return override
  try {
    const existing = readFileSync(unityBridgeTokenPath(projectRoot), 'utf8').trim()
    return /^[0-9a-f]{64}$/.test(existing) ? existing : undefined
  } catch {
    return undefined
  }
}
