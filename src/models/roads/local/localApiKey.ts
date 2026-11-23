import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { readStoredLocalApiKey } from '../../sign-in/account-ledger/providerSecrets.js'
import { resolveProviderKeyCommand } from '../providerKeyCommand.js'
import { tensorFoldHostKey, tensorFoldHostRoot } from './tensorfoldHosts.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { hostEnv } from '../../../platform/environment/hostEnv.js'

export function resolveLocalApiKey(
  env: Record<string, string | undefined> = hostEnv(),
): { key: string; source: 'env' | 'stored' } | undefined {
  const envKey = flagEnv('MERCURY_LOCAL_API_KEY', env)?.trim()
  if (envKey) return { key: envKey, source: 'env' }
  const fromCommand = resolveProviderKeyCommand('local')
  if (fromCommand) return { key: fromCommand, source: 'stored' }
  const stored = readStoredLocalApiKey()
  return stored ? { key: stored, source: 'stored' } : undefined
}

export type LocalApiKeyReads = {
  hostKey?: (root: string) => string | undefined
  sharedKey?: (root: string) => string | undefined
}

const LOOPBACK_ROOT = /^http:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0):(\d+)$/

export function sharedTensorFoldKey(root: string): string | undefined {
  const port = Number(LOOPBACK_ROOT.exec(root)?.[2])
  if (!Number.isInteger(port) || port <= 0) return undefined
  try {
    const { readServedRecord } = require('../../tensorfold/serve.js') as typeof import('../../tensorfold/serve.js')
    const { readTensorFoldKeyFile } = require('./tensorfoldKeyFile.js') as typeof import('./tensorfoldKeyFile.js')
    const served = readServedRecord()
    if (served === null || served.port !== port || served.keyFile === undefined) return undefined
    return readTensorFoldKeyFile(served.keyFile)?.key
  } catch (error) {
    passedOver(error)
    return undefined
  }
}

export function resolveLocalApiKeyFor(
  baseUrl: string,
  env: Record<string, string | undefined> = hostEnv(),
  reads: LocalApiKeyReads = {},
): { key: string; source: 'env' | 'stored' | 'host' | 'shared' } | undefined {
  const root = tensorFoldHostRoot(baseUrl)
  try {
    const hostKey = (reads.hostKey ?? tensorFoldHostKey)(root)
    if (hostKey !== undefined) return { key: hostKey, source: 'host' }
  } catch (error) {
    passedOver(error)
  }
  const shared = (reads.sharedKey ?? sharedTensorFoldKey)(root)
  if (shared !== undefined) return { key: shared, source: 'shared' }
  return resolveLocalApiKey(env)
}
