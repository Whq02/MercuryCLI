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
    const card: BuildCardInput = {
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
      ? `Banked a CANDIDATE lesson → ${output.path}. It surfaces in recall marked unverified until the operator promotes it — do NOT treat it as trusted yet.`
      : `Not banked (${output.reason}). Nothing written — this is honest, not a failure to hide.`
    return { tool_use_id: toolUseID, type: 'tool_result', content }
  },
  renderToolUseMessage: renderRememberToolUseMessage,
  renderToolResultMessage: renderRememberResultMessage,
} satisfies ToolDef<InputSchema, RememberLessonOutput>)
