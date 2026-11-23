
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { blenderBridgeTokenOverride } from '../blender-protocol/bridgeGates.js'
import { BLENDER_ADDON_MODULE } from './addonHome.js'
import { passedOver } from '../../platform/errors/passedOver.js'

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

type BlenderBridgeTokenOutcome =
  | { state: 'present'; token: string }
  | { state: 'absent' }
  | { state: 'unreadable'; path: string; error: string }

export function readBlenderBridgeTokenOutcome(addonHome: string): BlenderBridgeTokenOutcome {
  const override = blenderBridgeTokenOverride()
  if (override) return { state: 'present', token: override }
  const file = blenderBridgeTokenPath(addonHome)
  try {
    const existing = readFileSync(file, 'utf8').trim()
    return /^[0-9a-f]{64}$/.test(existing) ? { state: 'present', token: existing } : { state: 'absent' }
  } catch (error) {
    passedOver(error)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }
    return { state: 'unreadable', path: file, error: error instanceof Error ? error.message : String(error) }
  }
}

export function readBlenderBridgeToken(addonHome: string): string | undefined {
  const outcome = readBlenderBridgeTokenOutcome(addonHome)
  return outcome.state === 'present' ? outcome.token : undefined
}
