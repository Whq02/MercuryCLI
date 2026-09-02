// bridgeToken — the Blender-bridge session credential, exchanged via a file
// INSIDE the installed add-on's own directory (the unity bridgeToken
// sibling with the scope difference recorded: unity's token is per-PROJECT
// under Library/, this one is per-INSTALL under the user addon home —
// because the add-on itself is user-scoped, both halves know the path with
// zero project coupling: the add-on via its own __file__, Mercury because
// it materialized the add-on there). <addonHome>/mercury_blender_bridge/
// token, mode 0600, 64-hex, created on first ARMED use and stable per
// install (concurrent Mercury sessions agree on it; uninstall removes the
// add-on dir whole, token included; a deleted dir simply rotates the token
// on the next armed use). MERCURY_BLENDER_BRIDGE_TOKEN overrides for
// proofs/embedders and is never written to disk. NOTHING here runs when the
// flag is off (callers gate).

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { blenderBridgeTokenOverride } from '../../utils/blender/bridgeGates.js'
import { BLENDER_ADDON_MODULE } from './addonHome.js'

export function blenderBridgeTokenPath(addonHome: string): string {
  return path.join(addonHome, BLENDER_ADDON_MODULE, 'token')
}

/** Read-or-create the install token. Callers MUST be flag-gated (this writes). */
export function ensureBlenderBridgeToken(addonHome: string): string {
  const override = blenderBridgeTokenOverride()
  if (override) return override
  const file = blenderBridgeTokenPath(addonHome)
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
export function readBlenderBridgeToken(addonHome: string): string | undefined {
  const override = blenderBridgeTokenOverride()
  if (override) return override
  try {
    const existing = readFileSync(blenderBridgeTokenPath(addonHome), 'utf8').trim()
    return /^[0-9a-f]{64}$/.test(existing) ? existing : undefined
  } catch {
    return undefined
  }
}
