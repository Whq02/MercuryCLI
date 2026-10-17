import type { Tool } from '../../Tool.js'

const MISMATCH_CHARS = 400
const MISMATCH_ISSUES = 5

type Verdict = { success: boolean; error?: { issues?: Array<{ path?: PropertyKey[]; message?: string }> } }

export function outputSchemaMismatch(tool: Pick<Tool, 'outputSchema'>, data: unknown): string | undefined {
  const schema = tool.outputSchema
  if (schema === undefined) return undefined
  let verdict: Verdict
  try {
    verdict = schema.safeParse(data) as Verdict
  } catch (error) {
    return `the declared output schema could not judge the result (${error instanceof Error ? error.message : String(error)})`
  }
  if (verdict.success) return undefined
  const issues = (verdict.error?.issues ?? [])
    .slice(0, MISMATCH_ISSUES)
    .map(issue => `${(issue.path ?? []).map(String).join('.') || '(root)'}: ${issue.message ?? 'invalid'}`)
  const text = issues.length > 0 ? issues.join('; ') : 'the result does not match the declared output schema'
  return text.length > MISMATCH_CHARS ? `${text.slice(0, MISMATCH_CHARS)}…` : text
}
