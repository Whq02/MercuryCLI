import { getEmptyToolPermissionContext } from '../../src/tools/kit/tool.ts'
import { decideToolPermission } from '../../src/permissions/rules/decision/engine.ts'
import { ReadTool } from '../../src/tools/read/ReadTool.ts'
import { BashTool } from '../../src/tools/shell/BashTool.tsx'

type Decide = (tool: unknown, input: unknown, context: unknown) => Promise<{ decision: { behavior: string } }>
const decide = decideToolPermission as unknown as Decide

function contextOf(mode: string, allow: string[]): unknown {
  const state = { toolPermissionContext: { ...getEmptyToolPermissionContext(), mode, alwaysAllowRules: { userSettings: allow }, alwaysAskRules: { userSettings: [] } }, tasks: {}, sessionHooks: new Map() }
  return { getAppState: () => state, setAppState: () => {}, abortController: new AbortController(), readFileState: new Map(), messages: [], options: { tools: [] } }
}

export async function floorOf(target: string): Promise<Record<string, { read: string; cat: string }>> {
  const answers: Record<string, { read: string; cat: string }> = {}
  for (const mode of ['default', 'sovereign']) {
    const read = (await decide(ReadTool, { file_path: target }, contextOf(mode, ['Read']))).decision
    const cat = (await decide(BashTool, { command: "cat '" + target + "'" }, contextOf(mode, ['Bash']))).decision
    answers[mode] = { read: read.behavior, cat: cat.behavior }
  }
  return answers
}
