export function getEditToolDescription(offered: ReadonlySet<string> | null = null, model?: string): string {
  void offered
  void model
  return 'Edits one text file in place: an exact string swapped for another, line-addressed hunks against a read snapshot, text appended, or a Markdown section replaced or appended to. Edits need current read coverage of the lines they touch; append needs none. A landed edit returns the changed lines with context, which count as read, and names any new syntax error.'
}
