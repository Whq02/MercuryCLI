import { z } from 'zod/v4'
import { visit } from 'jsonc-parser'
import { lazySchema } from '../lazySchema.js'

export const COMPAT_ENDPOINT_NAME = /^[a-z0-9-]{1,32}$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const RESERVED_HEADERS = /^(authorization|host|content-length|transfer-encoding|connection|content-type|accept)$/i
const headerName = () => z.string().regex(HEADER_NAME).refine(value => !RESERVED_HEADERS.test(value), 'the credential and transport own this header')
const baseUrl = () => z.string().refine(value => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}, 'baseUrl must be an http(s) URL without credentials, query or fragment')
const endpointShape = () => ({
  baseUrl: baseUrl().optional(),
  label: z.string().optional(),
  keyCommand: z.string().optional(),
  models: z.array(z.string().trim().min(1)).optional(),
  headers: z.record(headerName(), z.string().refine(value => !/[\r\n\0]/.test(value), 'header values cannot contain line breaks')).optional(),
  sessionAffinityHeader: headerName().optional(),
  dialect: z.enum(['chat-completions', 'responses', 'ollama', 'lmstudio', 'vllm', 'sglang', 'llamacpp']).optional(),
})

export const CompatEndpointSchema = lazySchema(() => z.object(endpointShape()).strict())
export const CompatProviderSchema = lazySchema(() => z.union([
  CompatEndpointSchema(),
  z.record(z.string().regex(COMPAT_ENDPOINT_NAME, 'endpoint names must match [a-z0-9-]{1,32}'), z.object({ ...endpointShape(), baseUrl: baseUrl() }).strict()),
]))

export type CompatProviderSettings = z.infer<ReturnType<typeof CompatProviderSchema>>
export interface CompatEndpointSettings {
  baseUrl?: string
  label?: string
  keyCommand?: string
  models?: string[]
  headers?: Record<string, string>
  sessionAffinityHeader?: string
  dialect?: 'chat-completions' | 'responses' | 'ollama' | 'lmstudio' | 'vllm' | 'sglang' | 'llamacpp'
}

export function duplicateCompatEndpointNames(raw: string): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  visit(raw, {
    onObjectProperty: (property, _offset, _length, _line, _character, path) => {
      if (path().length !== 1 || path()[0] !== 'compatProvider') return
      if (seen.has(property)) duplicates.add(property)
      seen.add(property)
    },
  })
  return [...duplicates]
}
