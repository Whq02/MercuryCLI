import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../envUtils.js'

export const MODEL_USE_LEDGER_FILE = '.model-use.json'

export type ModelUseRecord = { at: number; model: string; door?: string }

export type ModelUseLedger = { uses: Record<string, ModelUseRecord> }

const FAMILY_RE = /^[a-z][a-z0-9-]{0,31}$/

function decodeLedger(raw: unknown): ModelUseLedger | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const uses: Record<string, ModelUseRecord> = {}
  const source = (raw as { uses?: unknown }).uses
  if (typeof source === 'object' && source !== null && !Array.isArray(source)) {
    for (const [family, value] of Object.entries(source as Record<string, unknown>)) {
      if (!FAMILY_RE.test(family) || typeof value !== 'object' || value === null) continue
      const { at, model, door } = value as { at?: unknown; model?: unknown; door?: unknown }
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || typeof model !== 'string' || model === '') continue
      uses[family] = { at, model, ...(typeof door === 'string' && door !== '' ? { door } : {}) }
    }
  }
  return { uses }
}

const ledgerStore = defineStore<ModelUseLedger, [string]>({
  name: 'modelUse',
  schemaVersion: 1,
  path: home => join(home, MODEL_USE_LEDGER_FILE),
  onReadFailure: 'empty',
  empty: () => ({ uses: {} }),
  decode: decodeLedger,
})

export function modelUseLedgerPath(home: string = getMercuryHome()): string {
  return join(home, MODEL_USE_LEDGER_FILE)
}

export function readModelUseLedger(home: string = getMercuryHome()): Record<string, ModelUseRecord> {
  try {
    return decodeLedger(JSON.parse(readFileSync(modelUseLedgerPath(home), 'utf8')) as unknown)?.uses ?? {}
  } catch {
    return {}
  }
}

export function recordModelUse(
  family: string,
  model: string,
  opts: { door?: string; home?: string; now?: () => number } = {},
): Promise<boolean> {
  const name = family.trim().toLowerCase()
  if (!FAMILY_RE.test(name) || model.trim() === '') return Promise.resolve(false)
  const record: ModelUseRecord = { at: opts.now?.() ?? Date.now(), model, ...(opts.door !== undefined && opts.door !== '' ? { door: opts.door } : {}) }
  return ledgerStore(opts.home ?? getMercuryHome())
    .mutate(current => ({ uses: { ...current.uses, [name]: record } }))
    .then(() => true, () => false)
}
