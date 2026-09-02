
import type { ToolEffect } from '../../Tool.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export const CHANGE_CONTRACT_VERSION = 1

export interface ChangeSnapshot {
  path: string
  anchor: string
  byteLength: number
  observedAt: number
  range?: { startLine: number; lineCount: number }
}

export interface ChangeIntent {
  source: string
  operation: string
  targetPaths: string[]
  expectedAnchor?: string
  targetVersions?: { path: string; version: string }[]
}

export interface ChangeReceipt {
  version: typeof CHANGE_CONTRACT_VERSION
  seq: number
  id: string
  owner: OwnerKey
  toolName: string
  toolUseId: string | undefined
  startedAt: number
  completedAt: number
  intent: ChangeIntent
  effect: ToolEffect
}

const MUTATION_OPERATION_PREFIXES = [
  'file.',
  'notebook.',
  'lsp.rename',
  'lsp.codeAction',
  'lsp.pathRename',
  'workshop.',
  'structure.apply',
  'git.commit',
  'git.stage',
  'git.restore',
  'git.resolve',
] as const

export function isMutationOperation(operation: string): boolean {
  return MUTATION_OPERATION_PREFIXES.some(p => operation.startsWith(p))
}

export function isReceiptShaped(effect: ToolEffect): boolean {
  return effect.changedPaths.length > 0 || isMutationOperation(effect.operation)
}

export function changeTransactionEnabled(): boolean {
  return !isEnvDefinedFalsy(flagEnv('MERCURY_CHANGE_RECEIPTS'))
}
