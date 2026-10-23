import { randomUUID } from 'node:crypto'
import { getAuthConfigHomeDir, withAuthScope } from '../../utils/envUtils.js'
import { refreshHuggingfaceTokens, resolveHuggingfaceApiKey, resolveHuggingfaceDispatchCredential } from '../providers/huggingface/huggingfaceAccounts.js'
import { readHostCredential, removeHostCredential, writeHostCredential } from '../providers/providerSecrets.js'
import { configuredProviderKeyCommand } from '../providers/providerKeyCommand.js'

export type HostHuggingfaceCredential = { home: string; source: 'stored' } | { home: string; source: 'captured'; id: string; job: string }
type CredentialRecord = { id: string; huggingfaceCredential?: HostHuggingfaceCredential }

export function hostHuggingfaceCredential(record: CredentialRecord): { key: string } | undefined {
  const reference = record.huggingfaceCredential
  if (!reference) return resolveHuggingfaceApiKey()
  if (reference.source === 'captured') {
    const key = readHostCredential(reference.home, reference.id)
    if (!key) throw new Error('The saved Hugging Face credential for this job is unavailable. Connect Hugging Face and start the job again.')
    return { key }
  }
  return withAuthScope(reference.home, () => {
    const credential = resolveHuggingfaceApiKey({})
    if (!credential) throw new Error('The saved Hugging Face sign-in for this job is unavailable. Connect Hugging Face and start the job again.')
    return credential
  })
}

export async function hostHuggingfaceDispatchCredential(record?: CredentialRecord, refresh = false): Promise<{ key: string } | undefined> {
  const reference = record?.huggingfaceCredential
  if (reference?.source === 'captured') return refresh ? undefined : hostHuggingfaceCredential(record!)
  return withAuthScope(reference?.home ?? getAuthConfigHomeDir(), async () => {
    const env = reference ? { ...process.env, HF_TOKEN: undefined } : process.env
    if (refresh) {
      if (resolveHuggingfaceApiKey(env)?.source !== 'oauth') return
      const fresh = await refreshHuggingfaceTokens({ env })
      return fresh ? { key: fresh.accessToken } : undefined
    }
    const credential = await resolveHuggingfaceDispatchCredential({ env })
    return credential ? { key: credential.apiKey } : undefined
  })
}
export function captureHostHuggingfaceCredential(record: CredentialRecord): HostHuggingfaceCredential | undefined {
  const reference = record.huggingfaceCredential
  if (reference && (reference.source === 'stored' || reference.job === record.id)) return reference
  const credential = reference ? hostHuggingfaceCredential(record) : resolveHuggingfaceApiKey()
  if (!credential) return
  const home = reference?.home ?? getAuthConfigHomeDir()
  if (!reference && 'source' in credential && credential.source !== 'env' && !(credential.source === 'stored' && configuredProviderKeyCommand('huggingface'))) return { home, source: 'stored' }
  const id = randomUUID()
  writeHostCredential(home, id, credential.key)
  return { home, source: 'captured', id, job: record.id }
}

export function releaseHostHuggingfaceCredential(record: CredentialRecord): void {
  const reference = record.huggingfaceCredential
  if (reference?.source === 'captured' && reference.job === record.id) removeHostCredential(reference.home, reference.id)
}
