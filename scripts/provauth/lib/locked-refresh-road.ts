import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { LockedRefreshAnswer, LockedRefreshRoad } from '../../../src/models/sign-in/lifecycle/lockedRefresh.ts'

export interface ProofPair {
  accessToken: string
  refreshToken: string
  expiresAtMs: number
}

interface ProofRow {
  email: string
  tokens?: ProofPair
}

export const PROOF_EXCHANGE_DEADLINE_MS = 200

export function readRow(path: string): ProofRow | undefined {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ProofRow) : undefined
}

export function writeRow(path: string, row: ProofRow): void {
  writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(row) + '\n', { mode: 0o600 })
  renameSync(`${path}.${process.pid}.tmp`, path)
}

export function proofRoad(path: string, base: string, force = false): LockedRefreshRoad<ProofPair> {
  return {
    path,
    exchangeDeadlineMs: PROOF_EXCHANGE_DEADLINE_MS,
    force,
    read: () => readRow(path)?.tokens,
    write: pair => {
      if (existsSync(`${path}.unwritable`)) throw new Error(`the proof holds ${path} unwritable`)
      const row = readRow(path)
      if (row === undefined) throw new Error(`the proof's store ${path} is gone`)
      writeRow(path, { ...row, tokens: pair })
    },
    fresh: pair => pair.expiresAtMs > Date.now() + 60_000,
    exchange: async old => {
      const response = await fetch(`${base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: old.refreshToken }).toString(),
      })
      const body = (await response.json()) as Record<string, unknown>
      if (response.status === 200 && typeof body.access_token === 'string' && typeof body.refresh_token === 'string') {
        return { state: 'refreshed', pair: { accessToken: body.access_token, refreshToken: body.refresh_token, expiresAtMs: Date.now() + 3_600_000 } }
      }
      if (body.error === 'invalid_grant') return { state: 'dead', error: new Error(`HTTP ${response.status} invalid_grant`) }
      throw new Error(`the stand-in token server answered HTTP ${response.status}`)
    },
  }
}

export function told(answer: LockedRefreshAnswer<ProofPair>): { state: string; refreshToken?: string; error?: string } {
  switch (answer.state) {
    case 'absent':
      return { state: answer.state }
    case 'refreshed':
    case 'current':
    case 'busy':
      return { state: answer.state, refreshToken: answer.pair.refreshToken }
    case 'dead':
    case 'failed':
      return { state: answer.state, refreshToken: answer.pair.refreshToken, error: answer.error instanceof Error ? answer.error.message : String(answer.error) }
  }
}
