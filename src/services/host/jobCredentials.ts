import { randomUUID } from 'node:crypto'
import { clearAuthScope, getAuthConfigHomeDir, getAuthScope, setAuthScope } from '../../utils/envUtils.js'
import { resolveHuggingfaceApiKey } from '../providers/huggingface/huggingfaceAccounts.js'
import { readHostCredential, removeHostCredential, writeHostCredential } from '../providers/providerSecrets.js'

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
  const previous = getAuthScope()
  try {
    setAuthScope(reference.home)
    const credential = resolveHuggingfaceApiKey({})
    if (!credential) throw new Error('The saved Hugging Face sign-in for this job is unavailable. Connect Hugging Face and start the job again.')
    return credential
  } finally { if (previous === undefined) clearAuthScope(); else setAuthScope(previous) }
}

export function captureHostHuggingfaceCredential(record: CredentialRecord): HostHuggingfaceCredential | undefined {
  const reference = record.huggingfaceCredential
  if (reference && (reference.source === 'stored' || reference.job === record.id)) return reference
  const credential = reference ? hostHuggingfaceCredential(record) : resolveHuggingfaceApiKey()
  if (!credential) return
  const home = reference?.home ?? getAuthConfigHomeDir()
  if (!reference && 'source' in credential && credential.source !== 'env') return { home, source: 'stored' }
  const id = randomUUID()
  writeHostCredential(home, id, credential.key)
  return { home, source: 'captured', id, job: record.id }
}

export function releaseHostHuggingfaceCredential(record: CredentialRecord): void {
  const reference = record.huggingfaceCredential
  if (reference?.source === 'captured' && reference.job === record.id) removeHostCredential(reference.home, reference.id)
}
