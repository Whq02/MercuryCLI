/**
 * Experience Cards — a default-ON (opt out =0) extension of the EXISTING memory
 * substrate (src/memdir). An Experience Card is an ordinary per-topic `.md`
 * memory file whose frontmatter carries `metadata.type: experience-card` plus
 * five lifecycle fields (problemClass, sourceRefs, confidence, freshness,
 * approved). It is NOT a parallel store, and it adds NO retrieval/scoring/
 * embedding engine — the model reading the prose MEMORY.md index is still the
 * retrieval (scanMemoryFiles + findRelevantMemories are unchanged).
 *
 * Methodology assimilated at doc level only (no code vendored, no deps) — see
 * the memory model:
 *   - distill-on-high-signal write path  (MemCoder / Swarm Skills / Memex(RL))
 *   - validated-before-trusted lifecycle (Meta-Harness / Adaptive Auto-Harness)
 *   - secret refusal = outcome-blind invariant (A.A-H) / entropy auditing (AHE)
 *   - "schema-valid != trusted"           (The Constraint Tax)
 *
 * Gating invariant: experienceCardsEnabled() = MERCURY_EXPERIENCE_CARDS !== '0' &&
 * ON by default (unconditional), opt out with the explicit =0.
 * When OFF (flag set to '0'), every helper used at a LIVE
 * call-site degrades to a no-op / identity, so the
 * prompt + recall output are byte-identical to a build without this module
 * (mirrors the getScribeModeSections() ⇒ [] discipline).
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join } from 'path'
import * as lockfile from '../utils/lockfile.js'
import { flagEnabled } from '../substrate/flagRegistry.js'
import { writeEvolutionRow } from '../utils/evolution/evolutionLedger.js'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { GLYPH } from '../components/mercury-ui/glyphs.js'
import { memoryAge, memoryAgeDays } from './memoryAge.js'
import { durableAtomicPublish } from '../substrate/durablePublish.js'

export const EXPERIENCE_CARD_TYPE = 'experience-card'
export const ENTRYPOINT_NAME = 'MEMORY.md'

/**
 * Live-behavior gate. WIRED LIVE for Mercury: ON by default, opt out with
 * MERCURY_EXPERIENCE_CARDS=0 (mirrors mercuryDoctrineEnabled's opt-out shape). Always
 * (Historical: it was OFF on bare-stamp builds via the retired version seam —
 * MACRO.VERSION), so a bare stamp is unaffected.
 *
 * all six card gates route through flagRegistry.flagEnabled() —
 * behavior-identical to the prior bespoke bodies (verified polarity match),
 * but registered-by-construction: the bespoke `process.env[NAMED_CONSTANT]`
 * bracket reads were structurally INVISIBLE to prove-flag-registry's dot-access
 * grep, so all six flags shipped unregistered while the registry
 * claimed completeness. The named *_ENV_FLAG constants stay exported for API
 * stability; the registry rows are the enforcement now.
 */
export function experienceCardsEnabled(): boolean {
  return flagEnabled('MERCURY_EXPERIENCE_CARDS')
}

/**
 * Non-destructive supersede on card writes. Mirrors versioning.py's invariant: a replaced version is PRESERVED
 * (kept on disk), never `reset --hard`, so a wrong self-edit is inspectable and
 * revertable. WIRED LIVE for Mercury — opt out `MERCURY_CARD_SUPERSEDE=0` (then a
 * rewrite clobbers in place, byte-identical to the prior behavior).
 */
export function cardSupersedeEnabled(): boolean {
  return flagEnabled('MERCURY_CARD_SUPERSEDE')
}

/**
 * Precision-biased recall. The
 * paper's catalog routing carries the artifact BODY (not just the name) because
 * name/description-only routing loses 31–44pp of accuracy. We enrich the recall
 * manifest's experience-card rows with their `problemClass` and add a
 * "prefer precision" clause to the selector. WIRED LIVE for Mercury — opt out
 * `MERCURY_CARD_RECALL_PRECISION=0` (then the manifest + selector prompt are
 * byte-identical to before).
 */
export function cardRecallPrecisionEnabled(): boolean {
  return flagEnabled('MERCURY_CARD_RECALL_PRECISION')
}

/**
 * Promote-gate (). The
 * paper's GatingStrategy validates a mutation at the ACCEPT/PROMOTE boundary
 * (candidate → trusted), not at create time. A terminal coding agent has no
 * holdout task-stream, so the transferable form is a DETERMINISTIC structural
 * gate (no scoring engine): a candidate may flip to `approved: true` only if it
 * is clean, fresh, properly scoped, and not a duplicate of an already-approved
 * sibling. WIRED LIVE for Mercury — opt out `MERCURY_CARD_PROMOTE_GATE=0` (then the
 * promote path is the bare frontmatter flip it is today, byte-identical).
 */
export function cardPromoteGateEnabled(): boolean {
  return flagEnabled('MERCURY_CARD_PROMOTE_GATE')
}

/**
 * Distill-time dedup (
 * the paper's EGL/skip-if-covered idea). Refuse writing a NEW card whose
 * problemClass + (normalized) lesson already match an existing non-superseded
 * card under a different name — prevents candidate bloat / near-duplicate cards.
 * Compares the normalized lesson prose (NOT the rendered body, which shares
 * identical Status/Source-refs/Green-gate boilerplate across all cards), and
 * excludes the card being rewritten + `.superseded.*` audit copies. WIRED LIVE
 * for Mercury — opt out `MERCURY_CARD_DEDUP=0` (then writes never dedup, identical).
 */
export function cardDedupEnabled(): boolean {
  return flagEnabled('MERCURY_CARD_DEDUP')
}

/**
 * Trace-ground the distilled lesson body (grounding rule:
 * ICML'26 workshop). The free-prose lesson body is the confabulation surface: a
 * green-gate pass grounds the WRITE-DECISION (shouldDistill on greenGatePassed) but
 * NOT the lesson CONTENT, which is the model's own story. Grounding the lesson in
 * captured execution signal lifted correct-object id 0%→86% and cut wrong-lesson
 * re-application. When ON, a green-gate distill must carry a non-empty `sourceRefs`
 * anchor (commit SHA / file paths) or it is refused — the lesson must point at real
 * captured signal, not a narrated story.
 *
 * DEFAULT-OFF — the INVERSE of the `=0`-opt-out card flags: active ONLY when
 * MERCURY_CARD_TRACE_GROUND is explicitly opted-IN ('1') AND on a Mercury build. OFF (the
 * default, or any other value) ⇒ shouldDistill is byte-identical
 * to before. Placed so the operatorSignal short-circuit fires FIRST — an operator-
 * banked / `/remember` card with a legit empty `sourceRefs` is NEVER blocked.
 *
 * the SAME knob now also arms the evidence HARVEST (the Socratic-SWE
 * half — evidenceHarvest.ts, wired in RememberLessonTool): on a green-gate bank,
 * the harness attaches a git-stat summary of the first SHA sourceRef + an argless
 * trace-tail aggregate as an "Evidence (harvested)" block. One flag, one
 * trace-grounding family: the anchor REQUIREMENT and the harvested PROOF travel
 * together. Proof: scripts/memory/prove-card-evidence-harvest.ts.
 */
export function cardTraceGroundEnabled(): boolean {
  return flagEnabled('MERCURY_CARD_TRACE_GROUND')
}

/** ISO → filesystem-safe stamp for the `.superseded.<stamp>.md` audit name. */
function supersedeStamp(iso: string): string {
  const safe = String(iso || '').replace(/[:.]/g, '-').replace(/[^0-9A-Za-z_-]/g, '')
  return safe || 'prev'
}

/** Short content hash so two supersedes with the same timestamp never collide
 *  (a same-second second rewrite would otherwise overwrite the first audit copy). */
function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 8)
}

/**
 * Preserve a prior card markdown as an in-tree `.superseded.<stamp>.<hash>.md`
 * audit copy (freshness flipped to `superseded`). Shared by the rewrite
 * (writeExperienceCard) and promote (promoteExperienceCard) paths. Does NOT
 * check the supersede flag — the caller guards with cardSupersedeEnabled().
 * THROWS on write failure so the caller can ABORT before clobbering an
 * un-preserved prior (the data-loss supersede exists to prevent). Returns the
 * path written.
 *
 * No-GC decision: these `.superseded.*.md` audit copies are written
 * per supersede and never pruned. This is DELIBERATE — they are EXCLUDED from
 * recall (the recall scanner only surfaces live cards), so they carry zero token
 * cost; they exist purely as an on-disk audit trail of every prior card version,
 * and supersedes are low-frequency (operator-driven rewrites), so unbounded
 * growth is not a practical concern. If a retention policy is ever wanted, bound
 * by newest-N / age here at the single write site.
 */
/**
 * Write `content` to `path` ATOMICALLY through the one durable publication
 * primitive (collision-free exclusive temp, fsync-before-rename, self-cleaning
 * failure path). A plain
 * writeFile here would let a crash mid-write leave a TORN markdown file that re-parses into
 * an UNVERIFIED card with no candidate banner.
 */
async function atomicWriteFile(path: string, content: string): Promise<void> {
  await durableAtomicPublish(path, content)
}

/**
 * Run `fn` under a per-card cross-process flock (proper-lockfile) so a read-prior →
 * writeSuperseded → write-canonical read-modify-write on ONE card slot is atomic
 * across processes — two writers of the same slug can't both read V0 and clobber.
 * Fail-open (a contended/absent lock — e.g. the card doesn't exist yet on a first
 * write — never blocks the write). BOTH supersede+write sites (writeExperienceCard,
 * promoteExperienceCard) use the SAME `${cardPath}.lock` so they mutually exclude.
 * Callers RELEASE this before touching the MEMORY.md index (serializeIndexUpdate's
 * own lock), keeping a single card-then-index acquisition order ⇒ no deadlock.
 */
async function withCardLock<T>(
  cardPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(cardPath, {
      lockfilePath: `${cardPath}.lock`,
      ...INDEX_LOCK_OPTIONS,
    })
  } catch {
    release = undefined
  }
  try {
    return await fn()
  } finally {
    if (release) await release().catch(() => {})
  }
}

export async function writeSupersededCopy(
  memoryDir: string,
  filename: string,
  priorMarkdown: string,
  stampSource: string,
): Promise<string> {
  const base = filename.replace(/\.md$/, '')
  const path = join(
    memoryDir,
    `${base}.superseded.${supersedeStamp(stampSource)}.${shortHash(priorMarkdown)}.md`,
  )
  // Lineage edge, backward direction (cf. "Governed Evolution"): the audit
  // copy names its replacement. The canonical filename is reused across
  // generations, so this resolves to the LIVE descendant; exact per-generation
  // lineage walks the forward `supersedes:` chain instead.
  await atomicWriteFile(
    path,
    stampLineageEdge(markSuperseded(priorMarkdown), 'supersededBy', filename),
  )
  return path
}

/**
 * Inject (or refresh) a lineage edge in a card's frontmatter — the queryable
 * half of the non-destructive supersede (cf. "Governed Evolution of Agent
 * Runtimes": record what replaced what in BOTH directions, not by filename
 * convention alone). Operates ONLY inside the leading `---` block, anchored on
 * the `freshness:` line the serializer always emits (its indentation is
 * reused, so the key lands inside the `metadata:` map). Best-effort like
 * markSuperseded: no frontmatter / no freshness line ⇒ content unchanged.
 */
function stampLineageEdge(
  markdown: string,
  key: 'supersedes' | 'supersededBy',
  target: string,
): string {
  const fmMatch = markdown.match(/^---\n[\s\S]*?\n---/)
  if (!fmMatch) return markdown
  const fm = fmMatch[0]
  const existing = new RegExp(`(\\n\\s*${key}:\\s*)[^\\n]*`)
  if (existing.test(fm)) {
    return markdown.replace(fm, fm.replace(existing, `$1${yamlScalar(target)}`))
  }
  const freshLine = fm.match(/\n(\s*)freshness:[^\n]*/)
  if (!freshLine) return markdown
  const indent = freshLine[1] ?? '  '
  const newFm = fm.replace(
    freshLine[0],
    `${freshLine[0]}\n${indent}${key}: ${yamlScalar(target)}`,
  )
  return markdown.replace(fm, newFm)
}

/** Flip a card's frontmatter freshness to `superseded`. Operates ONLY inside the
 *  leading `---` frontmatter block (so a "freshness:" line in the body prose is
 *  never rewritten) and tolerates a quoted value. Best-effort: if there is no
 *  frontmatter / no freshness field the content is preserved unchanged. */
function markSuperseded(markdown: string): string {
  const fmMatch = markdown.match(/^---\n[\s\S]*?\n---/)
  if (!fmMatch) return markdown
  const fm = fmMatch[0]
  if (!/\n\s*freshness:\s*['"]?[\w-]+['"]?/.test(fm)) return markdown
  const newFm = fm.replace(/(\n\s*freshness:\s*)['"]?[\w-]+['"]?/, `$1superseded`)
  return markdown.replace(fm, newFm)
}

export const CARD_CONFIDENCE = [
  'confirmed',
  'likely',
  'possible',
  'unverified',
] as const
export type CardConfidence = (typeof CARD_CONFIDENCE)[number]

export const CARD_FRESHNESS = ['fresh', 'valid', 'stale', 'superseded'] as const
export type CardFreshness = (typeof CARD_FRESHNESS)[number]

/**
 * Transferability scope. The paper's
 * measured decay mode is regime-specific lessons being recalled as universal
 * advice. A `general` lesson states a transferable principle; a `regime-specific`
 * lesson is tied to one stack/repo and should carry an Applies-when / Not-when so
 * it is never applied out of regime. Defaults conservatively to `regime-specific`.
 */
export const CARD_SCOPE = ['general', 'regime-specific'] as const
export type CardScope = (typeof CARD_SCOPE)[number]

export type ExperienceCardMeta = {
  type: typeof EXPERIENCE_CARD_TYPE
  problemClass: string
  sourceRefs: string[]
  confidence: CardConfidence
  freshness: CardFreshness
  approved: boolean
  /** transferability triage — defaults to the conservative 'regime-specific'. */
  scope: CardScope
}

function coerceConfidence(raw: unknown): CardConfidence {
  return (CARD_CONFIDENCE as readonly string[]).includes(String(raw))
    ? (raw as CardConfidence)
    : 'unverified'
}

function coerceFreshness(raw: unknown): CardFreshness {
  return (CARD_FRESHNESS as readonly string[]).includes(String(raw))
    ? (raw as CardFreshness)
    : 'fresh'
}

function coerceScope(raw: unknown): CardScope {
  // Conservative default: an unlabelled card is treated as regime-specific, so
  // it is never silently trusted as a universal principle.
  return (CARD_SCOPE as readonly string[]).includes(String(raw))
    ? (raw as CardScope)
    : 'regime-specific'
}

function coerceRefs(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(r => String(r)).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) {
    return raw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }
  return []
}

/**
 * Read Experience-Card metadata from a parsed frontmatter object. The on-disk
 * convention nests memory metadata under `metadata:` (matches existing memory
 * files, e.g. `metadata.type: project`), so read there first; fall back to
 * top-level keys for robustness. Returns null when this is NOT a card — callers
 * then leave the file untouched (identity), which keeps non-card behavior intact.
 */
export function readCardMeta(
  frontmatter: Record<string, unknown>,
): ExperienceCardMeta | null {
  const meta =
    frontmatter && typeof frontmatter.metadata === 'object'
      ? (frontmatter.metadata as Record<string, unknown>)
      : undefined
  const type = (meta?.type ?? frontmatter.type) as unknown
  if (type !== EXPERIENCE_CARD_TYPE) return null

  const pick = (k: string): unknown => meta?.[k] ?? frontmatter[k]
  return {
    type: EXPERIENCE_CARD_TYPE,
    problemClass: String(pick('problemClass') ?? 'unknown'),
    sourceRefs: coerceRefs(pick('sourceRefs')),
    confidence: coerceConfidence(pick('confidence')),
    freshness: coerceFreshness(pick('freshness')),
    // YAML may yield boolean true or the string "true".
    approved: pick('approved') === true || pick('approved') === 'true',
    scope: coerceScope(pick('scope')),
  }
}

/** Whether a markdown blob is an Experience Card (parses its frontmatter). */
export function isExperienceCardMarkdown(markdown: string): boolean {
  try {
    const { frontmatter } = parseFrontmatter(markdown)
    return readCardMeta(frontmatter as Record<string, unknown>) !== null
  } catch {
    return false
  }
}

//
// Secret refusal — secret-bearing traces must never become (or be surfaced as)
// a card. Heuristic, conservative; reports the KIND, never echoes the value.
//

export type SecretMatch = { kind: string; redacted: string }

const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { kind: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i },
  // generic secret assignment: (api_key|secret|token|password) = "<20+ chars>"
  {
    kind: 'secret-assignment',
    re: /\b(?:api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{16,}/i,
  },
  // explicit credential-store reference the identity floor forbids surfacing
  { kind: 'credentials-file', re: /\.credentials\.json\b/ },
]

/** Returns the secret kinds found in `text` (empty ⇒ clean). Never echoes the value. */
export function detectSecrets(text: string): SecretMatch[] {
  if (!text) return []
  const out: SecretMatch[] = []
  for (const { kind, re } of SECRET_PATTERNS) {
    const m = text.match(re)
    if (m) out.push({ kind, redacted: '[redacted]' })
  }
  return out
}

//
// Feature 2 — distill-on-high-signal predicate.
//

export type DistillSignal = {
  /** A green-gate-passing commit produced this run (e.g. `bun run build.ts && git commit`). */
  greenGatePassed: boolean
  /** Explicit operator request to card this lesson (the second legitimate trigger). */
  operatorSignal?: boolean
  /** The transferable lesson text (the card body). */
  lesson: string
  /** Optional source anchors (commit SHA, doc paths) — scanned for secrets too. */
  sourceRefs?: string[]
}

export type DistillDecision = { fire: true } | { fire: false; reason: string }

const MIN_LESSON_CHARS = 24

/**
 * Decide whether a run is high-signal enough to card. Card ONLY when:
 *   (operatorSignal) OR (greenGatePassed)   — the two legitimate triggers,
 *   AND the lesson is a non-trivial transferable statement,
 *   AND nothing in the lesson/refs is secret-bearing (fatal — refuse).
 * Deliberately NOT a score (no scoring engine): green is binary pass/fail.
 */
export function shouldDistill(signal: DistillSignal): DistillDecision {
  const lesson = (signal.lesson ?? '').trim()
  const refsText = (signal.sourceRefs ?? []).join('\n')
  const secrets = detectSecrets(`${lesson}\n${refsText}`)
  if (secrets.length > 0) {
    return {
      fire: false,
      reason: `secret-bearing (${secrets.map(s => s.kind).join(', ')}) — refused`,
    }
  }
  if (lesson.length < MIN_LESSON_CHARS) {
    return { fire: false, reason: 'no transferable lesson (too short / empty)' }
  }
  // Operator-banked cards short-circuit FIRST — a /remember / operator-banked
  // lesson with a legit empty sourceRefs is intentional and must never be blocked
  // by the trace-ground gate below.
  if (signal.operatorSignal === true) return { fire: true }
  if (signal.greenGatePassed === true) {
    // Trace-ground gate (default-OFF, opt-IN MERCURY_CARD_TRACE_GROUND): a green-gate
    // distill must anchor its lesson body to captured signal, not a narrated
    // story — refuse a green pass with no sourceRefs.
    if (cardTraceGroundEnabled() && (!signal.sourceRefs || signal.sourceRefs.length === 0)) {
      return {
        fire: false,
        reason:
          'green-gate distill has no sourceRefs anchor — lesson body must be grounded in captured signal (MERCURY_CARD_TRACE_GROUND)',
      }
    }
    return { fire: true }
  }
  return {
    fire: false,
    reason: 'not high-signal (no green-gate pass and no operator signal)',
  }
}

//
// Feature 1 — card builder (pure). No fs, no Date.now (createdAt is injected).
//

export type BuildCardInput = {
  /** kebab-case slug; becomes `<name>.md` and the frontmatter `name`. */
  name: string
  /** human-readable card title (MEMORY.md index link text). */
  title: string
  /** one-line description / index hook (frontmatter `description`). */
  summary: string
  problemClass: string
  /** the transferable lesson (markdown body). */
  lesson: string
  sourceRefs: string[]
  confidence?: CardConfidence
  freshness?: CardFreshness
  /** default false — cards are born as unverified candidates. */
  approved?: boolean
  /** transferability triage (default 'regime-specific'). */
  scope?: CardScope
  /** one-line "applies when …" cue (recommended for regime-specific lessons). */
  appliesWhen?: string
  /** one-line "NOT when …" cue — the negative-applicability guard against
   *  recalling a regime-specific lesson as universal advice. */
  notWhen?: string
  /** ISO timestamp, injected by the caller (keeps this function pure). */
  createdAt: string
  /** whether the originating commit passed the green-gate. */
  greenGate?: boolean
  /** HARNESS-harvested primary-source evidence lines (evidenceHarvest.ts —
   *  git-stat summary + trace-tail aggregate), never model-authored. Rendered
   *  as an "Evidence (harvested)" block; scanned for secrets like every other
   *  disk-bound field; bounded here (count + per-line clamp). */
  harvestedEvidence?: string[]
}

export type BuildCardResult =
  | {
      ok: true
      filename: string
      markdown: string
      indexLine: string
      meta: ExperienceCardMeta
    }
  | { ok: false; blocked: 'secret-bearing'; matches: SecretMatch[] }
  | { ok: false; blocked: 'invalid-input'; reason: string }

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

/** Quote a YAML scalar safely (single line, escaped) so hand-serialization can't break parsing. */
function yamlScalar(s: string): string {
  const oneLine = String(s).replace(/[\r\n]+/g, ' ').trim()
  return `"${oneLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Max chars for an auto-written MEMORY.md index line. MEMORY.md is embedded
 * VERBATIM into the cached memory prefix (memdir.ts `MAX_ENTRYPOINT_BYTES` =
 * 25_000), so an uncapped card `summary` would creep the cached prefix toward its
 * byte cap (past which truncateEntrypointContent silently drops the oldest
 * entries). Bound each auto-written entry to the documented one-line ~200-char
 * budget the truncation warning itself advises ("keep index entries to one line
 * under ~200 chars"). Operator-hand-written lines are out of scope (not ours to
 * trim); this just stops the SYSTEM from worsening the cap.
 */
export const MAX_INDEX_LINE_CHARS = 200

/** Clamp an auto-written index line to MAX_INDEX_LINE_CHARS, ellipsizing the tail.
 *  Backs off one code unit if the cut would land mid-surrogate-pair, so a boundary
 *  emoji never leaves a lone surrogate written into MEMORY.md. */
export function capIndexLine(line: string): string {
  if (line.length <= MAX_INDEX_LINE_CHARS) return line
  let end = MAX_INDEX_LINE_CHARS - 1
  const last = line.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1 // last kept unit is a high surrogate
  return line.slice(0, end).trimEnd() + '…'
}

export function buildExperienceCard(input: BuildCardInput): BuildCardResult {
  const name = (input.name ?? '').trim()
  if (!SLUG_RE.test(name)) {
    return {
      ok: false,
      blocked: 'invalid-input',
      reason: `name must be kebab-case slug (got ${JSON.stringify(input.name)})`,
    }
  }
  const lesson = (input.lesson ?? '').trim()
  const title = (input.title ?? '').trim()
  const summary = (input.summary ?? '').trim()
  const problemClass = (input.problemClass ?? '').trim()
  if (!lesson || !title || !summary || !problemClass) {
    return {
      ok: false,
      blocked: 'invalid-input',
      reason: 'title, summary, problemClass, and lesson are all required',
    }
  }

  const refs = (input.sourceRefs ?? []).map(r => String(r).trim()).filter(Boolean)
  const appliesWhen = (input.appliesWhen ?? '').replace(/[\r\n]+/g, ' ').trim()
  const notWhen = (input.notWhen ?? '').replace(/[\r\n]+/g, ' ').trim()
  // Harvested-evidence bounds: ≤6 lines, single-line-coerced, ≤300 chars each
  // (the harvester emits structural summaries; the clamp is the defensive floor).
  const harvested = (input.harvestedEvidence ?? [])
    .map(l => String(l ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 6)
  // Secret-bearing traces are fatal to distillation — refuse the whole card.
  // appliesWhen/notWhen are emitted into the rendered body too (the **Applies when:**
  // / **Not when:** lines), so a secret in them would otherwise reach disk unscanned.
  // Harvested evidence is disk-bound the same way — same scan, same refusal.
  const secrets = detectSecrets(
    [title, summary, lesson, appliesWhen, notWhen, ...refs, ...harvested].join('\n'),
  )
  if (secrets.length > 0) {
    return { ok: false, blocked: 'secret-bearing', matches: secrets }
  }

  const approved = input.approved === true
  const confidence = input.confidence ?? 'possible'
  const freshness = input.freshness ?? 'fresh'
  const scope = coerceScope(input.scope)
  const filename = `${name}.md`

  const fmLines = [
    '---',
    `name: ${name}`,
    `description: ${yamlScalar(summary)}`,
    'metadata:',
    `  type: ${EXPERIENCE_CARD_TYPE}`,
    `  problemClass: ${yamlScalar(problemClass)}`,
    `  scope: ${scope}`,
    `  confidence: ${confidence}`,
    `  freshness: ${freshness}`,
    `  approved: ${approved}`,
    `  greenGate: ${input.greenGate === true}`,
    `  createdAt: ${yamlScalar(input.createdAt)}`,
    '  sourceRefs:',
    ...(refs.length > 0
      ? refs.map(r => `    - ${yamlScalar(r)}`)
      : ['    []']),
    '---',
  ]
  // YAML quirk: an empty inline `[]` must sit on the key line, not as a child.
  if (refs.length === 0) {
    const i = fmLines.indexOf('  sourceRefs:')
    fmLines.splice(i, 2, '  sourceRefs: []')
  }

  const statusLine = approved
    ? `**Status:** approved experience card (operator-verified lesson) · confidence: ${confidence} · freshness: ${freshness} · scope: ${scope} · problemClass: ${problemClass}`
    : `**Status:** candidate lesson — UNVERIFIED, not a trusted instruction · confidence: ${confidence} · freshness: ${freshness} · scope: ${scope} · problemClass: ${problemClass}`

  // Transferability cues emitted only when provided.
  // For a regime-specific lesson these are the guard against universal recall.
  const applicabilityLines: string[] = []
  if (appliesWhen) applicabilityLines.push(`**Applies when:** ${appliesWhen}`)
  if (notWhen) applicabilityLines.push(`**Not when:** ${notWhen}`)

  // Harvested evidence (trace-grounding family): primary-source lines the
  // HARNESS collected — bounded, single-line-coerced, secret-scanned above.
  const evidenceLines = harvested.map(l => `- ${l}`)

  const body = [
    statusLine,
    ...(applicabilityLines.length ? ['', ...applicabilityLines] : []),
    '',
    lesson,
    '',
    `**Source refs:** ${refs.length ? refs.join(', ') : '(none recorded)'}`,
    `**Green-gate:** ${input.greenGate ? 'passed' : 'not recorded'}`,
    ...(evidenceLines.length
      ? ['', '**Evidence (harvested):**', ...evidenceLines]
      : []),
    '',
  ].join('\n')

  const markdown = `${fmLines.join('\n')}\n\n${body}`

  const indexLine = capIndexLine(
    `- [${title}](${filename}) — experience-card (${approved ? 'approved' : 'candidate'}): ${summary}`,
  )

  return {
    ok: true,
    filename,
    markdown,
    indexLine,
    meta: {
      type: EXPERIENCE_CARD_TYPE,
      problemClass,
      sourceRefs: refs,
      confidence,
      freshness,
      approved,
      scope,
    },
  }
}

//
// Feature 3 — lifecycle render at recall time. Pure; identity for non-cards.
//

const CANDIDATE_BANNER = `${GLYPH.warn} CANDIDATE LESSON — UNVERIFIED`
const APPROVED_BANNER = '✓ APPROVED EXPERIENCE CARD'
const SECRET_REFUSAL =
  '[experience-card refused: secret-bearing content withheld — not surfaced]'

/**
 * The secret-refusal notice, NAMING the suppressed card when we know its
 * identity. Recall withholds the whole body, so a bare identity-less
 * banner leaves the operator unable to tell WHICH card was suppressed (and which
 * to inspect/redact). The name is a kebab slug — not itself the secret (the gate
 * fires on the body), and this never echoes the matched value.
 */
function secretRefusalFor(label?: string): string {
  const id = (label ?? '').trim()
  return id
    ? `[experience-card "${id}" refused: secret-bearing content withheld — not surfaced]\n`
    : `${SECRET_REFUSAL}\n`
}

/**
 * Full-text secret gate for a TRUNCATED card recall. The recall path
 * scans only the truncated prefix (MAX_MEMORY_BYTES/LINES), so a secret PAST the
 * cap in a hand-authored card slips past renderExperienceCardForRecall's own
 * detectSecrets. The caller does a bounded FULL read and passes it here:
 *   - fullText === null  (couldn't fully read — too big / IO error) ⇒ withhold
 *     (FAIL-CLOSED: if we can't fully scan it, we don't surface it).
 *   - a secret anywhere in the full text                            ⇒ withhold.
 *   - otherwise                                                     ⇒ null (the
 *     caller surfaces the truncated card normally).
 */
export function fullScanSecretRefusal(fullText: string | null): string | null {
  if (fullText === null) return `${SECRET_REFUSAL}\n`
  return detectSecrets(fullText).length > 0 ? `${SECRET_REFUSAL}\n` : null
}

/**
 * Transform a memory file's markdown for recall surfacing:
 *   - not an Experience Card        → returned unchanged (identity).
 *   - secret-bearing card           → content withheld (refusal notice, no leak).
 *   - approved:false (or missing)   → CANDIDATE banner: "unverified, not a
 *                                     trusted instruction — verify before acting".
 *   - approved:true                 → APPROVED banner (operator-verified lesson).
 *
 * This is the load-side realization of "lifecycle as frontmatter": the
 * `approved` field drives whether the card reads as a candidate hypothesis or a
 * trusted lesson. Wired (gated) into readMemoriesForSurfacing.
 */
export function renderExperienceCardForRecall(
  markdown: string,
  // #12: when the surfaced BODY is a truncated prefix (the recall budget capped it),
  // pass the full card text as `metaSource` so the banner + secret scan read the COMPLETE
  // frontmatter — a candidate card whose closing `---` sits past the cap would otherwise
  // parse to no-meta and surface with NO "UNVERIFIED" framing. Defaults to `markdown`, so
  // every single-arg caller is byte-identical. The body shown is always `markdown` (the
  // truncated prefix + its truncation note) — never `metaSource` (that would defeat the cap).
  metaSource: string = markdown,
  // the card file's mtime, when available, so the freshness banner can
  // caveat an old-on-disk card — a 'fresh' value (often the coerced default when the
  // frontmatter omits the field) on a file untouched for days is the stale-as-fresh
  // problem the wrapping memory header already warns about. Absent ⇒ byte-identical.
  mtimeMs?: number,
): string {
  let meta: ExperienceCardMeta | null
  let cardName = ''
  try {
    const { frontmatter } = parseFrontmatter(metaSource)
    meta = readCardMeta(frontmatter as Record<string, unknown>)
    // The slug name (or its problemClass) identifies the card in a refusal
    // without echoing any secret — see secretRefusalFor /.
    const nm = (frontmatter as Record<string, unknown>)?.name
    cardName = typeof nm === 'string' ? nm : meta?.problemClass ?? ''
  } catch {
    return markdown
  }
  if (!meta) return markdown

  // Refuse to surface secret-bearing cards at all (defense in depth: the write
  // path should already have blocked them). Scan `metaSource` (the full card when the
  // body is a truncated prefix) so a secret past the cap is still caught. Name the
  // suppressed card so the operator knows WHICH one to inspect/redact.
  if (detectSecrets(metaSource).length > 0) {
    return secretRefusalFor(cardName)
  }

  // Transferability guard a regime-specific lesson
  // must not be recalled as universal advice — make the scope explicit and warn.
  const scopeNote =
    meta.scope === 'regime-specific'
      ? ' REGIME-SPECIFIC — apply only within its stated regime (see Applies-when / Not-when); do NOT generalize it.'
      : ' (scope: general — a transferable principle).'

  // reconcile the freshness CLAIM against the file's actual age. When the
  // card file is >1 day old, append the age so a 'fresh' banner can't present a
  // long-untouched card as current (mirrors memoryFreshnessText on the header).
  const freshnessText =
    mtimeMs !== undefined && memoryAgeDays(mtimeMs) > 1
      ? `${meta.freshness} (file ${memoryAge(mtimeMs)} — re-verify)`
      : meta.freshness

  if (meta.approved) {
    return [
      `${APPROVED_BANNER} (confidence: ${meta.confidence}, freshness: ${freshnessText}, scope: ${meta.scope}, problemClass: ${meta.problemClass}). Operator-verified — trustworthy as a lesson, but still verify any named file/flag against current state before acting.${scopeNote}`,
      '',
      markdown,
    ].join('\n')
  }
  return [
    `${CANDIDATE_BANNER} (confidence: ${meta.confidence}, freshness: ${freshnessText}, scope: ${meta.scope}, problemClass: ${meta.problemClass}). Treat as a hypothesis to check, NOT a trusted instruction; an operator must approve it (flip metadata.approved) before it is trusted. A card whose frontmatter is well-formed is not thereby correct.${scopeNote}`,
    '',
    markdown,
  ].join('\n')
}

//
// Doctrine section injected (gated) into the memory prompt by buildMemoryLines.
// Returns [] when off ⇒ byte-identical; returns ['', ...lines] when on so the
// caller needs no surrounding blank-line literals.
//

// condensed from the enumerated authoring protocol
// (~2.3KB — full frontmatter schema, scope taxonomy, lifecycle drill) to the
// compact form below (~0.9KB). The schema now travels by example ("copy the
// frontmatter shape from an existing card") per the researched
// judgment-over-rules law;
// the LAW content — high-signal-only, never secrets, born-unverified-until-
// approved, regime-scoping — survives intact.
const EXPERIENCE_CARD_DOCTRINE: readonly string[] = [
  '## Experience cards (distilled lessons)',
  '',
  'An **experience card** (`metadata.type: experience-card`) records ONE durable, transferable lesson from a high-signal run — written only on such a run or when the operator asks, never for routine runs or secret-bearing content. Copy the frontmatter shape from an existing card; mark a stack-specific lesson `scope: regime-specific` with an `**Applies when:** …` line. A card is born `approved: false` and loads as a **candidate lesson, unverified** — never a trusted instruction — until the operator flips `approved: true`. Index it in `MEMORY.md` like any memory.',
]

export function experienceCardDoctrineLines(
  enabled: boolean = experienceCardsEnabled(),
): string[] {
  if (!enabled) return []
  return ['', ...EXPERIENCE_CARD_DOCTRINE]
}

//
// Feature 2 — write path (I/O). Writes the card .md and updates the MEMORY.md
// index. Optionally gated by a DistillSignal (shouldDistill) first.
//

//
// MEMORY.md index update — serialized + atomic.
//
// MEMORY.md is a SHARED file: the card .md write is single-file safe, but the
// index pointer is a read-modify-write. Two near-simultaneous card writes (the
// distill-card CLI run concurrently, a future auto-distill, or the model editing
// MEMORY.md in the same window) would each read the same snapshot and the second
// blind writeFile would clobber the first's appended pointer — a silently lost
// index entry (the card survives on disk but is unreachable from the index the
// recall model reads). The module's doc promised "never corrupts MEMORY.md"; this
// was the one un-hardened write.
//
// Fix: serialize the read-modify-write per index path (an in-process promise
// chain), and write atomically via a temp file + rename so a crash mid-write can
// never truncate the index. The transform runs INSIDE the lock against the
// freshly-read content, so a concurrent writer's pointer is merged (refresh),
// not duplicated. Returns whether the index changed.
//
const indexWriteChains = new Map<string, Promise<void>>()

/** Atomic read-modify-write of one index file. transform(existing) → new content
 *  or null for "no change". The read tolerates a missing file (''); the write
 *  (temp + rename) may throw, mirroring the prior best-effort contract. */
// R8: a CROSS-PROCESS flock around the index read-modify-write. The in-process
// promise chain (serializeIndexUpdate) only serializes THIS process; the Scribe and
// the daemon-hosted Implementer are SEPARATE processes that both write MEMORY.md, so
// without an OS-level lock A reads → B reads → both rename → B clobbers A's appended
// pointer (a silently lost memory). proper-lockfile (the same primitive the teammate
// mailbox uses) makes read→transform→rename atomic across processes. Fail-OPEN: if the
// lock can't be acquired we still write (the in-process chain holds + the atomic rename
// prevents a torn file) — a rare lost-update beats blocking a memory write entirely.
const INDEX_LOCK_OPTIONS = {
  retries: { retries: 10, minTimeout: 5, maxTimeout: 100 },
}

async function applyIndexUpdate(
  indexPath: string,
  transform: (existing: string) => string | null,
): Promise<boolean> {
  // Ensure the index file exists so proper-lockfile can lock it — `wx` creates an
  // empty file only when absent, NEVER truncating an existing index.
  try {
    await mkdir(dirname(indexPath), { recursive: true })
    await writeFile(indexPath, '', { flag: 'wx' })
  } catch {
    /* EEXIST (already there) or a benign mkdir race — fine */
  }

  let release: (() => Promise<void>) | undefined
  try {
    release = await lockfile.lock(indexPath, {
      lockfilePath: `${indexPath}.lock`,
      ...INDEX_LOCK_OPTIONS,
    })
  } catch {
    release = undefined // fail-open: write without the cross-process lock rather than drop it
  }

  try {
    let existing = ''
    try {
      existing = await readFile(indexPath, 'utf-8')
    } catch {
      existing = ''
    }
    const updated = transform(existing)
    if (updated === null) return false
    await atomicWriteFile(indexPath, updated)
    return true
  } finally {
    if (release) await release().catch(() => {})
  }
}

/** Serialize applyIndexUpdate per path so concurrent index writes can't clobber.
 *  The returned promise carries the result; the chained tail never rejects, so one
 *  failed write can't stall every subsequent index update for that path.
 *  Exported so the scribe ratify-promote path (scribePromote.ts) reuses the SAME
 *  crash-safe, per-path-serialized index writer rather than racing its own. */
export function serializeIndexUpdate(
  indexPath: string,
  transform: (existing: string) => string | null,
): Promise<boolean> {
  const prev = indexWriteChains.get(indexPath) ?? Promise.resolve()
  const result = prev.then(() => applyIndexUpdate(indexPath, transform))
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  indexWriteChains.set(indexPath, tail)
  void tail.finally(() => {
    if (indexWriteChains.get(indexPath) === tail) indexWriteChains.delete(indexPath)
  })
  return result
}

export type WriteCardResult =
  | { ok: true; path: string; indexPath: string; indexUpdated: boolean; supersededPath?: string }
  | { ok: false; blocked: 'secret-bearing'; matches: SecretMatch[] }
  | { ok: false; blocked: 'supersede-failed'; reason: string }
  | { ok: false; blocked: 'invalid-input'; reason: string }
  | { ok: false; blocked: 'duplicate'; reason: string }
  | { ok: false; blocked: 'skipped'; reason: string }

/**
 * Card-outcome ledger row (RoutingEntry
 * minus git; store = the evolution ledger, Meta-Harness rows). One row per
 * distill/promote DECISION, keyed by problemClass, so the drift report can do
 * the per-class pass-rate + recent-vs-prior arithmetic the memdir used to
 * discard. Best-effort + never throws (the ledger module guarantees both) and
 * gated by MERCURY_EVOLUTION_LEDGER (OFF ⇒ no-op, no file). notes carry only
 * code-authored reason strings (class/slug identifiers — never card content).
 */
async function recordCardOutcome(
  memoryDir: string,
  mechanism: 'distill' | 'promote',
  subject: string,
  outcome: 'accepted' | 'refused' | 'error',
  notes: string,
  evidenceRefs?: string[],
): Promise<void> {
  // A relative memoryDir already failed the write itself — recording it would
  // mkdir a stray ./evolution under the process cwd. Skip; nothing to anchor.
  if (!isAbsolute(memoryDir)) return
  await writeEvolutionRow(join(memoryDir, 'evolution'), {
    program: 'memdir-cards',
    subject,
    outcome,
    mechanism,
    notes,
    ...(evidenceRefs && evidenceRefs.length > 0 ? { evidenceRefs } : {}),
  })
}

/**
 * Build + persist an Experience Card into a memory directory and index it in
 * MEMORY.md. If `opts.signal` is supplied, shouldDistill() gates the write
 * (so this is the full distill-on-high-signal path). Refuses secret-bearing
 * input. Idempotent on the index (won't duplicate an existing pointer).
 *
 * (Thin wrapper: records the decision as a card-outcome ledger row — one
 * chokepoint instead of a call at every return site in the locked body.)
 */
export async function writeExperienceCard(
  memoryDir: string,
  input: BuildCardInput,
  opts?: { signal?: DistillSignal },
): Promise<WriteCardResult> {
  const result = await writeExperienceCardInner(memoryDir, input, opts)
  const subject = input.problemClass?.trim() || 'unknown'
  if (result.ok) {
    await recordCardOutcome(memoryDir, 'distill', subject, 'accepted', 'card written (candidate lifecycle)', [
      result.path,
      ...(input.sourceRefs ?? []).slice(0, 3),
    ])
  } else if (result.blocked === 'skipped' || result.blocked === 'duplicate') {
    await recordCardOutcome(memoryDir, 'distill', subject, 'refused', result.reason)
  } else if (result.blocked === 'secret-bearing') {
    await recordCardOutcome(memoryDir, 'distill', subject, 'refused', 'secret-bearing content refused')
  } else {
    await recordCardOutcome(memoryDir, 'distill', subject, 'error', result.reason)
  }
  return result
}

async function writeExperienceCardInner(
  memoryDir: string,
  input: BuildCardInput,
  opts?: { signal?: DistillSignal },
): Promise<WriteCardResult> {
  if (opts?.signal) {
    const decision = shouldDistill(opts.signal)
    if (!decision.fire) {
      return { ok: false, blocked: 'skipped', reason: decision.reason }
    }
  }

  const built = buildExperienceCard(input)
  if (!built.ok) return built

  if (!isAbsolute(memoryDir)) {
    return {
      ok: false,
      blocked: 'invalid-input',
      reason: `memoryDir must be absolute (got ${memoryDir})`,
    }
  }

  await mkdir(memoryDir, { recursive: true })
  const cardPath = join(memoryDir, built.filename)

  // Distill-time dedup: refuse a NEW card whose problemClass + normalized lesson
  // already match an existing non-superseded card under a DIFFERENT name. A
  // same-name rewrite is NOT a duplicate (it's a supersede — handled below), so
  // built.filename is excluded; `.superseded.*` audit copies are excluded too.
  if (cardDedupEnabled()) {
    const candLesson = normalizedLesson(built.markdown)
    try {
      const { readdir } = await import('fs/promises')
      for (const f of await readdir(memoryDir)) {
        if (
          !f.endsWith('.md') ||
          f === built.filename ||
          f === ENTRYPOINT_NAME ||
          f.includes('.superseded.')
        ) {
          continue
        }
        let other: string
        try {
          other = await readFile(join(memoryDir, f), 'utf-8')
        } catch {
          continue
        }
        const m = isExperienceCardMarkdown(other)
          ? readCardMeta(parseFrontmatter(other).frontmatter as Record<string, unknown>)
          : null
        if (
          m &&
          m.freshness !== 'superseded' &&
          m.problemClass === built.meta.problemClass &&
          // #11 audit-r1: an all-bold lesson normalizes to '' — never treat two
          // distinct empty-key cards as duplicates (that DROPS unique work, the
          // exact failure the dedup design promised never to do).
          candLesson !== '' &&
          normalizedLesson(other) === candLesson
        ) {
          return {
            ok: false,
            blocked: 'duplicate',
            reason: `already covered for problemClass "${built.meta.problemClass}" by ${f} — not writing a near-duplicate card`,
          }
        }
      }
    } catch {
      /* dir read failure: proceed without dedup (no worse than off) */
    }
  }

  // Non-destructive supersede: never clobber a prior card of the same name —
  // preserve it as an in-tree `.superseded.<stamp>.<hash>.md` audit artifact
  // (freshness flipped to `superseded`) so a wrong rewrite stays inspectable and
  // revertable. The canonical filename is reused, so the MEMORY.md pointer keeps
  // pointing at the (new) card and the superseded copy carries no pointer.
  // Per-card cross-process lock around the read-prior → writeSuperseded → write-
  // canonical read-modify-write. Without it, two processes banking the SAME slug
  // (foreground RememberLesson/​/remember vs the daemon Implementer's promote) can
  // both read prior=V0, both preserve V0, then both write canonical — the loser's
  // update is LOST with no superseded copy (the exact data-loss supersede exists to
  // prevent; its abort-on-preserve-failure guard misses a CONCURRENCY clobber).
  // Mirrors applyIndexUpdate's flock; fail-open (a contended/absent lock — e.g. the
  // card doesn't exist yet on a first write, where there is no prior to race — never
  // drops the write). The index write below keeps its own separate lock.
  let supersededPath: string | undefined
  let cardRelease: (() => Promise<void>) | undefined
  try {
    cardRelease = await lockfile.lock(cardPath, {
      lockfilePath: `${cardPath}.lock`,
      ...INDEX_LOCK_OPTIONS,
    })
  } catch {
    cardRelease = undefined
  }
  try {
    if (cardSupersedeEnabled()) {
      // READ failure (ENOENT/unreadable) just means "no prior, proceed". But a
      // PRESERVE-WRITE failure must ABORT — otherwise the canonical write below
      // would clobber an un-preserved prior, the exact data loss supersede exists
      // to prevent. So the two are separated and the write error is NOT swallowed.
      let prior: string | undefined
      try {
        prior = await readFile(cardPath, 'utf-8')
      } catch {
        prior = undefined
      }
      if (prior && prior !== built.markdown) {
        try {
          supersededPath = await writeSupersededCopy(
            memoryDir,
            built.filename,
            prior,
            input.createdAt,
          )
        } catch (e) {
          return {
            ok: false,
            blocked: 'supersede-failed',
            reason: `could not preserve the prior card before overwrite (${e instanceof Error ? e.message : String(e)}) — refusing to clobber`,
          }
        }
      }
    }

    // Forward lineage edge: the new canonical names the exact audit copy it
    // replaced (unique per generation), making the supersede history walkable.
    await atomicWriteFile(
      cardPath,
      supersededPath
        ? stampLineageEdge(built.markdown, 'supersedes', basename(supersededPath))
        : built.markdown,
    )
  } finally {
    if (cardRelease) await cardRelease().catch(() => {})
  }

  // Update the MEMORY.md index. A card rewrite is now a routine path (supersede),
  // so REFRESH an existing pointer line when its text changed (e.g. candidate→
  // approved, edited summary), append it when absent — never leave a stale line.
  const indexPath = join(memoryDir, ENTRYPOINT_NAME)
  const pointerToken = `](${built.filename})` // link-anchored — never a sibling substring
  const indexUpdated = await serializeIndexUpdate(indexPath, existing => {
    const lines = existing.split('\n')
    const lineIdx = lines.findIndex(l => l.includes(pointerToken))
    if (lineIdx >= 0) {
      if (lines[lineIdx] === built.indexLine) return null // already current — no change
      lines[lineIdx] = built.indexLine
      return lines.join('\n')
    }
    const base = existing.trimEnd()
    return base ? `${base}\n${built.indexLine}\n` : `# Memory index\n\n${built.indexLine}\n`
  })

  return { ok: true, path: cardPath, indexPath, indexUpdated, supersededPath }
}

//
// Promote-gate — the deterministic accept criterion at the candidate→approved
// boundary.
//

export type PromoteDecision = { ok: true } | { ok: false; reason: string }

/** Extract the lesson prose for dedup comparison: drop the frontmatter, then drop the
 *  `**…**`-prefixed Status / Source-refs / Green-gate banner lines (near-identical across
 *  cards — comparing them would false-positive on boilerplate), but KEEP the
 *  `**Applies when:**` / `**Not when:**` regime cues (markers stripped). Those cues are the
 *  load-bearing distinguisher between two regime-specific cards under the same problemClass
 *  (hasAppliesWhen / cardPromoteGate rely on them), so folding them into the boilerplate drop
 *  would collapse legitimately-distinct lessons to one dedup key (the inverse: keeping ALL
 *  bold lines would re-admit the per-card-varying banners and over-distinguish). Normalize
 *  case + whitespace. */
export function normalizedLesson(markdown: string): string {
  let body = markdown
  const fm = markdown.match(/^---\n[\s\S]*?\n---/)
  if (fm) body = markdown.slice(fm[0].length)
  // The harvested-evidence block is HARNESS-collected context, not lesson
  // content — its bullets (`- commit …`, `- trace tail …`) carry counts that
  // differ between otherwise-identical banks, so leaving them in the identity
  // would quietly disable near-duplicate refusal for every harvested card
  // The builder ALWAYS appends
  // this block LAST (after Source-refs/Green-gate), so anchor the strip to
  // end-of-body: a GLOBAL/unanchored strip (the first cut) would also erase a
  // lookalike header a model happened to write inside its own free-text lesson,
  // collapsing two DIFFERENT lessons to one identity ⇒ the second silently
  // refused as a duplicate = card data loss (skeptic-round-2 catch). Non-global,
  // `\s*$`-anchored ⇒ only the trailing harness block is removed.
  body = body.replace(/\n\*\*Evidence \(harvested\):\*\*\n(?:- [^\n]*\n?)*\s*$/, '\n')
  const isRegimeCue = (l: string) => /^\*\*(Applies when|Not when):\*\*/i.test(l)
  return body
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && (!l.startsWith('**') || isRegimeCue(l)))
    .map(l => (isRegimeCue(l) ? l.replace(/\*\*/g, '') : l))
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** A card body carries a non-empty "**Applies when:** …" cue. */
function hasAppliesWhen(markdown: string): boolean {
  return /\*\*Applies when:\*\*\s*\S/.test(markdown)
}

/**
 * Deterministic accept criterion for promoting a candidate card to approved.
 * Mirrors gating.py's accept/promote gate, reduced to structural checks (a
 * coding agent has no holdout task-stream, and Mercury has no scoring engine):
 *   (a) secret-bearing                         → refuse (re-check; defense in depth)
 *   (b) freshness stale/superseded             → refuse (don't trust a decayed lesson)
 *   (c) regime-specific without an Applies-when → refuse (over-generalization guard)
 *   (d) an APPROVED sibling already covers this problemClass with the same
 *       (normalized-equal) lesson                → refuse (no-op / dedup)
 * Empty siblings ⇒ the dedup check is vacuously clean (gating.py's "nothing to
 * validate against" branch); only the structural checks gate.
 */
export function cardPromoteGate(
  candidateMarkdown: string,
  approvedSiblings: ReadonlyArray<{ problemClass: string; markdown: string }> = [],
): PromoteDecision {
  let meta: ExperienceCardMeta | null
  try {
    const { frontmatter } = parseFrontmatter(candidateMarkdown)
    meta = readCardMeta(frontmatter as Record<string, unknown>)
  } catch {
    return { ok: false, reason: 'not a parseable experience card' }
  }
  if (!meta) return { ok: false, reason: 'not an experience card' }

  const secrets = detectSecrets(candidateMarkdown)
  if (secrets.length > 0) {
    return {
      ok: false,
      reason: `secret-bearing (${secrets.map(s => s.kind).join(', ')}) — refused`,
    }
  }
  if (meta.freshness === 'stale' || meta.freshness === 'superseded') {
    return {
      ok: false,
      reason: `freshness is ${meta.freshness} — refusing to promote a decayed lesson`,
    }
  }
  if (meta.scope === 'regime-specific' && !hasAppliesWhen(candidateMarkdown)) {
    return {
      ok: false,
      reason:
        'regime-specific lesson has no "**Applies when:**" cue — refusing (over-generalization guard)',
    }
  }
  const candLesson = normalizedLesson(candidateMarkdown)
  for (const sib of approvedSiblings) {
    if (
      sib.problemClass === meta.problemClass &&
      // #11 audit-r1: empty normalized key (an all-bold lesson) is never a dup.
      candLesson !== '' &&
      normalizedLesson(sib.markdown) === candLesson
    ) {
      return {
        ok: false,
        reason: `already covered for problemClass "${meta.problemClass}" by an approved sibling (no-op)`,
      }
    }
  }
  return { ok: true }
}

/**
 * Surgically flip a card from candidate to approved: the frontmatter `approved`
 * field (inside the leading block only) AND the inline Status banner. Does NOT
 * re-render the lesson body (the on-disk body is rendered, not raw — round-trip
 * would be lossy). Recall surfacing reads the frontmatter, so the surfaced
 * banner follows this flip. Identity when there is nothing to flip.
 */
export function promoteCardMarkdown(markdown: string): string {
  let out = markdown
  const fmMatch = out.match(/^---\n[\s\S]*?\n---/)
  if (fmMatch) {
    const fm = fmMatch[0]
    const newFm = fm.replace(/(\n\s*approved:\s*)(?:false|true)\b/, `$1true`)
    out = out.replace(fm, newFm)
  }
  out = out.replace(
    /\*\*Status:\*\* candidate lesson — UNVERIFIED, not a trusted instruction/,
    '**Status:** approved experience card (operator-verified lesson)',
  )
  return out
}

export type PromoteCardResult =
  | { ok: true; path: string; supersededPath?: string; indexUpdated: boolean; alreadyApproved: boolean }
  | { ok: false; blocked: 'gate'; reason: string }
  | { ok: false; blocked: 'not-found'; reason: string }
  | { ok: false; blocked: 'supersede-failed'; reason: string }
  | { ok: false; blocked: 'invalid-input'; reason: string }

/**
 * Promote a candidate experience card to approved, gated (when enabled) by
 * cardPromoteGate against the already-approved sibling cards in the same dir.
 * Preserves the pre-promote copy (when cardSupersedeEnabled) and refreshes the
 * MEMORY.md index line. When the gate is OFF, this is the bare frontmatter flip
 * an operator would do by hand (byte-identical), so OFF ⇒ no new behavior.
 *
 * (Thin wrapper: records the promote decision as a card-outcome ledger row.
 * The subject prefers the card's problemClass — read best-effort — falling
 * back to the slug, so promote rows group with the class's distill rows.)
 */
export async function promoteExperienceCard(
  memoryDir: string,
  name: string,
  opts?: { now?: string },
): Promise<PromoteCardResult> {
  const result = await promoteExperienceCardInner(memoryDir, name, opts)
  let subject = name
  if (isAbsolute(memoryDir)) {
    try {
      const filename = name.endsWith('.md') ? name : `${name}.md`
      const raw = await readFile(join(memoryDir, filename), 'utf-8')
      const meta = readCardMeta(parseFrontmatter(raw).frontmatter as Record<string, unknown>)
      if (meta?.problemClass) subject = meta.problemClass
    } catch {
      /* not-found / unparseable — the slug is an honest fallback subject */
    }
  }
  if (result.ok) {
    await recordCardOutcome(
      memoryDir,
      'promote',
      subject,
      'accepted',
      result.alreadyApproved ? `already approved (no-op): ${name}` : `promoted to approved: ${name}`,
      [result.path],
    )
  } else if (result.blocked === 'gate') {
    await recordCardOutcome(memoryDir, 'promote', subject, 'refused', result.reason)
  } else {
    await recordCardOutcome(memoryDir, 'promote', subject, 'error', `${result.blocked}: ${result.reason}`)
  }
  return result
}

async function promoteExperienceCardInner(
  memoryDir: string,
  name: string,
  opts?: { now?: string },
): Promise<PromoteCardResult> {
  if (!isAbsolute(memoryDir)) {
    return { ok: false, blocked: 'invalid-input', reason: `memoryDir must be absolute (got ${memoryDir})` }
  }
  const filename = name.endsWith('.md') ? name : `${name}.md`
  const cardPath = join(memoryDir, filename)
  // Per-card flock: the read-prior → writeSuperseded → write-canonical sequence
  // must be atomic across processes (the same lost-update race writeExperienceCard
  // guards). promote is the /cards path that can collide with a concurrent same-slug
  // write from another process. The lock spans from the prior read THROUGH the
  // canonical write, released BEFORE the MEMORY.md index update below (no nesting of
  // the index lock ⇒ a single card-then-index order ⇒ no deadlock).
  const locked = await withCardLock(
    cardPath,
    async (): Promise<
      { early: PromoteCardResult } | { ok: true; supersededPath?: string }
    > => {
      let raw: string
      try {
        raw = await readFile(cardPath, 'utf-8')
      } catch {
        return {
          early: { ok: false, blocked: 'not-found', reason: `no card at ${cardPath}` },
        }
      }

      // Gather APPROVED sibling cards (for the dedup check) by reading the dir
      // directly — no scanner helper returns card bodies, and we must skip the
      // superseded audit copies (same hash as an old canonical would false-block).
      const siblings: { problemClass: string; markdown: string }[] = []
      try {
        const { readdir } = await import('fs/promises')
        for (const f of await readdir(memoryDir)) {
          if (!f.endsWith('.md') || f === filename || f.includes('.superseded.')) continue
          let md: string
          try {
            md = await readFile(join(memoryDir, f), 'utf-8')
          } catch {
            continue
          }
          try {
            const { frontmatter } = parseFrontmatter(md)
            const m = readCardMeta(frontmatter as Record<string, unknown>)
            if (m && m.approved) siblings.push({ problemClass: m.problemClass, markdown: md })
          } catch {
            /* skip unparseable */
          }
        }
      } catch {
        /* dir read failure: proceed with empty siblings (vacuously clean dedup) */
      }

      if (cardPromoteGateEnabled()) {
        const decision = cardPromoteGate(raw, siblings)
        if (!decision.ok) return { early: { ok: false, blocked: 'gate', reason: decision.reason } }
      }

      const promoted = promoteCardMarkdown(raw)
      if (promoted === raw) {
        // Already approved (or nothing to flip) — idempotent no-op success.
        return {
          early: { ok: true, path: cardPath, indexUpdated: false, alreadyApproved: true },
        }
      }

      // Preserve the pre-promote (candidate) copy when supersede is on — abort on a
      // preserve-write failure rather than lose it.
      let supersededPath: string | undefined
      if (cardSupersedeEnabled()) {
        try {
          supersededPath = await writeSupersededCopy(
            memoryDir,
            filename,
            raw,
            opts?.now ?? new Date().toISOString(),
          )
        } catch (e) {
          return {
            early: {
              ok: false,
              blocked: 'supersede-failed',
              reason: `could not preserve the pre-promote card (${e instanceof Error ? e.message : String(e)}) — refusing to clobber`,
            },
          }
        }
      }

      // Forward lineage edge (mirrors writeExperienceCard): the promoted
      // canonical names the pre-promote audit copy it replaced.
      await atomicWriteFile(
        cardPath,
        supersededPath
          ? stampLineageEdge(promoted, 'supersedes', basename(supersededPath))
          : promoted,
      )
      return { ok: true, supersededPath }
    },
  )
  if ('early' in locked) return locked.early
  const supersededPath = locked.supersededPath

  // Refresh the MEMORY.md index line in place: candidate → approved. Serialized +
  // atomic (same shared-file race as writeExperienceCard); best-effort on error.
  const indexPath = join(memoryDir, ENTRYPOINT_NAME)
  let indexUpdated = false
  try {
    indexUpdated = await serializeIndexUpdate(indexPath, existing => {
      const lines = existing.split('\n')
      const idx = lines.findIndex(l => l.includes(`](${filename})`))
      if (idx >= 0 && lines[idx].includes('experience-card (candidate)')) {
        lines[idx] = lines[idx].replace('experience-card (candidate)', 'experience-card (approved)')
        return lines.join('\n')
      }
      return null // no candidate line to refresh
    })
  } catch {
    /* no index yet / write error: best-effort, leave indexUpdated false */
  }

  return { ok: true, path: cardPath, supersededPath, indexUpdated, alreadyApproved: false }
}

/** One experience card as the /cards browser lists it (slug + title + meta). */
export type ExperienceCardListing = {
  /** filename without .md — the slug promoteExperienceCard takes. */
  name: string
  /** frontmatter `description` (the index hook), falling back to the slug. */
  title: string
  meta: ExperienceCardMeta
}

/**
 * Enumerate the experience cards in a memory dir for the /cards browser. Reads
 * the dir, parses each `.md`, and keeps ONLY files readCardMeta recognizes as a
 * card (type: experience-card) — ordinary memory files (user/feedback/project/
 * reference) and the superseded audit copies + MEMORY.md are skipped, so this is
 * a derived VIEW, never a mutation. Never throws (per-file guarded; a bad dir ⇒
 * []). Sorted candidates-first (the actionable ones), then by problemClass + slug.
 */
export async function listExperienceCards(memoryDir: string): Promise<ExperienceCardListing[]> {
  const { readdir } = await import('fs/promises')
  let files: string[]
  try {
    files = await readdir(memoryDir)
  } catch {
    return []
  }
  const out: ExperienceCardListing[] = []
  for (const f of files) {
    if (!f.endsWith('.md') || f.includes('.superseded.') || f === ENTRYPOINT_NAME) continue
    let md: string
    try {
      md = await readFile(join(memoryDir, f), 'utf-8')
    } catch {
      continue
    }
    try {
      const { frontmatter } = parseFrontmatter(md)
      const fm = frontmatter as Record<string, unknown>
      const meta = readCardMeta(fm)
      if (!meta) continue // not an experience card → leave it out (identity)
      const desc = typeof fm['description'] === 'string' ? (fm['description'] as string).trim() : ''
      out.push({ name: f.replace(/\.md$/, ''), title: desc || f.replace(/\.md$/, ''), meta })
    } catch {
      /* unparseable frontmatter — skip */
    }
  }
  return out.sort(
    (a, b) =>
      Number(a.meta.approved) - Number(b.meta.approved) ||
      a.meta.problemClass.localeCompare(b.meta.problemClass) ||
      a.name.localeCompare(b.name),
  )
}
