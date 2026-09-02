import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { GLYPH } from '../../components/mercury-ui/glyphs.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { resolveCoordinationContext, teamBrief } from '../../services/coordination/coordinationService.js'
import { TEAM_BRIEF_TOOL_NAME } from './constants.js'
import { DESCRIPTION, TEAM_BRIEF_TOOL_PROMPT } from './prompt.js'

// The TeamBrief tool is a PROJECTION of the coordination service's brief
// (services/coordination/coordinationService.teamBrief): the model's native
// read of the team state. The in-process MCP coordination server projects the
// SAME brief for agents that call `mcp__mercury__brief`, so the two can never
// disagree — the consolidation lives in one place.

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    teamName: z.string().nullable(),
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
    // Open (unanswered) questions addressed to me.
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
      }),
    ),
    leases: z.array(
      z.object({
        agentId: z.string(),
        globs: z.array(z.string()),
        ts: z.string(),
      }),
    ),
    // Derived per-agent health (idle/busy/drifting) for this team.
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
    // Cross-agent tree conflicts (overlapping leases).
    conflicts: z
      .array(
        z.object({
          kind: z.literal('lease-overlap'),
          agents: z.tuple([z.string(), z.string()]),
          detail: z.string(),
        }),
      )
      .default([]),
    // Incoming handoffs addressed to me; unverified ones are flagged.
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
    // Team-'party' only: the router party's live lanes (the service's facet).
    party: z
      .object({
        stale: z.boolean().optional(),
        staleNote: z.string().optional(),
        seats: z.array(
          z.object({
            seat: z.string(),
            state: z.string(),
            model: z.string(),
            turnSec: z.number().optional(),
            dispatch: z.string().optional(),
            reason: z.string().optional(),
            isolation: z.string().optional(),
          }),
        ),
        dispatches: z.array(
          z.object({
            id: z.string(),
            seat: z.string(),
            state: z.string(),
            title: z.string(),
            ageSec: z.number(),
            outcome: z.string().optional(),
            nudged: z.boolean().optional(),
          }),
        ),
        recentEnvelopes: z.array(
          z.object({ from: z.string(), to: z.string(), kind: z.string(), preview: z.string() }),
        ),
      })
      .optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const TeamBriefTool = buildTool({
  name: TEAM_BRIEF_TOOL_NAME,
  searchHint:
    'consolidated team brief — open tasks, unread messages, roster, file leases',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return TEAM_BRIEF_TOOL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'TeamBrief'
  },
  isEnabled() {
    return isAgentSwarmsEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  async call(_input, context) {
    // Lead-aware resolution: a lead session has neither CLI identity args nor
    // an ALS scope — AppState teamContext (the engage seams set it) feeds the
    // resolver; teammates keep their own paths. Solo ⇒ the empty brief.
    const ctx = resolveCoordinationContext(context.getAppState().teamContext ?? undefined)
    return { data: await teamBrief(ctx) }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const {
      teamName,
      openTasks,
      unreadMessages,
      openQuestions,
      roster,
      leases,
      health,
      conflicts,
      handoffs,
      party,
    } = content as Output

    if (!teamName) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content:
          'Not part of a team. TeamBrief has nothing to report — start or join a team first.',
      }
    }

    const sections: string[] = []
    sections.push(`# Team: ${teamName}`)

    // Roster
    if (roster.length > 0) {
      const lines = roster.map(m => {
        const type = m.agentType ? ` <${m.agentType}>` : ''
        const tasks =
          m.currentTasks.length > 0
            ? ` — ${m.currentTasks.map(id => `#${id}`).join(', ')}`
            : ''
        return `- ${m.name}${type} [${m.status}]${tasks}`
      })
      sections.push(`## Roster (${roster.length})\n${lines.join('\n')}`)
    } else {
      sections.push('## Roster\n(none)')
    }

    // Open tasks
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

    // Unread messages
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

    // Open questions addressed to me — unanswered, awaiting my reply.
    if (openQuestions && openQuestions.length > 0) {
      const lines = openQuestions.map(q => {
        const preview = q.summary ?? q.text.slice(0, 120)
        return `- from ${q.from} [${q.request_id}]: ${preview}`
      })
      sections.push(
        `## Open questions (${openQuestions.length}) — reply with {"type":"answer","request_id":"..."}\n${lines.join('\n')}`,
      )
    }

    // Leases
    if (leases.length > 0) {
      const lines = leases.map(
        l => `- ${l.agentId}: ${l.globs.join(', ') || '(none)'}`,
      )
      sections.push(`## File leases (${leases.length})\n${lines.join('\n')}`)
    } else {
      sections.push('## File leases\n(none held — all paths open)')
    }

    // Derived health. Only non-idle/notable health surfaces, so a healthy
    // single-agent or all-idle team adds nothing.
    const notableHealth = (health ?? []).filter(h => h.state !== 'idle')
    if (notableHealth.length > 0) {
      const lines = notableHealth.map(h => {
        const type = h.agentType ? ` <${h.agentType}>` : ''
        return `- ${h.name}${type} [${h.state}] — ${h.why}`
      })
      sections.push(`## Health (${notableHealth.length} active)\n${lines.join('\n')}`)
    }

    // Cross-agent tree conflicts (overlapping leases). Only shown when there
    // is an actual clash.
    if (conflicts && conflicts.length > 0) {
      const lines = conflicts.map(
        c => `- ${c.agents.join(` ${GLYPH.conflict} `)}: ${c.detail}`,
      )
      sections.push(
        `## ${GLYPH.warn} Tree conflicts (${conflicts.length}) — overlapping leases, coordinate before editing\n${lines.join('\n')}`,
      )
    }

    // Incoming handoffs addressed to me. Unverified ones (a "done" success
    // claim with no evidence) are flagged loudly; verified ones list their
    // evidence count.
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

    // The router party's lanes (team 'party' only): seats with their pacing
    // signals, so the lead can tell "working, turns take minutes" from
    // "stalled" — and the staleness verdict when the daemon is gone.
    if (party) {
      const seatLines = party.seats.map(s => {
        const turn = s.turnSec !== undefined ? ` · ${s.turnSec}s into its turn` : ''
        const reason = s.reason ? ` — ${s.reason}` : ''
        return `- ${s.seat} [${s.state}] ${s.model}${turn}${reason}`
      })
      const head = party.stale ? `## Party lanes (${party.seats.length}) ${GLYPH.warn} ${party.staleNote ?? 'stale'}` : `## Party lanes (${party.seats.length})`
      sections.push(`${head}\n${seatLines.join('\n') || '(no seats)'}`)
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: sections.join('\n\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
