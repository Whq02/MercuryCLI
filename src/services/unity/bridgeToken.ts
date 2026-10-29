
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { unityBridgeTokenOverride } from '../../utils/unity/bridgeGates.js'

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
