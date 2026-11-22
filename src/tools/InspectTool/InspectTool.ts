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
import { ownerFromToolUseContext } from '../../utils/run/resolveOwner.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { referenceReadDecision } from '../../services/resources/referencePaths.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseMessage,
} from './UI.js'
import { unbuilt, type Unbuilt } from '../../pi/holes.js'

export const INSPECT_TOOL_NAME = 'Inspect' as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    ref: z
      .string()
      .describe(
        'mercury://<kind>[/<id>][?lines=A-B&q=text&cursor=N&limit=N&child=name]. Selectors choose a line range, substring filter, page or named child.',
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

async function kindsLine(): Promise<string> {
  return (await resourceAdapterKinds()).map(k => k.kind).join(', ')
}

export const InspectTool: Unbuilt = unbuilt('src/tools/InspectTool/InspectTool.ts:48')
