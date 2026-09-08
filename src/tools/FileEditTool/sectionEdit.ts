
export type SectionPlan =
  | { ok: true; updated: string; start: number; end: number; sectionText: string }
  | { ok: false; message: string }

const HEADING = /^ {0,3}(#{1,6})(?:[\t ]+|$)/

export function sectionHeadings(content: string): { line: number; level: number; heading: string }[] {
  const rows = content.split('\n')
  const headings: { line: number; level: number; heading: string }[] = []
  let fence: { char: string; length: number } | null = null
  let paragraphStart: number | null = null
  rows.forEach((text, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text)
    if (fence !== null) {
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.length && marker[2]!.trim() === '') fence = null
      paragraphStart = null
      return
    }
    if (marker && (marker[1]![0] !== '`' || !marker[2]!.includes('`'))) {
      fence = { char: marker[1]![0]!, length: marker[1]!.length }
      paragraphStart = null
      return
    }
    const atx = HEADING.exec(text)
    if (atx) {
      headings.push({ line: index + 1, level: atx[1]!.length, heading: text.trim().replace(/[\t ]+#+[\t ]*$/, '') })
      paragraphStart = null
      return
    }
    const setext = /^ {0,3}(=+|-+)[\t ]*$/.exec(text)
    if (setext && paragraphStart !== null) headings.push({ line: paragraphStart, level: setext[1]![0] === '=' ? 1 : 2, heading: rows.slice(paragraphStart - 1, index).join('\n').trim() })
    if (text.trim() === '' || setext || /^(?: {4}|\t)/.test(text)) paragraphStart = null
    else paragraphStart ??= index + 1
  })
  return headings
}

export function planAppend(content: string, text: string): string {
  if (content === '') return text
  return content.endsWith('\n') ? content + text : content + '\n' + text
}

export function findSection(content: string, heading: string): { ok: true; start: number; end: number } | { ok: false; message: string } {
  const wanted = heading.trim().replace(/[\t ]+#+[\t ]*$/, '')
  const level = HEADING.exec(wanted)
  if (!level) {
    return { ok: false, message: `section must be a Markdown heading line (\"## Name\", up to six #), got: ${JSON.stringify(heading)}` }
  }
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  const headings = sectionHeadings(content)
  const hits = headings.filter(row => row.heading === wanted).map(row => row.line)
  if (hits.length === 0) {
    return { ok: false, message: `section heading not found in the file: ${JSON.stringify(wanted)}` }
  }
  if (hits.length > 1) {
    return { ok: false, message: `the heading ${JSON.stringify(wanted)} occurs ${hits.length} times (lines ${hits.join(', ')}) — make it unique before editing by section` }
  }
  const start = hits[0]!
  const depth = level[1]!.length
  const end = (headings.find(row => row.line > start && row.level <= depth)?.line ?? lines.length + 1) - 1
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
