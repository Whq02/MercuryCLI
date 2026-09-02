// ============================================================================
//  services/search/nativeSearchRequest — the provider-NEUTRAL request a
//  search leg attaches to a model call when the main model's own provider
//  carries a search construct on its wire.
//
//  The tool never names a wire construct: it sets this one option on the
//  routed call, and each lane that HAS a native search maps it onto its own
//  spelling (the Anthropic lane's web_search_20250305 server tool; the
//  OpenAI Responses lane's hosted web_search tool). A lane without one
//  ignores it — but the search door never sends it there (the native door
//  opens only for the families in NATIVE_SEARCH_FAMILIES).
//
//  Dependency-free leaf: the Anthropic core's Options type imports it.
// ============================================================================

export interface NativeWebSearchRequest {
  allowedDomains?: string[]
  blockedDomains?: string[]
  /** How many searches the model may run inside the one call. */
  maxUses: number
}

/** The families whose wire carries a native search construct Mercury
 *  speaks — the selection law's native arm reads exactly this table. */
export const NATIVE_SEARCH_FAMILIES = ['anthropic', 'openai'] as const
export type NativeSearchFamily = (typeof NATIVE_SEARCH_FAMILIES)[number]

export function isNativeSearchFamily(route: string): route is NativeSearchFamily {
  return (NATIVE_SEARCH_FAMILIES as readonly string[]).includes(route)
}
