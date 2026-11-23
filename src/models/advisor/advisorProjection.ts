export const ADVISOR_INCOMPLETE_EVIDENCE_RULE = 'A marker such as "… [N more characters not shown]", "[N earlier rows; M characters not shown]", or a tool\'s own truncation marker means you did not see the whole evidence, even if the tool\'s header says it returned a complete file. Never raise a correction based on what might lie past a marker or outside the shown conversation window. Absence from this view is not evidence that a declaration, argument, result or action is missing. If a question depends on unseen text, say you could not see it; on a routine look, answer "carry on" unless a separate visible fact warrants a note. Corrections need a contradiction in the visible evidence, not recalled source code or an earlier advisor claim.'

export function clipAdvisorText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters not shown]` : text
}

export function serializeAdvisorInput(input: unknown, maxStringChars: number): string {
  return JSON.stringify(input ?? {}, (_key, value: unknown) => typeof value === 'string' ? clipAdvisorText(value, maxStringChars) : value)
}

export function advisorTranscriptTail(rows: readonly string[], max: number): string {
  let start = rows.length
  let length = 0
  while (start > 0) {
    const next = rows[start - 1]!.length + (start < rows.length ? 1 : 0)
    if (start < rows.length && length + next > max) break
    length += next
    start--
  }
  const text = rows.slice(start).join('\n')
  if (start === 0) return text
  const omitted = rows.slice(0, start).reduce((total, row) => total + row.length + 1, 0)
  return `[${start} earlier rows; ${omitted} characters not shown]\n${text}`
}
