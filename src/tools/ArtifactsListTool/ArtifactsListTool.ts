import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { getCwd } from '../../utils/cwd.js'
import {
  getArtifact,
  listArtifacts,
  scopeSlugForDir,
} from '../../utils/artifacts/store.js'
import { ARTIFACTS_LIST_TOOL_NAME } from './constants.js'
import { DESCRIPTION, ARTIFACTS_LIST_TOOL_PROMPT } from './prompt.js'

/**
 * ARTIFACTS — read-only retrieval of durable run outputs.
 *
 * Autonomous daemon/fleet runs persist their final output as an artifact (see
 * utils/artifacts/store.ts; the old fire path's gated writer retired —
 * the store reads legacy artifacts and any future writer). This
 * tool is the READ side: a later session/agent lists the recent artifacts for
 * the current project scope and optionally pulls one back by id — so a prior
 * run's output is recallable instead of vanishing.
 *
 * Gated on isAgentSwarmsEnabled() like the other team/swarm tools, so it never
 * appears for a non-swarm session (default-no-op for current behavior). The
 * scope is derived from the session cwd via the SAME scopeSlugForDir the daemon
 * uses, so a read lands in the directory a daemon write produced.
 */

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z
      .string()
      .optional()
      .describe(
        'Retrieve this artifact by id (returns its full content + metadata). Omit to LIST recent artifacts for the current project.',
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe('Max number of artifacts to list (newest first). Default 25.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const metaShape = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  createdAt: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  truncated: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})

const outputSchema = lazySchema(() =>
  z.object({
    scope: z.string(),
    // The requested-id retrieval (null when no id was passed or it was unknown).
    artifact: z
      .object({
        meta: metaShape,
        content: z.string(),
      })
      .nullable()
      .default(null),
    // The listing (present when no id was passed).
    artifacts: z.array(metaShape).default([]),
    // Set when a requested id was not found.
    notFound: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

const DEFAULT_LIST_LIMIT = 25

export const ArtifactsListTool = buildTool({
  name: ARTIFACTS_LIST_TOOL_NAME,
  searchHint:
    'list durable artifacts (outputs persisted by prior daemon/fleet runs) and retrieve one by id',
  maxResultSizeChars: 200_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return ARTIFACTS_LIST_TOOL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'ArtifactsList'
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
  async call(input) {
    const scope = scopeSlugForDir(getCwd())

    // Retrieval path: a specific id was requested.
    if (input.id) {
      const retrieved = await getArtifact(scope, input.id)
      if (!retrieved) {
        return {
          data: {
            scope,
            artifact: null,
            artifacts: [],
            notFound: input.id,
          },
        }
      }
      return {
        data: {
          scope,
          artifact: {
            meta: {
              ...retrieved.meta,
              kind: retrieved.meta.kind ?? 'output',
              metadata: retrieved.meta.metadata ?? {},
            },
            content: retrieved.content,
          },
          artifacts: [],
        },
      }
    }

    // Listing path.
    const limit = input.limit ?? DEFAULT_LIST_LIMIT
    const all = await listArtifacts(scope)
    const artifacts = all.slice(0, limit).map(m => ({
      id: m.id,
      name: m.name,
      kind: m.kind ?? 'output',
      createdAt: m.createdAt,
      sizeBytes: m.sizeBytes,
      sha256: m.sha256,
      ...(m.truncated ? { truncated: true } : {}),
      metadata: m.metadata ?? {},
    }))

    return {
      data: {
        scope,
        artifact: null,
        artifacts,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { scope, artifact, artifacts, notFound } = content as Output

    // Retrieval result.
    if (notFound) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `No artifact with id "${notFound}" in scope ${scope}. List artifacts (call with no id) to see what's available.`,
      }
    }

    if (artifact) {
      const m = artifact.meta
      const header =
        `# Artifact ${m.id}\n` +
        `name: ${m.name} · kind: ${m.kind} · created: ${m.createdAt} · ` +
        `${m.sizeBytes} bytes${m.truncated ? ' (truncated)' : ''}`
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `${header}\n\n${artifact.content}`,
      }
    }

    // Listing result.
    if (artifacts.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `No artifacts persisted for this project (scope ${scope}). Autonomous/daemon runs persist their outputs here when artifact capture is enabled.`,
      }
    }

    const lines = artifacts.map(m => {
      const trunc = m.truncated ? ' (truncated)' : ''
      return `- ${m.id} [${m.kind}] ${m.name} — ${m.createdAt}, ${m.sizeBytes} bytes${trunc}`
    })
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        `# Artifacts (${artifacts.length}) — scope ${scope}\n` +
        `${lines.join('\n')}\n\n` +
        `Retrieve one with ${ARTIFACTS_LIST_TOOL_NAME} { "id": "<id>" }.`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
