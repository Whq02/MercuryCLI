
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import { vulcanTokenOverride } from '../../utils/vulcan/vulcanGates.js'

export function vulcanTokenPath(projectRoot: string): string {
  return path.join(projectRoot, '.godot', 'mercury-vulcan-token')
}

export function ensureVulcanToken(projectRoot: string): string {
  const override = vulcanTokenOverride()
  if (override) return override
  const file = vulcanTokenPath(projectRoot)
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
