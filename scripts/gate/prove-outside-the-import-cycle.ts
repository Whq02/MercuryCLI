#!/usr/bin/env bun
import { join } from 'node:path'
import { largestCycle, readImports, staticPairs, type Edge } from '../lib/importCycle.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-outside-the-import-cycle.ts'

const OUTSIDE = [
  'src/components/FileEditToolUseRejectedMessage.tsx',
  'src/components/InlineChangeView.tsx',
  'src/components/NotebookEditToolUseRejectedMessage.tsx',
  'src/daemon/saturn.ts',
  'src/mneme/handoffAsk.ts',
  'src/query.ts',
  'src/query/stopHooks.ts',
  'src/rows/child.ts',
  'src/run-core/turn-machine.ts',
  'src/run-core/turn/',
  'src/services/AgentSummary/agentSummary.ts',
  'src/services/advisor/askAdvisor.ts',
  'src/services/agents/operatorStop.ts',
  'src/services/compact/overflowRecovery.ts',
  'src/services/crew/agentLaunchPlan.ts',
  'src/services/eval/evalBridge.ts',
  'src/services/ide/godotSession.ts',
  'src/services/ide/launchProfiles.ts',
  'src/services/ide/launchTasks.ts',
  'src/services/providers/primaryBackend.ts',
  'src/services/resources/adapters/git.ts',
  'src/services/resources/adapters/ide.ts',
  'src/services/resources/adapters/journey.ts',
  'src/services/resources/adapters/mission.ts',
  'src/services/resources/adapters/project.ts',
  'src/services/resources/adapters/repo.ts',
  'src/services/resources/adapters/service.ts',
  'src/services/resources/adapters/structure.ts',
  'src/services/resources/adapters/test.ts',
  'src/services/resources/adapters/transcript.ts',
  'src/services/resources/adapters/workbench.ts',
  'src/services/run/requestContextPlan.ts',
  'src/services/search/nativeSearch.ts',
  'src/services/search/searchDoor.ts',
  'src/services/tools/earlyStarts.ts',
  'src/services/tools/loopGuard.ts',
  'src/services/tools/toolExecution.ts',
  'src/services/tools/toolHooks.ts',
  'src/services/tools/toolOrchestration.ts',
  'src/substrate/featureReached.ts',
  'src/tasks.ts',
  'src/tasks/LocalAgentTask/launchReceipts.ts',
  'src/tasks/LocalAgentTask/pauseCarry.ts',
  'src/tasks/LocalMainSessionTask.ts',
  'src/tasks/stopTask.ts',
  'src/tools.ts',
  'src/tools/AgentTool/AgentTool.tsx',
  'src/tools/AgentTool/UI.tsx',
  'src/tools/AgentTool/agentToolUtils.ts',
  'src/tools/AgentTool/foregroundExecution.tsx',
  'src/tools/AgentTool/resumeAgent.ts',
  'src/tools/AsepriteTool/AsepriteTool.ts',
  'src/tools/AsepriteTool/UI.tsx',
  'src/tools/AskAdvisorTool/AskAdvisorTool.ts',
  'src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx',
  'src/tools/AstEditTool/AstEditTool.ts',
  'src/tools/AstEditTool/UI.tsx',
  'src/tools/AstSearchTool/AstSearchTool.ts',
  'src/tools/AstSearchTool/UI.tsx',
  'src/tools/BlenderTool/BlenderTool.ts',
  'src/tools/BlenderTool/UI.tsx',
  'src/tools/BlenderTool/show.ts',
  'src/tools/BrowserTool/BrowserTool.ts',
  'src/tools/BrowserTool/UI.tsx',
  'src/tools/ChangeSetTool/ChangeSetTool.ts',
  'src/tools/ChangeSetTool/UI.tsx',
  'src/tools/ComputerTool/ComputerTool.ts',
  'src/tools/ComputerTool/UI.tsx',
  'src/tools/ContextLeftTool/ContextLeftTool.ts',
  'src/tools/DebugTool/DebugTool.ts',
  'src/tools/DebugTool/UI.tsx',
  'src/tools/EnterWorktreeTool/EnterWorktreeTool.ts',
  'src/tools/EvalTool/EvalTool.ts',
  'src/tools/EvalTool/UI.tsx',
  'src/tools/ExitWorktreeTool/ExitWorktreeTool.ts',
  'src/tools/FileEditTool/FileEditTool.ts',
  'src/tools/FileWriteTool/FileWriteTool.ts',
  'src/tools/FileWriteTool/UI.tsx',
  'src/tools/GitTool/GitTool.ts',
  'src/tools/GitTool/UI.tsx',
  'src/tools/GlobTool/GlobTool.ts',
  'src/tools/GlobTool/UI.tsx',
  'src/tools/GodotTool/GodotTool.ts',
  'src/tools/GodotTool/UI.tsx',
  'src/tools/GrepTool/GrepTool.ts',
  'src/tools/GrepTool/UI.tsx',
  'src/tools/InspectTool/InspectTool.ts',
  'src/tools/InspectTool/UI.tsx',
  'src/tools/JourneyTool/JourneyTool.ts',
  'src/tools/JourneyTool/UI.tsx',
  'src/tools/LSPTool/LSPTool.ts',
  'src/tools/LSPTool/UI.tsx',
  'src/tools/LSPTool/mercuryOps.ts',
  'src/tools/LaunchTool/LaunchTool.ts',
  'src/tools/LaunchTool/UI.tsx',
  'src/tools/MonitorTool/MonitorTool.ts',
  'src/tools/MonitorTool/watchReceipts.ts',
  'src/tools/NotebookEditTool/NotebookEditTool.ts',
  'src/tools/NotebookEditTool/UI.tsx',
  'src/tools/PowerShellTool/PowerShellTool.tsx',
  'src/tools/PowerShellTool/UI.tsx',
  'src/tools/ResumeAgentTool/ResumeAgentTool.ts',
  'src/tools/ScheduleCronTool/CronCreateTool.ts',
  'src/tools/ScheduleCronTool/CronDeleteTool.ts',
  'src/tools/ScheduleCronTool/createAnswer.ts',
  'src/tools/ScheduleWakeupTool/ScheduleWakeupTool.ts',
  'src/tools/SendMessageTool/SendMessageTool.ts',
  'src/tools/SendMessageTool/crewAddress.ts',
  'src/tools/ServiceTool/ServiceTool.ts',
  'src/tools/ServiceTool/UI.tsx',
  'src/tools/StructureTool/StructureTool.ts',
  'src/tools/StructureTool/UI.tsx',
  'src/tools/TaskStopTool/TaskStopTool.ts',
  'src/tools/TestTool/TestTool.ts',
  'src/tools/TestTool/UI.tsx',
  'src/tools/TransactionTool/TransactionTool.ts',
  'src/tools/TransactionTool/UI.tsx',
  'src/tools/UnityTool/UI.tsx',
  'src/tools/UnityTool/UnityTool.ts',
  'src/tools/VideoTool/VideoTool.tsx',
  'src/tools/WebSearchTool/ProviderSearchTool.ts',
  'src/tools/WebSearchTool/WebSearchTool.ts',
  'src/utils/task/sdkAgentFrames.ts',
]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail: string[] = []): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (!cond) for (const line of detail) console.log(`         ${line}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)

console.log('============================================================')
console.log(' Outside the import cycle — a list that only grows')
console.log('============================================================')

const { files, known, edges } = readImports(ROOT)
const pairs = staticPairs(edges)
const cycle = largestCycle(files, pairs)
const isFolder = (entry: string): boolean => entry.endsWith('/')
const listed = files.filter(file => OUTSIDE.some(entry => (isFolder(entry) ? file.startsWith(entry) : file === entry)))

section('(1) the list — OUTSIDE: each entry a file under src/ or, closed by a slash, a folder standing for every file under it')
{
  const misplaced = OUTSIDE.filter((entry, i) => i > 0 && OUTSIDE[i - 1]! >= entry)
  const covered = OUTSIDE.filter(entry => OUTSIDE.some(folder => isFolder(folder) && folder !== entry && entry.startsWith(folder)))
  check(`the list is in path order with no entry twice: ${OUTSIDE.length} entries`, misplaced.length === 0 && covered.length === 0, [
    ...misplaced.map(entry => `${entry} is out of place: put the entries of OUTSIDE in ${SELF} in path order, each once`),
    ...covered.map(entry => `${entry} is under a folder the list already names: delete its row from OUTSIDE in ${SELF}`),
  ])
  const dead = OUTSIDE.filter(entry => (isFolder(entry) ? !files.some(file => file.startsWith(entry)) : !known.has(entry)))
  check(
    `every entry still names something: ${OUTSIDE.filter(entry => !isFolder(entry)).length} files and ${OUTSIDE.filter(isFolder).length === 1 ? '1 folder' : `${OUTSIDE.filter(isFolder).length} folders`}, ${listed.length} source files in all`,
    dead.length === 0,
    dead.map(entry => `${entry} names no source file under src/: OUTSIDE in ${SELF} only grows — an entry is renamed when its file is renamed, never dropped`),
  )
}

section(`(2) the cycle — ${cycle.size} of the ${files.length} files under src/ reach one another through imports that run when a file is loaded: none may`)
{
  const inside = edges.filter(edge => edge.kind === 'static' && edge.from !== edge.to && cycle.has(edge.from) && cycle.has(edge.to))
  check(`no file under src/ is loaded by a file it loads: ${cycle.size} in the largest such group`, cycle.size === 0, [
    ...inside.slice(0, 12).map(edge => `${edge.from}:${edge.line} → ${edge.to}`),
    ...(inside.length > 12 ? [`and ${inside.length - 12} more imports inside the group`] : []),
    'cut the import that closed the group: move what it takes down into a file both sides import and export it again where it stood, or hand the value in; the count stays 0',
  ])
  const onList = new Set(listed)
  const into = new Map<string, Edge[]>()
  for (const edge of edges) {
    if (edge.kind !== 'static' || !cycle.has(edge.from) || onList.has(edge.from) || !onList.has(edge.to) || !cycle.has(edge.to)) continue
    into.set(edge.to, [...(into.get(edge.to) ?? []), edge])
  }
  const down = new Map<string, string[]>()
  for (const [from, to] of pairs) if (onList.has(from) && onList.has(to)) down.set(from, [...(down.get(from) ?? []), to])
  const reached = (start: string): Map<string, string> => {
    const from = new Map<string, string>([[start, start]])
    const queue = [start]
    while (queue.length > 0) {
      const at = queue.shift()!
      for (const next of down.get(at) ?? []) {
        if (from.has(next)) continue
        from.set(next, at)
        queue.push(next)
      }
    }
    return from
  }
  const targets = [...into.keys()].sort()
  const trees = new Map(targets.map(target => [target, reached(target)] as const))
  const chain = (target: string, file: string): string[] => {
    const out = [file]
    while (out[0] !== target) out.unshift(trees.get(target)!.get(out[0]!)!)
    return out
  }
  const advice = `hand the value in instead of importing the file: the importer takes the function from the one that calls it, the way ToolUseContext.startTurn carries the door that starts a turn; OUTSIDE in ${SELF} only grows: a deleted row is not the fix`
  const why = (file: string): string[] => {
    const via = targets.filter(target => trees.get(target)!.has(file))
    if (via.length === 0) {
      const own = edges.filter(edge => edge.kind === 'static' && edge.from === file && edge.to !== file && onList.has(edge.to) && cycle.has(edge.to))
      return ['no file off the list brings it in: the listed files import one another', ...own.map(edge => `${edge.from}:${edge.line} → ${edge.to}`), advice]
    }
    const lines: string[] = []
    for (const target of via) {
      if (target === file) lines.push(...into.get(target)!.map(edge => `${edge.from}:${edge.line} → ${edge.to}`))
      else lines.push(`through ${target}, whose own line names the imports that bring it in: ${chain(target, file).join(' → ')}`)
    }
    return via.includes(file) ? [...lines, advice] : lines
  }
  for (const file of listed) check(`${file} stands outside the cycle`, !cycle.has(file), cycle.has(file) ? why(file) : [])
}

console.log('')
console.log(failures === 0 ? `prove-outside-the-import-cycle: ALL HOLD — ${checks} checks` : `prove-outside-the-import-cycle: ${failures} FAILURE(S) of ${checks}`)
process.exit(failures === 0 ? 0 : 1)
