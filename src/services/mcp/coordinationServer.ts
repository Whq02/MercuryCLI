/* ============================================================================
   coordinationServer — the coordination service as an in-process MCP server.
   ----------------------------------------------------------------------------
   A THIN PROJECTION: every coordination verb here (lease_claim, lease_release,
   lease_list, brief, coord_say) resolves the acting context and calls
   services/coordination/coordinationService — the ONE typed owner of leases,
   the brief and team messaging. The TeamBrief tool projects the same service
   natively for the model; agents on the MCP wire see it as `mcp__mercury__*`.
   Nothing is consolidated or governed here that the service does not own.

   HOW IT RUNS: the same pattern as the Computer-Use in-process server — build
   an SDK `McpServer`, register typed tools, and connect it to the client over
   a `createLinkedTransportPair()` so there's no subprocess and no socket. The
   server is recognized by NAME in client.ts's connectToServer; its config
   entry carries `type: 'stdio'` purely so it flows through the normal
   config/connection machinery, but it is never spawned — connectToServer
   intercepts it and runs createCoordinationServer() in-process.

   NOTE on createSdkMcpServer: Mercury's SDK-facing createSdkMcpServer
   (entrypoints/agentSdkTypes.ts) is a deliberate `throw new Error('not
   implemented')` stub — that surface targets the print/stdin SDK control
   channel (setupSdkMcpClients), not interactive in-process registration. The
   genuinely-available in-process API in Mercury is McpServer +
   createLinkedTransportPair, so that's what this uses.

   DEFAULT ON, opt-out MERCURY_COORDINATION_MCP=0. When off,
   coordinationServerConfig() returns {} and the name is never reserved or
   injected — byte-identical.

   The server also carries two non-coordination projections that ride the same
   in-process transport: render_tui (the PTY capture verb) and, while
   MERCURY_MNEME is on, the MNEME topic-document memory verbs.
   ============================================================================ */

import { flagEnv } from '../../substrate/flagRegistry.js'
import type { CallToolResult } from './sdk.js'
import { z } from 'zod/v4'
import { errorMessage } from '../../utils/errors.js'
import { logMCPDebug } from '../../utils/log.js'
import {
  claimLeases,
  listTeamLeases,
  notInTeam,
  releaseLeases,
  resolveCoordinationContext,
  say,
  teamBrief,
} from '../coordination/coordinationService.js'
import type { McpServerConfig } from './types.js'
import { renderTui } from './renderTuiTool.js'

/** Reserved server name (while the in-process server is enabled). The
 *  MCP-facing name is the product's own — tools surface as `mcp__mercury__*`. */
export const COORDINATION_SERVER_NAME = 'mercury'

/** Env switch for the in-process coordination server. */
const COORDINATION_SERVER_ENV = 'MERCURY_COORDINATION_MCP'

/**
 * Is the in-process coordination server enabled?
 *
 * Ships ON, opt out with `MERCURY_COORDINATION_MCP=0` (`=== '0'` is the only
 * off-switch).
 *
 * Why default-on despite being team-only: the in-process server can only be
 * registered AT STARTUP, but teams form MID-SESSION (TeamCreate). If the server
 * were off, a team that forms later would have NO coordination tools at all —
 * the lease_claim/release/list + coord_say verbs are UNIQUE to this server (no
 * native equivalent; the lease-guard is only a reactive PreToolUse deny). So
 * exposing them from startup is what makes mid-session coordination possible.
 * Solo cost is graceful: every verb resolves the context at call time and
 * answers the service's NOT_IN_TEAM contract when there's no team, so a solo
 * session is uncluttered in behavior and the tools light up the moment a team
 * exists.
 */
export function isCoordinationServerEnabled(): boolean {
  if (flagEnv(COORDINATION_SERVER_ENV) === '0') return false
  return true
}

/** Does `name` refer to the reserved in-process coordination server? */
export function isCoordinationServer(name: string): boolean {
  return name === COORDINATION_SERVER_NAME
}

/**
 * The MCP config entry to merge into dynamicMcpConfig when the server is
 * enabled — `{}` otherwise (so it never auto-registers). `type: 'stdio'` is a
 * carrier only: connectToServer intercepts by name and runs the server
 * in-process; the command/args are never executed.
 */
export function coordinationServerConfig(): Record<string, McpServerConfig> {
  if (!isCoordinationServerEnabled()) return {}
  return {
    [COORDINATION_SERVER_NAME]: {
      type: 'stdio',
      // Inert — connectToServer never spawns this; it's intercepted by name.
      command: process.execPath,
      args: ['--coordination-server-noop'],
    },
  }
}

//
// Result shapes
//

/** Wrap a plain string as a successful CallToolResult. */
function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] }
}

/** Wrap a value as a JSON text CallToolResult. */
function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2))
}

/**
 * A structured tool result: the same JSON text for text-only consumers PLUS
 * `structuredContent` so schema-aware clients validate against the verb's
 * declared outputSchema and the work-capsule renderer gets a machine shape
 * instead of re-parsing text.
 */
function structuredJsonResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  }
}

/** Wrap an error string as an error CallToolResult. */
function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * The SOLO (no-team) no-op — the service's contract as a benign structured
 * result, not an `isError` tool result, so a solo session's coordination
 * calls read as graceful no-ops (matching `brief`, which returns a clean
 * `{ teamName: null }`).
 */
function notInTeamResult(): CallToolResult {
  return structuredJsonResult({ ...notInTeam() })
}

//
// Server construction
//

/**
 * Build the in-process coordination server. Registers the typed tools and
 * returns the McpServer; the caller connects it to a linked transport (see
 * connectToServer in client.ts). Async only to match the dynamic-import call
 * site — construction itself is synchronous.
 *
 * Returns `{ connect, close }` where `close()` tears the server down. The
 * import of @modelcontextprotocol/sdk/server/mcp.js is dynamic so this module
 * stays cheap until the server is actually enabled+connected.
 */
export async function createCoordinationServer(): Promise<{
  connect: (transport: import('./sdk.js').Transport) => Promise<void>
  close: () => Promise<void>
}> {
  const { McpServer } = await import(
    '@modelcontextprotocol/sdk/server/mcp.js'
  )

  const sdkServer = new McpServer(
    {
      name: COORDINATION_SERVER_NAME,
      title: 'Mercury Coordination',
      version: typeof MACRO !== 'undefined' ? (MACRO.VERSION ?? '0') : '0',
    },
    {
      capabilities: { tools: {} },
      instructions:
        'Mercury coordination substrate: typed tools for file leases, the ' +
        'consolidated team brief, and team-mailbox messaging. Prefer these ' +
        'over Bash for swarm coordination.',
    },
  )

  // The zod-instance boundary (see zodInstanceSeam.ts): schemas here are built
  // with OUR zod; the SDK's registerTool typing binds its NESTED zod. Route
  // registrations through this typed seam — handler args stay fully typed from
  // the inputSchema shape; the SDK call itself is a pass-through.
  type ZodShape = Record<string, z.ZodType>
  type ShapeArgs<I extends ZodShape> = { [K in keyof I]: z.output<I[K]> }
  const server = {
    registerTool<I extends ZodShape>(
      name: string,
      config: {
        title: string
        description: string
        inputSchema?: I
        outputSchema?: ZodShape
        annotations?: Record<string, boolean>
      },
      handler: (args: ShapeArgs<I>) => Promise<CallToolResult>,
    ): void {
      ;(
        sdkServer.registerTool as unknown as (
          name: string,
          config: unknown,
          handler: unknown,
        ) => void
      )(name, config, handler)
    },
  }

  // ---- lease_claim ------------------------------------------------
  server.registerTool(
    'lease_claim',
    {
      title: 'Claim file leases',
      description:
        'TEAM-ONLY — no-op when solo. ' +
        'Claim a coordination lease over one or more repo-relative path ' +
        'globs so other teammates avoid editing the same files. Returns the ' +
        'granted lease, or the first conflicting {agentId, glob} if another ' +
        'agent already holds an overlapping glob. Re-claiming renews your ' +
        'lease; claiming an empty set releases it.',
      inputSchema: {
        globs: z
          .array(z.string())
          .describe('Repo-relative path globs to lease (e.g. ["src/api/**"]).'),
      },
      // Structured output: the closed result contract — granted lease OR
      // first conflict OR the solo no-op. Clients validate against it.
      outputSchema: {
        ok: z.boolean(),
        agentId: z.string().optional(),
        globs: z.array(z.string()).optional(),
        ts: z.string().optional(),
        conflict: z.object({ agentId: z.string(), glob: z.string() }).optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ globs }): Promise<CallToolResult> => {
      const ctx = resolveCoordinationContext()
      if (!ctx) return notInTeamResult()
      try {
        return structuredJsonResult({ ...(await claimLeases(ctx, globs)) })
      } catch (e) {
        return errorResult(`lease_claim failed: ${errorMessage(e)}`)
      }
    },
  )

  // ---- lease_release ----------------------------------------------
  server.registerTool(
    'lease_release',
    {
      title: 'Release your file leases',
      description:
        'TEAM-ONLY — no-op when solo. ' +
        'Release all leases held by this agent on the team (idempotent — a ' +
        'no-op if you hold none). Returns whether a lease was dropped.',
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        agentId: z.string().optional(),
        released: z.boolean().optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (): Promise<CallToolResult> => {
      const ctx = resolveCoordinationContext()
      if (!ctx) return notInTeamResult()
      try {
        return structuredJsonResult({ ...(await releaseLeases(ctx)) })
      } catch (e) {
        return errorResult(`lease_release failed: ${errorMessage(e)}`)
      }
    },
  )

  // ---- lease_list -------------------------------------------------
  server.registerTool(
    'lease_list',
    {
      title: 'List current file leases',
      description:
        'TEAM-ONLY — no-op when solo. ' +
        'List all current (non-expired) file leases on the team — each ' +
        "agent's held globs and when they claimed them.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        leases: z
          .array(z.object({ agentId: z.string(), globs: z.array(z.string()), ts: z.string() }))
          .optional(),
        reason: z.string().optional(),
        message: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      const ctx = resolveCoordinationContext()
      if (!ctx) return notInTeamResult()
      try {
        return structuredJsonResult({ ok: true, leases: await listTeamLeases(ctx) })
      } catch (e) {
        return errorResult(`lease_list failed: ${errorMessage(e)}`)
      }
    },
  )

  // ---- brief ------------------------------------------------------
  server.registerTool(
    'brief',
    {
      title: 'Consolidated team brief',
      description:
        'TEAM-ONLY — no-op when solo. ' +
        'A consolidated read of the team state: open tasks, your unread ' +
        'messages and open questions, the roster, current file leases, ' +
        'derived agent health, tree conflicts, handoffs to you, and (on the ' +
        "router party) the party's live lanes. The same brief the TeamBrief " +
        'tool produces — read-only.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      try {
        return jsonResult(await teamBrief(resolveCoordinationContext()))
      } catch (e) {
        return errorResult(`brief failed: ${errorMessage(e)}`)
      }
    },
  )

  // ---- coord_say --------------------------------------------------
  server.registerTool(
    'coord_say',
    {
      title: 'Message a teammate or broadcast',
      description:
        'TEAM-ONLY — no-op when solo. ' +
        'Send a coordination message to a teammate by name, or broadcast to ' +
        'all teammates with to="*". Writes to the team mailbox the same way ' +
        'the SendMessage tool does, under the same broadcast governance.',
      inputSchema: {
        to: z
          .string()
          .describe('Recipient teammate name, or "*" to broadcast to all.'),
        message: z.string().describe('The message text to deliver.'),
        summary: z
          .string()
          .optional()
          .describe('Optional 5-10 word preview shown in the UI.'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ to, message, summary }): Promise<CallToolResult> => {
      const ctx = resolveCoordinationContext()
      if (!ctx) return notInTeamResult()
      try {
        const result = await say(ctx, to, message, summary)
        // A refusal (governance, an unknown recipient, a missing team) is a
        // tool error — never a dead-inbox write reported as success.
        if ('refused' in result) return errorResult(to === '*' ? result.refused : `coord_say: ${result.refused}`)
        return jsonResult(result)
      } catch (e) {
        return errorResult(`coord_say failed: ${errorMessage(e)}`)
      }
    },
  )

  // ---- render_tui -------------------------------------------------
  server.registerTool(
    'render_tui',
    {
      title: 'Render the Mercury TUI to a PNG image',
      description:
        'Capture the real Mercury TUI in a PTY and return it as a PNG image. ' +
        'Use to visually verify a UI/Ink change before claiming it works ' +
        '(REPL/Ink changes do not show in headless -p output). ' +
        'Args: scenario (default resume-2turn), cols (default 120), rows ' +
        '(default 44). Returns an inline image block.',
      inputSchema: {
        scenario: z.string().optional(),
        cols: z.number().optional(),
        rows: z.number().optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ scenario, cols, rows }): Promise<CallToolResult> =>
      renderTui({ scenario, cols, rows }),
  )

  // ---- MNEME topic-document memory verbs (paper-triad Slice B) -------------
  // Registered ONLY while MERCURY_MNEME is on at server construction (session
  // boot) — flag off ⇒ the verbs are absent from the catalog entirely, and
  // every handler re-checks live so a mid-session =0 flip refuses instead of
  // acting (the authority-toggles invariant). The retrieval loop is the model
  // driving these tools iteratively: catalog → grep → read (arXiv:2606.10677).
  const { mnemeEnabled } = await import('../../memdir/mnemeGates.js')
  if (mnemeEnabled()) {
    const offResult = (): CallToolResult => errorResult('MNEME is disabled (MERCURY_MNEME is not on).')

    server.registerTool(
      'mneme_observe',
      {
        title: 'Record an observation into MNEME',
        description:
          'Append one observation (a fact, decision, or event worth remembering ' +
          'across sessions) to the MNEME CURRENT buffer. It consolidates into ' +
          'topic documents automatically at thresholds. Pass source as WHERE the ' +
          'fact came from (e.g. "gate output", "operator", "session"), never a ' +
          'paraphrase of it; topicHint routes it to a topic document.',
        inputSchema: {
          text: z.string().describe('The observation itself — one self-contained fact.'),
          source: z.string().describe('Provenance: where this fact was captured from.'),
          topicHint: z.string().optional().describe('Topic to file under (slugified).'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ text, source, topicHint }): Promise<CallToolResult> => {
        if (!mnemeEnabled()) return offResult()
        try {
          const { appendObservation } = await import('../../memdir/mnemeBuffer.js')
          const { maybeConsolidate } = await import('../../memdir/mnemeConsolidate.js')
          const written = appendObservation({ text, source, topicHint })
          if (!written) return errorResult('observation refused (empty text/source or MNEME off)')
          const consolidation = maybeConsolidate()
          return jsonResult({
            ok: true,
            consolidated: consolidation.consolidated,
            ...(consolidation.consolidated ? { docsTouched: consolidation.docsTouched } : {}),
          })
        } catch (e) {
          return errorResult(`mneme_observe failed: ${errorMessage(e)}`)
        }
      },
    )

    server.registerTool(
      'mneme_catalog',
      {
        title: 'List MNEME topic documents',
        description:
          'The MNEME routing table: id + one-line summary + size of every topic ' +
          'document in the library, PLUS an honest summary of unconsolidated ' +
          'recent observations (count + topics) so a just-recorded fact is ' +
          'never invisible. Start retrieval here, then mneme_grep / ' +
          'mneme_read into the right document.',
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async (): Promise<CallToolResult> => {
        if (!mnemeEnabled()) return offResult()
        try {
          const { catalogDocs, pendingSummary } = await import('../../memdir/mnemeRetrieval.js')
          const recent = pendingSummary()
          return jsonResult({ docs: catalogDocs(), ...(recent ? { recent } : {}) })
        } catch (e) {
          return errorResult(`mneme_catalog failed: ${errorMessage(e)}`)
        }
      },
    )

    server.registerTool(
      'mneme_grep',
      {
        title: 'Grep the MNEME library',
        description:
          'Search every topic document AND the unconsolidated recent buffer ' +
          'for a pattern (regex, case-insensitive; falls back to literal). ' +
          "Buffer hits carry the '(recent)' slug and an [unconsolidated, …] " +
          'label. Follow up with mneme_read for the surrounding heading block.',
        inputSchema: {
          pattern: z.string().describe('Regex or literal to search for.'),
          maxHits: z.number().optional().describe('Cap (default 20, max 100).'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async ({ pattern, maxHits }): Promise<CallToolResult> => {
        if (!mnemeEnabled()) return offResult()
        try {
          const { grepAll } = await import('../../memdir/mnemeRetrieval.js')
          return jsonResult({ hits: grepAll(pattern, { maxHits }) })
        } catch (e) {
          return errorResult(`mneme_grep failed: ${errorMessage(e)}`)
        }
      },
    )

    server.registerTool(
      'mneme_grep_doc',
      {
        title: 'Grep one MNEME topic document',
        description: 'Search a single topic document (by slug) for a pattern.',
        inputSchema: {
          slug: z.string().describe('Topic slug (from mneme_catalog, without the topic- prefix).'),
          pattern: z.string().describe('Regex or literal to search for.'),
          maxHits: z.number().optional(),
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async ({ slug, pattern, maxHits }): Promise<CallToolResult> => {
        if (!mnemeEnabled()) return offResult()
        try {
          const { grepDoc } = await import('../../memdir/mnemeRetrieval.js')
          return jsonResult({ hits: grepDoc(slug, pattern, { maxHits }) })
        } catch (e) {
          return errorResult(`mneme_grep_doc failed: ${errorMessage(e)}`)
        }
      },
    )

    server.registerTool(
      'mneme_read',
      {
        title: 'Read a MNEME topic document range',
        description:
          'Read lines from a topic document, EXPANDED to the enclosing ## ' +
          'heading block; omit from/to for the whole document. Also returns the ' +
          'most recent unconsolidated observations so just-recorded facts are ' +
          'never invisible.',
        inputSchema: {
          slug: z.string().describe('Topic slug (from mneme_catalog).'),
          from: z.number().optional().describe('1-based start line.'),
          to: z.number().optional().describe('1-based end line.'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async ({ slug, from, to }): Promise<CallToolResult> => {
        if (!mnemeEnabled()) return offResult()
        try {
          const { readDocLines } = await import('../../memdir/mnemeRetrieval.js')
          const r = readDocLines(slug, { from, to })
          if (!r) return errorResult(`no topic document '${slug}' (see mneme_catalog)`)
          return jsonResult(r)
        } catch (e) {
          return errorResult(`mneme_read failed: ${errorMessage(e)}`)
        }
      },
    )

    server.registerTool(
      'mneme_correct',
      {
        title: 'Correct a MNEME fact (supersede by seq)',
        description:
          'Replace a CURRENT fact with a corrected one. Pass the seq of the ' +
          'entry being corrected (from mneme_grep/mneme_read signatures) and ' +
          'the full corrected statement. The old entry is RETAINED under ' +
          '## history, stamped superseded-by; only the correction is current ' +
          'afterwards. Use this instead of recording a contradicting ' +
          'observation — adjacent contradictions must supersede, not coexist.',
        inputSchema: {
          seq: z.number().describe('The seq of the CURRENT entry being corrected.'),
          text: z.string().describe('The corrected fact — one self-contained statement.'),
          source: z.string().optional().describe('Provenance of the correction (default "session").'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ seq, text, source }): Promise<CallToolResult> => {
        if (!mnemeEnabled()) return offResult()
        try {
          const { correctFact } = await import('../../memdir/mnemeCorrect.js')
          const r = correctFact({ targetSeq: seq, text, source: source ?? 'session' })
          return r.ok ? jsonResult(r) : errorResult(`mneme_correct: [${r.code}] ${r.message}`)
        } catch (e) {
          return errorResult(`mneme_correct failed: ${errorMessage(e)}`)
        }
      },
    )

    server.registerTool(
      'mneme_retire',
      {
        title: 'Retire a MNEME fact (no longer current)',
        description:
          'Mark a CURRENT fact as no longer current WITHOUT a replacement. ' +
          'The entry moves to ## history with a retirement record naming the ' +
          'reason; nothing stays live. Use when a fact stopped being true and ' +
          'has no successor (e.g. a decommissioned system).',
        inputSchema: {
          seq: z.number().describe('The seq of the CURRENT entry to retire.'),
          reason: z.string().describe('Why it is no longer current.'),
          source: z.string().optional().describe('Provenance (default "session").'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      async ({ seq, reason, source }): Promise<CallToolResult> => {
        if (!mnemeEnabled()) return offResult()
        try {
          const { retireFact } = await import('../../memdir/mnemeCorrect.js')
          const r = retireFact({ targetSeq: seq, reason, source: source ?? 'session' })
          return r.ok ? jsonResult(r) : errorResult(`mneme_retire: [${r.code}] ${r.message}`)
        } catch (e) {
          return errorResult(`mneme_retire failed: ${errorMessage(e)}`)
        }
      },
    )
  }

  logMCPDebug(
    COORDINATION_SERVER_NAME,
    'In-process coordination server constructed',
  )

  return {
    connect: transport => sdkServer.connect(transport),
    close: () => sdkServer.close(),
  }
}
