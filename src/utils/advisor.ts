import type { NonNullableUsage } from '../entrypoints/sdk/coreTypes.js'

export type AdvisorServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'advisor'
  input: unknown
}

export type AdvisorToolResultBlock = {
  type: 'advisor_tool_result'
  tool_use_id: string
  content:
    | { type: 'advisor_result'; text: string }
    | { type: 'advisor_redacted_result'; encrypted_content: string }
    | { type: 'advisor_tool_result_error'; error_code: string }
}

export type AdvisorBlock = AdvisorServerToolUseBlock | AdvisorToolResultBlock

export function isAdvisorBlock(param: { type: string; name?: string }): param is AdvisorBlock {
  return (
    param.type === 'advisor_tool_result' ||
    (param.type === 'server_tool_use' && param.name === 'advisor')
  )
}

type AdvisorUsageIteration = Partial<NonNullableUsage> & {
  type?: string
  model?: string
}

export function getAdvisorUsage(usage: unknown): Array<NonNullableUsage & { model: string }> {
  const iterations = (usage as { iterations?: AdvisorUsageIteration[] } | null | undefined)
    ?.iterations
  if (!Array.isArray(iterations)) return []
  return iterations.filter(
    (entry): entry is NonNullableUsage & { model: string; type: string } =>
      entry != null && entry.type === 'advisor_message',
  )
}
