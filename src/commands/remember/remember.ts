import { createHash } from 'node:crypto'
import type { LocalCommandCall } from '../../types/command.js'
import { getAutoMemPath, isAutoMemoryEnabled } from '../../memdir/paths.js'
import {
  type BuildCardInput,
  type WriteCardResult,
  experienceCardsEnabled,
  writeExperienceCard,
} from '../../memdir/experienceCards.js'

// `/remember <lesson>` — bank a transferable lesson as an experience card at runtime.
// Closes the SEVERED write loop: the agent is told to bank lessons (doctrine) and can
// RECALL them (memoryScan), but writeExperienceCard had ZERO runtime callers — so nothing
// could ever be remembered mid-session. This drives the EXISTING hardened production path
// (shouldDistill → buildExperienceCard → writeExperienceCard): refuses secrets, dedups
// near-duplicates, and ALWAYS writes a CANDIDATE (approved:false) the operator promotes
// later. operatorSignal:true is the legitimate trigger (/remember is an explicit ask).

/** Short DETERMINISTIC content hash for the slug suffix (replaces the former
 *  Date.now() suffix). Mirrors experienceCards.ts's shortHash shape (sha1 hex),
 *  just shorter so the slug stays compact. */
function contentHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 6)
}

/**
 * Derive a kebab-case slug (BuildCardInput.name must match ^[a-z0-9][a-z0-9-]{1,63}$).
 * The suffix is a DETERMINISTIC content hash of `disambiguator` (falling back to the
 * seed) — NOT Date.now() — so the SAME lesson always derives the SAME slug. A re-bank
 * then collides on the same filename and routes through the supersede/dedup paths
 * deterministically, instead of accumulating duplicate cards whenever the dedup guard
 * (MERCURY_CARD_DEDUP) is off. Callers pass the lesson-bearing key (e.g. problemClass+body)
 * as the disambiguator so near-identical lessons map to one stable name.
 */
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

// A leading `<problemClass>: <lesson>` override on /remember free-text. Deliberately
// CONSERVATIVE — a lowercase kebab token only (matching the `problemClass` convention,
// "short kebab category") so ordinary prose like `Note: …` (capitalized) or a
// mid-sentence colon is NEVER mis-read as a class. The derived class is echoed back in
// the command result, so a rare mis-parse is immediately visible (and re-bankable).
const CLASS_PREFIX_RE = /^([a-z0-9][a-z0-9-]{1,31}):\s+(\S[\s\S]*)$/

/** Build the candidate-card input from operator free-text (lossy quick-capture; promotable).
 *  A leading `<problemClass>: ` kebab prefix (see CLASS_PREFIX_RE) overrides the default
 *  'operator-note' class and is stripped from the card title/summary/body. */
export function buildRememberInput(lesson: string, createdAt: string): BuildCardInput {
  const trimmed = lesson.trim()
  const m = CLASS_PREFIX_RE.exec(trimmed)
  const problemClass = m ? m[1] : 'operator-note'
  const body = (m ? m[2] : trimmed).trim()
  const firstLine = (body.split('\n')[0] ?? '').trim() || body
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  return {
    // Disambiguate the slug by problemClass + body so identical lessons map to one stable
    // name (deterministic supersede/dedup, not Date.now() accumulation).
    name: deriveSlug(firstLine, `${problemClass}\n${body}`),
    title: clip(firstLine, 64),
    summary: clip(firstLine, 120),
    problemClass,
    lesson: body,
    sourceRefs: [],
    approved: false, // born a candidate — the operator promotes to trust
    createdAt,
  }
}

/** The write half — testable with an injected memoryDir (so a proof never touches real memory). */
export async function bankLesson(memoryDir: string, lesson: string): Promise<WriteCardResult> {
  const input = buildRememberInput(lesson, new Date().toISOString())
  return writeExperienceCard(memoryDir, input, {
    signal: { operatorSignal: true, greenGatePassed: false, lesson: lesson.trim() },
  })
}

export const call: LocalCommandCall = async (args, _context) => {
  const lesson = (args ?? '').trim()
  // The PROJECT scope: `/remember project: <rule>` records a durable project
  // convention into the instruction estate through the ONE shared writer
  // (services/instructions/projectInstructionWriter.ts) — the same module the
  // agent's organic capture drives — never an experience card. `project` is a
  // reserved class prefix; every other prefix keeps its card meaning.
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
    // Echo the derived title + problemClass (free-text → title/summary/class is otherwise
    // silent) so the operator sees exactly what was captured — and catches a mis-parsed
    // `<class>:` prefix at a glance. Re-derived from the same pure builder (display only).
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
