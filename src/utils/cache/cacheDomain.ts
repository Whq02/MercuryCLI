
import { createHash } from 'node:crypto'

export const CACHE_DOMAIN_FORMAT_VERSION = 1

export interface CacheDomainInputs {
  providerScope: string
  servedModel: string
  projectPath: string
  behaviorContractDigest: string
  toolSchemaDigest: string
  profileId?: string
}

export function mintCacheDomainKey(i: CacheDomainInputs): string {
  const digest = createHash('sha256')
    .update(
      [
        `v${CACHE_DOMAIN_FORMAT_VERSION}`,
        i.providerScope,
        i.servedModel,
        createHash('sha256').update(i.projectPath).digest('hex').slice(0, 16),
        i.behaviorContractDigest,
        i.toolSchemaDigest,
        i.profileId ?? '',
      ].join('\u0000'),
    )
    .digest('hex')
    .slice(0, 24)
  return `mercury-domain:${digest}`
}
