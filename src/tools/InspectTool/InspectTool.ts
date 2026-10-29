
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
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
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
  shouldDefer: true,
  name: INSPECT_TOOL_NAME,
  searchHint:
    'read Mercury work-graph objects by mercury:// ref (runs, receipts, tasks, crews, workflows, artifacts, agents, health, seat identity, model, effort, posture, engine history)',
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

Selectors (append as ?key=value&…): lines=A-B (text range) · q=substring (filter lines) · cursor=N + limit=N (pagination) · child=name (a named sub-resource, e.g. a workflow crewmate).

mercury://<kind> with no id lists that kind's objects. Answers are honest: absent (never existed) / expired (retention dropped it) / unavailable (subsystem off) are distinct — an empty listing means genuinely empty. Full payloads stay behind refs: results are bounded pages; follow the cursor rather than raising the limit.

Use Inspect when a tool result or crewmate hands you a mercury:// ref, or to check run/receipt/workflow/service state without replaying transcripts. For plain file content, Read remains the primary tool (Inspect's file kind exists for uniformity and directory listings).

mercury://seat is this seat's own reference: the model this turn runs on (the id the dispatch stamps), the effort, the posture, and the engines this session has run on with the time of each switch. Asked which model runs you, read it and answer from it; a model named in an earlier reply is not evidence of the one running now. mercury://models is what the operator sees in /model and /logins: the providers signed in and the models each reaches, read live; mercury://models/known is what this build knows from its pin tables, not what is reachable now. Before naming a model for a launch, read mercury://models and name one of its rows; never switch to another provider on your own.`
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
  async checkPermissions(input: Input, context: ToolUseContext) {
    const trimmed = input.ref.trim()
    if (/^mercury:\/\/file\/.+/i.test(trimmed)) {
      const raw = trimmed.replace(/^mercury:\/\/file\//i, '').split('?')[0]!
      let filePath = raw
      try { filePath = decodeURIComponent(raw) } catch {}
      return checkReadPermissionForTool(
        { name: INSPECT_TOOL_NAME, getPath: () => filePath },
        input,
        context.getAppState().toolPermissionContext,
      )
    }
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
  extractSearchText({ result }) {
    return result ?? ''
  },
  async call(input: Input, context: ToolUseContext) {
    const startedAt = Date.now()
    const result = await resolveResource(input.ref, {
      owner: ownerFromToolUseContext(context),
      cwd: getCwd(),
      getAppState: context.getAppState as (() => unknown) | undefined,
      engineModel: context.options?.engineModel,
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
