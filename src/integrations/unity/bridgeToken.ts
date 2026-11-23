
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { unityBridgeTokenOverride } from '../unity-protocol/bridgeGates.js'
import { passedOver } from '../../platform/errors/passedOver.js'

export function unityBridgeTokenPath(projectRoot: string): string {
  return path.join(projectRoot, 'Library', 'mercury-unity-bridge-token')
}

export function ensureUnityBridgeToken(projectRoot: string): string {
  const override = unityBridgeTokenOverride()
  if (override) return override
  const file = unityBridgeTokenPath(projectRoot)
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

type UnityBridgeTokenOutcome =
  | { state: 'present'; token: string }
  | { state: 'absent' }
  | { state: 'unreadable'; path: string; error: string }

export function readUnityBridgeTokenOutcome(projectRoot: string): UnityBridgeTokenOutcome {
  const override = unityBridgeTokenOverride()
  if (override) return { state: 'present', token: override }
  const file = unityBridgeTokenPath(projectRoot)
  try {
    const existing = readFileSync(file, 'utf8').trim()
    return /^[0-9a-f]{64}$/.test(existing) ? { state: 'present', token: existing } : { state: 'absent' }
  } catch (error) {
    passedOver(error)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' }
    return { state: 'unreadable', path: file, error: error instanceof Error ? error.message : String(error) }
  }
}

export function readUnityBridgeToken(projectRoot: string): string | undefined {
  const outcome = readUnityBridgeTokenOutcome(projectRoot)
  return outcome.state === 'present' ? outcome.token : undefined
}
