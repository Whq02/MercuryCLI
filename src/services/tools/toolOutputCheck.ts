import type { Tool } from '../../Tool.js'

const MISMATCH_CHARS = 400
const MISMATCH_ISSUES = 5

type Verdict = { success: boolean; error?: { issues?: Array<{ path?: PropertyKey[]; message?: string }> } }

export function outputSchemaMismatch(tool: Pick<Tool, 'outputSchema'>, data: unknown): string | undefined {
  const schema = tool.outputSchema
  if (schema === undefined) return undefined
  let verdict: unknown
  try {
    verdict = schema.safeParse(data)
  } catch (error) {
    return `the declared output schema could not judge the result (${error instanceof Error ? error.message : String(error)})`
  }
  if (typeof verdict !== 'object' || verdict === null) return 'the result does not match the declared output schema'
  const judged = verdict as Verdict
  if (judged.success === true) return undefined
  const issues = (Array.isArray(judged.error?.issues) ? judged.error.issues : [])
    .slice(0, MISMATCH_ISSUES)
    .map(issue => `${(issue.path ?? []).map(String).join('.') || '(root)'}: ${issue.message ?? 'invalid'}`)
  const text = issues.length > 0 ? issues.join('; ') : 'the result does not match the declared output schema'
  return text.length > MISMATCH_CHARS ? `${text.slice(0, MISMATCH_CHARS)}…` : text
}
