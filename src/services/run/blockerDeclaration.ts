
export type BlockerDeclarationParse =
  | { kind: 'none' }
  | { kind: 'declared'; description: string; resumeCondition: string }
  | { kind: 'refused'; reason: string }

export const BLOCKER_DECLARATION_GRAMMAR =
  '"BLOCKED ON OPERATOR: <what you need>" then "RESUME WHEN: <what unblocks you>" (two lines, ending the message)'

const MARKER_RE = /^blocked on operator\s*:\s*(.*)$/i
const RESUME_RE = /^resume when\s*:\s*(.*)$/i

export const MIN_FIELD_WORDS = 3

export const MAX_FIELD_CHARS = 280

function stripLineDecoration(line: string): string {
  return line
    .replace(/^[\s>*_`#-]+/, '')
    .replace(/[\s*_`]+$/, '')
    .trim()
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length
}

function clamp(s: string): string {
  return s.length > MAX_FIELD_CHARS ? `${s.slice(0, MAX_FIELD_CHARS - 1)}…` : s
}

export function parseBlockerDeclaration(text: string): BlockerDeclarationParse {
  const lines = text.split('\n')
  let markerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (MARKER_RE.test(stripLineDecoration(lines[i]!))) {
      markerIdx = i
      break
    }
  }
  if (markerIdx === -1) return { kind: 'none' }

  const description = stripLineDecoration(lines[markerIdx]!).match(MARKER_RE)![1]!.trim()

  let resumeIdx = -1
  for (let i = markerIdx + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '') continue
    resumeIdx = i
    break
  }
  if (resumeIdx === -1) {
    return { kind: 'refused', reason: 'missing the "RESUME WHEN: <what unblocks you>" line' }
  }
  const resumeMatch = stripLineDecoration(lines[resumeIdx]!).match(RESUME_RE)
  if (!resumeMatch) {
    return {
      kind: 'refused',
      reason: 'the line after BLOCKED ON OPERATOR must be "RESUME WHEN: <what unblocks you>"',
    }
  }
  const resumeCondition = resumeMatch[1]!.trim()

  for (let i = resumeIdx + 1; i < lines.length; i++) {
    if (lines[i]!.trim() !== '') {
      return { kind: 'refused', reason: 'the declaration must be the final lines of the message' }
    }
  }

  if (wordCount(description) < MIN_FIELD_WORDS) {
    return {
      kind: 'refused',
      reason: `the blocker description needs substance (≥${MIN_FIELD_WORDS} words naming exactly what you need)`,
    }
  }
  if (wordCount(resumeCondition) < MIN_FIELD_WORDS) {
    return {
      kind: 'refused',
      reason: `the resume condition needs substance (≥${MIN_FIELD_WORDS} words naming what unblocks you)`,
    }
  }

  return { kind: 'declared', description: clamp(description), resumeCondition: clamp(resumeCondition) }
}
