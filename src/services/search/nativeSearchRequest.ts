
export interface NativeWebSearchRequest {
  allowedDomains?: string[]
  blockedDomains?: string[]
  maxUses: number
}

export const NATIVE_SEARCH_FAMILIES = ['anthropic', 'openai'] as const
export type NativeSearchFamily = (typeof NATIVE_SEARCH_FAMILIES)[number]

export function isNativeSearchFamily(route: string): route is NativeSearchFamily {
  return (NATIVE_SEARCH_FAMILIES as readonly string[]).includes(route)
}
