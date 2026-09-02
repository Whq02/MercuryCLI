import { createHash } from 'node:crypto'
import type { LocalCommandCall } from '../../types/command.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import {
  type BuildCardInput,
  type WriteCardResult,
  experienceCardsEnabled,
  writeExperienceCard,
} from '../../memdir/experienceCards.js'


function contentHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 6)
}

export function deriveSlug(seed: string, disambiguator?: string): string {
  const base =
    (seed || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .filter(Boolean)
      .slice(0, 6)
      .join('-')
      .slice(0, 48) || 'note'
  const suffix = contentHash((disambiguator ?? seed).trim())
  let slug = `${base}-${suffix}`
  if (!/^[a-z0-9]/.test(slug)) slug = `n${slug}`
  return slug.slice(0, 64)
}

const CLASS_PREFIX_RE = /^([a-z0-9][a-z0-9-]{1,31}):\s+(\S[\s\S]*)$/

export function buildRememberInput(lesson: string, createdAt: string): BuildCardInput {
  const trimmed = lesson.trim()
  const m = CLASS_PREFIX_RE.exec(trimmed)
  const problemClass = m ? m[1] : 'operator-note'
  const body = (m ? m[2] : trimmed).trim()
  const firstLine = (body.split('\n')[0] ?? '').trim() || body
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  return {
    name: deriveSlug(firstLine, `${problemClass}\n${body}`),
    title: clip(firstLine, 64),
    summary: clip(firstLine, 120),
    problemClass,
    lesson: body,
    sourceRefs: [],
    approved: false,
    createdAt,
  }
}

export async function bankLesson(memoryDir: string, lesson: string): Promise<WriteCardResult> {
  const input = buildRememberInput(lesson, new Date().toISOString())
  return writeExperienceCard(memoryDir, input, {
    signal: { operatorSignal: true, greenGatePassed: false, lesson: lesson.trim() },
  })
}

export const call: LocalCommandCall = async (args, _context) => {
  const lesson = (args ?? '').trim()
  const scoped = CLASS_PREFIX_RE.exec(lesson)
  if (scoped && scoped[1] === 'project') {
    const { captureProjectInstruction, describeCaptureResult } = await import(
      '../../services/instructions/projectInstructionWriter.js'
    )
    const { getCwd } = await import('../../utils/cwd.js')
    const result = captureProjectInstruction({ cwd: getCwd(), rule: scoped[2] ?? '' })
    return { type: 'text', value: describeCaptureResult(result) }
  }
  if (!lesson) {
    return { type: 'text', value: 'Usage: `/remember <a transferable lesson worth keeping across sessions>` — or `/remember project: <a durable convention for THIS project>` to record it in the project instruction estate (MERCURY.md or its pointed guide).' }
  }
  if (!experienceCardsEnabled()) {
    return { type: 'text', value: 'Experience-card memory is off this session (MERCURY_EXPERIENCE_CARDS=0) — nothing banked.' }
  }
  if (!isAutoMemoryEnabled()) {
    return { type: 'text', value: 'Auto-memory is disabled this session — cannot bank a lesson.' }
  }
  const res = await bankLesson(getAutoMemPath(), lesson)
  if (res.ok) {
    const { title, problemClass } = buildRememberInput(lesson, res.path)
    return {
      type: 'text',
      value: `Banked "${title}" [${problemClass}] → ${res.path} — a candidate lesson; it surfaces in recall marked unverified until you promote it.${res.indexUpdated ? ' Indexed in MEMORY.md.' : ''}`,
    }
  }
  const why: Record<string, string> = {
    'secret-bearing': 'it looked secret-bearing — refused (defense in depth)',
    skipped: 'it is too short / not a transferable lesson',
    duplicate: 'a near-duplicate lesson is already banked',
    'invalid-input': 'the derived card was invalid',
    'supersede-failed': 'the prior copy could not be preserved',
  }
  const reason = 'reason' in res && res.reason ? ` — ${res.reason}` : ''
  return { type: 'text', value: `Did not bank it: ${why[res.blocked] ?? res.blocked}${reason}.` }
}
