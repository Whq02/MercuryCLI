import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import {
  type BuildCardInput,
  cardTraceGroundEnabled,
  writeExperienceCard,
} from '../../memdir/experienceCards.js'
import { harvestCardEvidence } from '../../memdir/evidenceHarvest.js'
import { getCwd } from '../../utils/cwd.js'
import { stageScribeNote } from '../../memdir/scribePromote.js'
import { deriveSlug } from '../../commands/remember/remember.js'
import {
  REMEMBER_LESSON_DESCRIPTION,
  REMEMBER_LESSON_TOOL_NAME,
  buildRememberLessonPrompt,
  isRememberLessonEnabled,
} from './prompt.js'
import { renderRememberResultMessage, renderRememberToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    problemClass: z.string().describe('short kebab category — the dedup + recall key (e.g. "fork-gating")'),
    lesson: z.string().describe('the transferable lesson (the card body); concrete + actionable'),
    title: z.string().describe('one-line human title'),
    summary: z.string().describe('one-line index hook (frontmatter description)'),
    sourceRefs: z.array(z.string()).optional().describe('commit SHAs / file paths (scanned for secrets too)'),
    appliesWhen: z.string().optional().describe('one-line "applies when …" regime cue'),
    notWhen: z.string().optional().describe('one-line "NOT when …" guard against over-recall'),
    scope: z
      .enum(['card', 'scribe'])
      .optional()
      .describe(
        'where to bank it. "card" (default) = a recall-visible experience card (requires greenGatePassed). "scribe" = a COMPACT, recall-EXCLUDED note in the scribe scope — a working memo the operator later ratifies; use in Scribe mode to checkpoint session state WITHOUT poisoning recall (hard-capped + secret-refusing).',
      ),
    greenGatePassed: z
      .boolean()
      .describe('did the originating work pass the project green-gate? only bank verified lessons'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    banked: z.boolean(),
    path: z.string().optional(),
    reason: z.string().optional(),
    // 'scribe' ⇒ a staged scribe-scope note (recall-excluded) rather than a card.
    scope: z.enum(['card', 'scribe']).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type RememberLessonOutput = z.infer<OutputSchema>

export const RememberLessonTool = buildTool({
  name: REMEMBER_LESSON_TOOL_NAME,
  searchHint: 'bank a transferable lesson you verified as an experience card for future sessions',
  maxResultSizeChars: 20_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isRememberLessonEnabled()
  },
  toAutoClassifierInput(input) {
    return `${input.problemClass}: ${input.title}`
  },
  async description() {
    return REMEMBER_LESSON_DESCRIPTION
  },
  async prompt() {
    return buildRememberLessonPrompt()
  },
  getPath() {
    return getAutoMemPath()
  },
  async call(input) {
    // Scribe-scope route — wires the previously-severed stageScribeNote: a COMPACT,
    // recall-EXCLUDED working note staged into the scribe scope, ratified LATER by
    // promoteScribeCandidate (operator-invoked, never automatic — the `/scribe-promote`
    // command lists candidates + ratifies the selected one; see commands/scribe-promote).
    // Reuses the staging floor (hard cap + secret refusal + idempotent-by-name). Gated
    // identically to the card path (isEnabled).
    if (input.scope === 'scribe') {
      const staged = await stageScribeNote(input.title || input.problemClass, input.lesson, {
        description: input.summary,
      })
      if (staged.ok) return { data: { banked: true, path: staged.path, scope: 'scribe' } }
      const why =
        staged.reason === 'secret' ? 'looked secret-bearing — refused' : 'empty body — nothing to stage'
      return { data: { banked: false, reason: why, scope: 'scribe' } }
    }
    // The agent supplies STRUCTURED fields (vs /remember's free-text derivation). Card is born
    // a CANDIDATE (approved:false); shouldDistill (via {signal}) refuses secrets/trivia and
    // requires greenGatePassed; writeExperienceCard dedups + indexes MEMORY.md. createdAt is
    // injected here (the builder is pure). The enforcement floor is untouched — this only WRITES.
    const card: BuildCardInput = {
      // Pass a content-based disambiguator (problemClass+lesson) like the free-text
      // /remember path (remember.ts:72) — WITHOUT it the slug is a pure function of
      // the title, so two DISTINCT lessons sharing a title collide on one filename
      // (clobber when MERCURY_CARD_SUPERSEDE=0, silent recall-loss when ON since the
      // .superseded.* copy is excluded from recall). Identical lessons still map to
      // one stable slug (the intended supersede).
      name: deriveSlug(
        input.title || input.problemClass,
        `${input.problemClass}\n${input.lesson}`,
      ),
      title: input.title,
      summary: input.summary,
      problemClass: input.problemClass,
      lesson: input.lesson,
      sourceRefs: input.sourceRefs ?? [],
      appliesWhen: input.appliesWhen,
      notWhen: input.notWhen,
      approved: false,
      createdAt: new Date().toISOString(),
      greenGate: input.greenGatePassed === true,
    }
    // Trace-grounding family (MERCURY_CARD_TRACE_GROUND — the same knob as the
    // anchor gate): on a green-gate bank, harvest primary-source evidence the
    // HARNESS can verify (git-stat of a SHA sourceRef + an argless trace-tail
    // aggregate) so the card carries proven context beside the authored lesson
    // (Socratic-SWE / Honest-Lying). Best-effort: an empty harvest is an
    // honest absence, never an error.
    if (cardTraceGroundEnabled() && input.greenGatePassed === true) {
      card.harvestedEvidence = await harvestCardEvidence({
        sourceRefs: card.sourceRefs,
        cwd: getCwd(),
      })
    }
    const res = await writeExperienceCard(getAutoMemPath(), card, {
      signal: {
        greenGatePassed: input.greenGatePassed === true,
        operatorSignal: false,
        lesson: input.lesson,
        sourceRefs: input.sourceRefs,
      },
    })
    if (res.ok) return { data: { banked: true, path: res.path } }
    const reason = res.blocked + ('reason' in res && res.reason ? `: ${res.reason}` : '')
    return { data: { banked: false, reason } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const content = output.banked
      ? output.scope === 'scribe'
        ? `Staged a scribe-scope note → ${output.path}. It is EXCLUDED from recall (a compact working memo) until the operator ratifies it — do NOT rely on it as a trusted lesson yet.`
        : `Banked a CANDIDATE lesson → ${output.path}. It surfaces in recall marked unverified until the operator promotes it — do NOT treat it as trusted yet.`
      : `Not banked (${output.reason}). Nothing written — this is honest, not a failure to hide.`
    return { tool_use_id: toolUseID, type: 'tool_result', content }
  },
  renderToolUseMessage: renderRememberToolUseMessage,
  renderToolResultMessage: renderRememberResultMessage,
} satisfies ToolDef<InputSchema, RememberLessonOutput>)
