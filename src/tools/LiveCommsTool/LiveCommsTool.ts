import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import {
  resolveCoordinationContext,
  crewBrief,
  writeLiveComms,
  type LiveCommsReceipt,
  type LiveCommsWrites,
} from '../../services/coordination/coordinationService.js'
import { LIVE_COMMS_TOOL_NAME } from './constants.js'
import { DESCRIPTION, LIVE_COMMS_TOOL_PROMPT } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    say: z
      .strictObject({
        to: z.string().describe('A crewmate name, or "*" for everyone'),
        message: z.string().describe('The message'),
        summary: z.string().optional().describe('A 5-10 word preview'),
      })
      .optional()
      .describe('A message to write; delivered exactly as a SendMessage plain message is'),
    task: z
      .strictObject({
        id: z.string().optional().describe('An existing task to move; omit to open a new one'),
        subject: z.string().optional().describe('What the task is (required for a new task)'),
        detail: z.string().optional(),
        status: z.enum(['pending', 'in_progress', 'completed']).optional(),
        owner: z.string().optional().describe('The crewmate it belongs to'),
        blockedBy: z.array(z.string()).optional().describe('Task ids this one waits on'),
      })
      .optional()
      .describe('A crew task to open or move'),
    claim: z
      .strictObject({
        paths: z.array(z.string()).describe('Repo-relative paths or globs to claim for yourself'),
      })
      .optional()
      .describe('A file claim; a path another crewmate holds is refused with the holder named'),
    release: z.boolean().optional().describe('true releases every claim you hold'),
    busy: z
      .union([
        z.boolean(),
        z.strictObject({ busy: z.boolean(), doing: z.string().optional().describe('In a word, what you are doing') }),
      ])
      .optional()
      .describe('Whether you are working, and on what'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    crewName: z.string().nullable(),
    openTasks: z.array(
      z.object({
        id: z.string(),
        subject: z.string(),
        status: z.string(),
        owner: z.string().optional(),
        blockedBy: z.array(z.string()),
      }),
    ),
    unreadMessages: z.array(
      z.object({
        from: z.string(),
        text: z.string(),
        timestamp: z.string(),
        summary: z.string().optional(),
      }),
    ),
    openQuestions: z.array(
      z.object({
        request_id: z.string(),
        from: z.string(),
        text: z.string(),
        summary: z.string().optional(),
        askedAt: z.string(),
      }),
    ).default([]),
    roster: z.array(
      z.object({
        name: z.string(),
        agentType: z.string().optional(),
        status: z.string(),
        currentTasks: z.array(z.string()),
        doing: z.string().optional(),
      }),
    ),
    leases: z.array(
      z.object({
        agentId: z.string(),
        globs: z.array(z.string()),
        ts: z.string(),
      }),
    ),
    health: z
      .array(
        z.object({
          name: z.string(),
          agentType: z.string().optional(),
          state: z.enum(['idle', 'busy', 'drifting']),
          currentTasks: z.array(z.string()),
          leaseAgeMs: z.number().nullable(),
          why: z.string(),
        }),
      )
      .default([]),
    conflicts: z
      .array(
        z.object({
          kind: z.literal('lease-overlap'),
          agents: z.tuple([z.string(), z.string()]),
          detail: z.string(),
        }),
      )
      .default([]),
    handoffs: z
      .array(
        z.object({
          id: z.string(),
          from: z.string(),
          status: z.string(),
          summary: z.string(),
          verified: z.boolean(),
          unverifiedReason: z.string().optional(),
          evidenceCount: z.number(),
          sentAt: z.string(),
        }),
      )
      .default([]),
    wrote: z
      .array(
        z.object({
          kind: z.enum(['message', 'task', 'claim', 'release', 'busy']),
          ok: z.boolean(),
          detail: z.string(),
        }),
      )
      .optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function writesOf(input: Input | undefined): LiveCommsWrites | null {
  if (!input) return null
  const writes: LiveCommsWrites = {}
  if (input.say !== undefined) writes.say = input.say
  if (input.task !== undefined) writes.task = input.task
  if (input.claim !== undefined) writes.claim = input.claim
  if (input.release === true) writes.release = true
  if (input.busy !== undefined) writes.busy = input.busy
  return Object.keys(writes).length === 0 ? null : writes
}

function writeWords(input: Input | undefined): string {
  const parts: string[] = []
  if (input?.say !== undefined) parts.push(`say → ${input.say.to}`)
  if (input?.task !== undefined) parts.push(input.task.id !== undefined ? `task #${input.task.id}` : 'task')
  if (input?.claim !== undefined) parts.push(`claim ${input.claim.paths.join(', ')}`)
  if (input?.release === true) parts.push('release')
  if (input?.busy !== undefined) {
    const busy = typeof input.busy === 'boolean' ? input.busy : input.busy.busy
    parts.push(busy ? 'busy' : 'idle')
  }
  return parts.length === 0 ? 'read' : parts.join(' · ')
}

export const LiveCommsTool = buildTool({
  shouldDefer: true,
  name: LIVE_COMMS_TOOL_NAME,
  searchHint:
    'live crew communication — messages, tasks, file claims, who is busy; read and write',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return LIVE_COMMS_TOOL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return LIVE_COMMS_TOOL_NAME
  },
  isEnabled() {
    return isAgentSwarmsEnabled()
  },
  isConcurrencySafe(input: Input) {
    return writesOf(input) === null
  },
  isReadOnly(input: Input) {
    return writesOf(input) === null
  },
  toAutoClassifierInput(input: Input) {
    return `${LIVE_COMMS_TOOL_NAME} ${writeWords(input)}`
  },
  renderToolUseMessage(input: Input) {
    return writeWords(input)
  },
  async call(input, context) {
    const ctx = resolveCoordinationContext(context.getAppState().crewContext ?? undefined)
    const writes = writesOf(input)
    const wrote: LiveCommsReceipt[] | undefined = ctx !== null && writes !== null ? await writeLiveComms(ctx, writes) : undefined
    const brief = await crewBrief(ctx)
    return { data: wrote === undefined ? brief : { ...brief, wrote } }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const {
      crewName,
      openTasks,
      unreadMessages,
      openQuestions,
      roster,
      leases,
      health,
      conflicts,
      handoffs,
      wrote,
    } = content as Output

    if (!crewName) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content:
          `Not part of a crew. ${LIVE_COMMS_TOOL_NAME} has nothing to report — start or join a crew first.`,
      }
    }

    const sections: string[] = []
    sections.push(`# Crew: ${crewName}`)

    if (wrote && wrote.length > 0) {
      const lines = wrote.map(w => `- ${w.kind}: ${w.ok ? 'ok' : 'REFUSED'} — ${w.detail}`)
      sections.push(`## Written (${wrote.length})\n${lines.join('\n')}`)
    }

    if (roster.length > 0) {
      const lines = roster.map(m => {
        const type = m.agentType ? ` <${m.agentType}>` : ''
        const status = m.doing !== undefined ? `${m.status}: ${m.doing}` : m.status
        const tasks =
          m.currentTasks.length > 0
            ? ` — ${m.currentTasks.map(id => `#${id}`).join(', ')}`
            : ''
        return `- ${m.name}${type} [${status}]${tasks}`
      })
      sections.push(`## Roster (${roster.length})\n${lines.join('\n')}`)
    } else {
      sections.push('## Roster\n(none)')
    }

    if (openTasks.length > 0) {
      const lines = openTasks.map(t => {
        const owner = t.owner ? ` (${t.owner})` : ''
        const blocked =
          t.blockedBy.length > 0
            ? ` [blocked by ${t.blockedBy.map(id => `#${id}`).join(', ')}]`
            : ''
        return `#${t.id} [${t.status}] ${t.subject}${owner}${blocked}`
      })
      sections.push(`## Open tasks (${openTasks.length})\n${lines.join('\n')}`)
    } else {
      sections.push('## Open tasks\n(none)')
    }

    if (unreadMessages.length > 0) {
      const lines = unreadMessages.map(m => {
        const preview = m.summary ?? m.text.slice(0, 120)
        return `- from ${m.from}: ${preview}`
      })
      sections.push(
        `## Unread messages (${unreadMessages.length})\n${lines.join('\n')}`,
      )
    } else {
      sections.push('## Unread messages\n(none)')
    }

    if (openQuestions && openQuestions.length > 0) {
      const lines = openQuestions.map(q => {
        const preview = q.summary ?? q.text.slice(0, 120)
        return `- from ${q.from} [${q.request_id}]: ${preview}`
      })
      sections.push(
        `## Open questions (${openQuestions.length}) — reply with {"type":"answer","request_id":"..."}\n${lines.join('\n')}`,
      )
    }

    if (leases.length > 0) {
      const lines = leases.map(
        l => `- ${l.agentId}: ${l.globs.join(', ') || '(none)'}`,
      )
      sections.push(`## File claims (${leases.length})\n${lines.join('\n')}`)
    } else {
      sections.push('## File claims\n(none held — all paths open)')
    }

    const notableHealth = (health ?? []).filter(h => h.state !== 'idle')
    if (notableHealth.length > 0) {
      const lines = notableHealth.map(h => {
        const type = h.agentType ? ` <${h.agentType}>` : ''
        return `- ${h.name}${type} [${h.state}] — ${h.why}`
      })
      sections.push(`## Health (${notableHealth.length} active)\n${lines.join('\n')}`)
    }

    if (conflicts && conflicts.length > 0) {
      const lines = conflicts.map(
        c => `- ${c.agents.join(` ${GLYPH.conflict} `)}: ${c.detail}`,
      )
      sections.push(
        `## ${GLYPH.warn} Tree conflicts (${conflicts.length}) — overlapping claims, coordinate before editing\n${lines.join('\n')}`,
      )
    }

    if (handoffs && handoffs.length > 0) {
      const lines = handoffs.map(h => {
        if (!h.verified) {
          return `- from ${h.from} [${h.status}] ${GLYPH.warn} UNVERIFIED (no evidence backing a success claim): ${h.summary}`
        }
        const ev = h.evidenceCount > 0 ? ` (${h.evidenceCount} evidence ref(s))` : ''
        return `- from ${h.from} [${h.status}]${ev}: ${h.summary}`
      })
      sections.push(
        `## Handoffs to me (${handoffs.length})\n${lines.join('\n')}`,
      )
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: sections.join('\n\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
