import type { SampleMarksV1, SamplePinV1, SampleRecordV1, SampleVerdict } from './contracts.js'

const MAX_PINS = 200
const MAX_TARGET_CHARS = 160
const MAX_TEXT_CHARS = 2000
const MAX_NOTE_CHARS = 4000

export function parseMarksBody(raw: unknown, latestVersion: number): SampleMarksV1 | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const body = raw as Record<string, unknown>
  const version = body.version
  if (!Number.isInteger(version) || (version as number) < 1 || (version as number) > latestVersion) return null
  if (!Array.isArray(body.pins) || body.pins.length > MAX_PINS) return null
  const pins: SamplePinV1[] = []
  for (const entry of body.pins as unknown[]) {
    if (entry === null || typeof entry !== 'object') return null
    const pin = entry as Record<string, unknown>
    if (typeof pin.x !== 'number' || typeof pin.y !== 'number' || !Number.isFinite(pin.x) || !Number.isFinite(pin.y)) return null
    if (typeof pin.text !== 'string') return null
    pins.push({
      x: clamp01(pin.x),
      y: clamp01(pin.y),
      target: oneLine(typeof pin.target === 'string' ? pin.target : '', MAX_TARGET_CHARS) || 'the page',
      text: oneLine(pin.text, MAX_TEXT_CHARS),
    })
  }
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_NOTE_CHARS) : ''
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') return null
  let verdict: SampleVerdict
  if (body.verdict === undefined || body.verdict === null) verdict = null
  else if (body.verdict === 'approve' || body.verdict === 'changes-needed') verdict = body.verdict
  else return null
  return { version: version as number, pins, note, verdict }
}

export function verdictWord(verdict: SampleVerdict): string {
  if (verdict === 'approve') return 'approved'
  if (verdict === 'changes-needed') return 'changes needed'
  return 'no verdict'
}

export function formatMarksMessage(record: Pick<SampleRecordV1, 'title'>, marks: SampleMarksV1): string {
  const k = marks.pins.length
  const lines = [
    `Marks on ${record.title} v${marks.version}: ${k} ${k === 1 ? 'pin' : 'pins'} · ${marks.note ? '1 note' : 'no note'} · ${verdictWord(marks.verdict)}`,
    ...marks.pins.map(pin => `- at ${pin.target}: ${pin.text}`),
  ]
  if (marks.note) {
    if (k > 0) lines.push('')
    lines.push(marks.note)
  }
  return lines.join('\n')
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}
