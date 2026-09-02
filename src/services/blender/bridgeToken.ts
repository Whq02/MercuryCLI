
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { blenderBridgeTokenOverride } from '../../utils/blender/bridgeGates.js'
import { BLENDER_ADDON_MODULE } from './addonHome.js'

export function blenderBridgeTokenPath(addonHome: string): string {
  return path.join(addonHome, BLENDER_ADDON_MODULE, 'token')
}

export function ensureBlenderBridgeToken(addonHome: string): string {
  const override = blenderBridgeTokenOverride()
  if (override) return override
  const file = blenderBridgeTokenPath(addonHome)
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return existing
  }
  const token = randomBytes(32).toString('hex')
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, token + '\n', { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}

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
