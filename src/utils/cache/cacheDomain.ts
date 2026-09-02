// ============================================================================
//  cacheDomain — the ONE cache-domain owner (.5.2; +,
//  E01-E04).
//
//  The prompt cache key was session-scoped (`mercury:sessionId:agentId`) —
//  deliberate at the time (the 2.0 disposition), but it guaranteed a COLD
//  cache for every fresh process: a headless box running compatible `-p`
//  calls back-to-back re-paid the full prefix every time. The domain key is
//  an OPAQUE STABLE digest over exactly what cache compatibility means:
//
//    provider+account SCOPE (kind, never a raw account id) · served model ·
//    canonical project identity (digested, never a raw path) · the behavior-
//    contract digest (the 3.1 prefix instrument's domain digest — the exact
//    serialized cacheable prefix identity) · the tool-schema digest · the
//    resolved profile id · a cache-format version for deliberate rotation.
//
//  NEVER in the key: sessionId, raw paths, raw account identifiers, prompt
//  text, credentials, or the clock. Two fresh compatible processes therefore
//  mint the SAME key and reuse (E01-E02); any real compatibility change
//  (model, project, tools, contract) moves it (E03-E04).
//
//  Pure — node:crypto only.
// ============================================================================

import { createHash } from 'node:crypto'

/** Deliberate rotation lever: bump when the cache-compatible wire shape
 *  changes in a way the inputs below cannot see. */
export const CACHE_DOMAIN_FORMAT_VERSION = 1

export interface CacheDomainInputs {
  /** Provider + account KIND ('openai:chatgpt-subscription', 'openai:api-key'
   *  …) — scope, never identity. */
  providerScope: string
  /** The served model id. */
  servedModel: string
  /** The canonical project path — digested here; never emitted raw. */
  projectPath: string
  /** The behavior-contract digest (prefixFingerprint.domainDigest — the
   *  serialized cacheable-prefix identity). */
  behaviorContractDigest: string
  /** The tool-schema digest (same instrument, tools segment). */
  toolSchemaDigest: string
  /** The resolved harness/agent profile id, when one is armed. */
  profileId?: string
}

/** Mint the opaque stable domain key. */
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
