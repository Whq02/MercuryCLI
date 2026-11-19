import type { Input } from './schema.js'
import { fileCount } from './upload.js'

export function sentByEmulation(input: Input): { words: string; headers: boolean; username?: string; secretRef?: string } | null {
  const emulation = input?.emulation as { headers?: unknown; credentials?: unknown } | undefined
  const headers = emulation?.headers !== undefined && emulation.headers !== null
  const credentials = emulation?.credentials !== undefined && emulation.credentials !== null
  if (!headers && !credentials) return null
  const secretRef = credentials ? (emulation!.credentials as { secret?: unknown }).secret : undefined
  const username = credentials ? (emulation!.credentials as { username?: string }).username : undefined
  return {
    words: [headers ? 'extra headers sent on every request, including other origins' : '', credentials ? `basic credentials for ${username}` : ''].filter(Boolean).join(' and '),
    headers,
    username,
    ...(typeof secretRef === 'string' ? { secretRef } : {}),
  }
}

export function actDetail(input: Input): string {
  switch (input.op) {
    case 'viewport':
      return ` with ${sentByEmulation(input)?.words ?? 'emulation'}`
    case 'click':
      return ` ${input.selector ?? `(${input.x}, ${input.y})`}`
    case 'type':
      if (input.secretRef !== undefined) return ` secret ${input.secretRef} into ${input.selector ?? '(focused element)'}`
      return ` ${(input.text ?? '').length} chars into ${input.selector ?? '(focused element)'}`
    case 'scroll':
      return ` ${input.selector ?? `by ${input.dy}`}`
    case 'select':
      return ` ${input.selector} ← [${(input.values ?? []).join(', ')}]`
    case 'press':
      return ` ${[...(input.modifiers ?? []), input.key ?? ''].filter(Boolean).join('+')}`
    case 'hover':
      return ` ${input.selector}`
    case 'upload':
      return ` ${(input.files ?? []).length === 1 ? input.files![0] : fileCount((input.files ?? []).length)} to ${input.selector}`
    default:
      return ''
  }
}
