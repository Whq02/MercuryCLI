// ============================================================================
//  Inspect tool — the model's read surface over the mercury:// resource
//  plane. ONE resolver (services/resources/registry.ts)
//  maps refs to Mercury's durable work graph: files, runs, receipts, tasks,
//  teams, workflows, artifacts, the health certificate, session agents — and
//  the kinds later slices register (services, lanes).
//
//  Honesty floor: a missing object is NEVER an empty object — absent /
//  expired / unavailable / busy are distinct, explicit answers.
// ============================================================================

import { z } from 'zod/v4'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import {
  mercuryRefsEnabled,
  MERCURY_REF_SCHEME,
} from '../../services/resources/contracts.js'
import {
  resolveResource,
  resourceAdapterKinds,
} from '../../services/resources/registry.js'
import { ownerFromToolUseContext } from '../../services/run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
} from './UI.js'

export const INSPECT_TOOL_NAME = 'Inspect' as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    ref: z
      .string()
      .describe(
        'A mercury:// ref — mercury://<kind>/<id>[?lines=A-B&q=…&cursor=N&limit=N&child=name]. mercury://<kind> with no id lists that kind.',
      ),
  }),
)
type SchemaType = ReturnType<typeof inputSchema>
export type Input = z.infer<SchemaType>
export type Output = {
  ref: string
  state: 'ok' | 'absent' | 'expired' | 'unavailable' | 'busy'
  result: string
  kind?: string
  title?: string
  version?: string
}

function kindsLine(): string {
  return resourceAdapterKinds()
    .map(k => `  ${k.kind} — ${k.describe}`)
    .join('\n')
}

export const InspectTool = buildTool({
  name: INSPECT_TOOL_NAME,
  searchHint:
    'inspect Mercury work-graph objects by mercury:// ref (runs, receipts, tasks, teams, workflows, artifacts, agents, health)',
  maxResultSizeChars: 100_000,
  strict: true,
  isEnabled() {
    return mercuryRefsEnabled()
  },
  async description() {
    return "Inspect Mercury's durable work graph by mercury:// reference"
  },
  async prompt() {
    return `Inspect any Mercury work-graph object through one typed reference: mercury://<kind>/<id>.

Known kinds:
${kindsLine()}

Selectors (append as ?key=value&…): lines=A-B (text range) · q=substring (filter lines) · cursor=N + limit=N (pagination) · child=name (a named sub-resource, e.g. a workflow agent).

mercury://<kind> with no id lists that kind's objects. Answers are honest: absent (never existed) / expired (retention dropped it) / unavailable (subsystem off) are distinct — an empty listing means genuinely empty. Full payloads stay behind refs: results are bounded pages; follow the cursor rather than raising the limit.

Use Inspect when a tool result or teammate hands you a mercury:// ref, or to check run/receipt/workflow/service state without replaying transcripts. For plain file content, Read remains the primary tool (Inspect's file kind exists for uniformity and directory listings).`
  },
  userFacingName() {
    return 'Inspect'
  },
  getToolUseSummary(input?: Partial<Input>) {
    return input?.ref ?? null
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async checkPermissions(input: Input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async validateInput(input: Input) {
    if (!input.ref.startsWith(MERCURY_REF_SCHEME)) {
      return {
        result: false as const,
        message: `ref must start with ${MERCURY_REF_SCHEME} (got '${input.ref.slice(0, 40)}')`,
        errorCode: 1,
      }
    }
    return { result: true as const }
  },
  get inputSchema(): SchemaType {
    return inputSchema()
  },
  renderToolUseMessage,
  renderToolUseErrorMessage,
  renderToolResultMessage,
  // HZ7 projection: the renderer paints `result` — search indexes the same.
  extractSearchText({ result }) {
    return result ?? ''
  },
  async call(input: Input, context: ToolUseContext) {
    const startedAt = Date.now()
    const result = await resolveResource(input.ref, {
      owner: ownerFromToolUseContext(context),
      cwd: getCwd(),
      getAppState: context.getAppState as (() => unknown) | undefined,
    })
    let output: Output
    if (result.state === 'ok') {
      const r = result.resource
      const lines: string[] = [
        `${r.title} [${r.kind}${r.version ? ` · v ${r.version}` : ''}]`,
        r.summary,
      ]
      if (r.children?.length) {
        lines.push('', `children (${r.children.length}):`)
        for (const c of r.children) {
          lines.push(`  ${c.ref} — ${c.title} (${c.summary})`)
        }
      }
      if (r.text) {
        lines.push('', r.text)
      }
      if (r.page) {
        lines.push(
          '',
          `[page: cursor ${r.page.cursor}${r.page.total !== undefined ? ` of ${r.page.total} lines` : ''}${r.page.hasMore ? ` — more available: ?cursor=${r.page.cursor + (r.text?.split('\n').length ?? 0)}` : ' — end'}]`,
        )
      }
      output = {
        ref: r.ref,
        state: 'ok',
        result: lines.join('\n'),
        kind: r.kind,
        title: r.title,
        ...(r.version ? { version: r.version } : {}),
      }
    } else {
      output = {
        ref: input.ref,
        state: result.state,
        result: `${result.state.toUpperCase()}: ${result.note}`,
      }
    }
    return {
      data: output,
      effect: {
        outcome: result.state === 'ok' ? ('succeeded' as const) : ('no-change' as const),
        operation: 'inspect.read',
        changedPaths: [],
        evidence:
          result.state === 'ok'
            ? `resolved ${input.ref}`
            : `${result.state}: ${input.ref}`,
        startedAt,
        completedAt: Date.now(),
      },
    }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseId: string) {
    return {
      tool_use_id: toolUseId,
      type: 'tool_result' as const,
      content: output.result,
    }
  },
})
