
export type SectionPlan =
  | { ok: true; updated: string; start: number; end: number; sectionText: string }
  | { ok: false; message: string }

const HEADING = /^(#{1,6})\s+\S/

export function planAppend(content: string, text: string): string {
  if (content === '') return text
  return content.endsWith('\n') ? content + text : content + '\n' + text
}

export function findSection(content: string, heading: string): { ok: true; start: number; end: number } | { ok: false; message: string } {
  const wanted = heading.replace(/\s+$/, '')
  const level = HEADING.exec(wanted)
  if (!level) {
    return { ok: false, message: `section must be a Markdown heading line (\"## Name\", up to six #), got: ${JSON.stringify(heading)}` }
  }
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  const hits: number[] = []
  lines.forEach((line, index) => {
    if (line.replace(/\s+$/, '') === wanted) hits.push(index + 1)
  })
  if (hits.length === 0) {
    return { ok: false, message: `section heading not found in the file: ${JSON.stringify(wanted)}` }
  }
  if (hits.length > 1) {
    return { ok: false, message: `the heading ${JSON.stringify(wanted)} occurs ${hits.length} times (lines ${hits.join(', ')}) — make it unique before editing by section` }
  }
  const start = hits[0]!
  const depth = level[1]!.length
  let end = lines.length
  for (let i = start; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]!)
    if (m && m[1]!.length <= depth) {
      end = i
      break
    }
  }
  return { ok: true, start, end }
}

export function planSectionEdit(
  content: string,
  heading: string,
  op: { replace: string } | { append: string },
): SectionPlan {
  const found = findSection(content, heading)
  if (!found.ok) return found
  const hadTrailingNL = content.endsWith('\n')
  const lines = content.split('\n')
  if (hadTrailingNL) lines.pop()
  const sectionLines = lines.slice(found.start - 1, found.end)
  const sectionText = sectionLines.join('\n')
  const bodyLines = (text: string): string[] => {
    if (text === '') return []
    const body = text.endsWith('\n') ? text.slice(0, -1) : text
    return body.split('\n')
  }
  if ('replace' in op) {
    lines.splice(found.start - 1, found.end - found.start + 1, ...bodyLines(op.replace))
  } else {
    if (op.append === '') return { ok: false, message: 'append is empty — there is nothing to add to the section' }
    let last = found.end
    while (last > found.start && lines[last - 1]!.trim() === '') last--
    lines.splice(last, 0, ...bodyLines(op.append))
  }
  const updated = lines.length === 0 ? '' : lines.join('\n') + (hadTrailingNL ? '\n' : '')
  return { ok: true, updated, start: found.start, end: found.end, sectionText }
}
