import { isOneOf } from '../../../platform/primitives/isOneOf.js'

export interface NativeWebSearchRequest {
  allowedDomains?: string[]
  blockedDomains?: string[]
  maxUses: number
}

const NATIVE_SEARCH_FAMILIES = ['anthropic', 'openai'] as const
export type NativeSearchFamily = (typeof NATIVE_SEARCH_FAMILIES)[number]

export function isNativeSearchFamily(route: string): route is NativeSearchFamily {
  return isOneOf(NATIVE_SEARCH_FAMILIES, route)
}
