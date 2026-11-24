#!/usr/bin/env bun
import { join } from 'node:path'
import { largestCycle, readImports, staticPairs, type Edge } from '../lib/importCycle.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-outside-the-import-cycle.ts'

const OUTSIDE = [
  'src/crew/agent-summary/crewmateSummary.ts',
  'src/crew/agents/operatorStop.ts',
  'src/crew/crewmates/agentLaunchPlan.ts',
  'src/daemon/saturn/saturn.ts',
  'src/engine/compaction/overflowRecovery.ts',
  'src/engine/loop/turn-machine.ts',
  'src/engine/loop/turn/',
  'src/engine/rows/child.ts',
  'src/engine/run/requestContextPlan.ts',
  'src/engine/task-framework/sdkAgentFrames.ts',
  'src/engine/tasks/local-agent/launchReceipts.ts',
  'src/engine/tasks/local-agent/pauseCarry.ts',
  'src/engine/tasks/mainSessionTask.ts',
  'src/engine/tasks/stopTask.ts',
  'src/engine/tasks/tasks.ts',
  'src/engine/tool-dispatch/earlyStarts.ts',
  'src/engine/tool-dispatch/loopGuard.ts',
  'src/engine/tool-dispatch/toolExecution.ts',
  'src/engine/tool-dispatch/toolHooks.ts',
  'src/engine/tool-dispatch/toolOrchestration.ts',
  'src/engine/turn-entry/stopHooks.ts',
  'src/engine/turnDoor.ts',
  'src/integrations/ide/godotSession.ts',
  'src/integrations/ide/launchProfiles.ts',
  'src/integrations/ide/launchTasks.ts',
  'src/integrations/resources/adapters/git.ts',
  'src/integrations/resources/adapters/ide.ts',
  'src/integrations/resources/adapters/journey.ts',
  'src/integrations/resources/adapters/mission.ts',
  'src/integrations/resources/adapters/project.ts',
  'src/integrations/resources/adapters/repo.ts',
  'src/integrations/resources/adapters/service.ts',
  'src/integrations/resources/adapters/structure.ts',
  'src/integrations/resources/adapters/test.ts',
  'src/integrations/resources/adapters/transcript.ts',
  'src/integrations/resources/adapters/workbench.ts',
  'src/models/advisor/askAdvisor.ts',
  'src/models/roads/primaryBackend.ts',
  'src/platform/substrate/featureReached.ts',
  'src/sessions/mneme/handoffAsk.ts',
  'src/tools/aseprite/AsepriteTool.ts',
  'src/tools/aseprite/rows.tsx',
  'src/tools/ask-advisor/AskAdvisorTool.ts',
  'src/tools/ask-question/AskUserQuestionTool.tsx',
  'src/tools/ast-edit/AstEditTool.ts',
  'src/tools/ast-edit/rows.tsx',
  'src/tools/ast-search/AstSearchTool.ts',
  'src/tools/ast-search/rows.tsx',
  'src/tools/blender/BlenderTool.ts',
  'src/tools/blender/show.ts',
  'src/tools/browser/BrowserTool.ts',
  'src/tools/browser/rows.tsx',
  'src/tools/change-set/ChangeSetTool.ts',
  'src/tools/change-set/rows.tsx',
  'src/tools/computer/ComputerTool.ts',
  'src/tools/computer/rows.tsx',
  'src/tools/context-left/ContextLeftTool.ts',
  'src/tools/crewmate/CrewmateTool.tsx',
  'src/tools/crewmate/crewmateLifecycle.ts',
  'src/tools/crewmate/foregroundExecution.tsx',
  'src/tools/crewmate/resumeCrewmate.ts',
  'src/tools/crewmate/rows.tsx',
  'src/tools/cron/CronCreateTool.ts',
  'src/tools/cron/CronDeleteTool.ts',
  'src/tools/cron/createAnswer.ts',
  'src/tools/debug/DebugTool.ts',
  'src/tools/debug/rows.tsx',
  'src/tools/edit/EditTool.ts',
  'src/tools/engines/eval-kernels/evalBridge.ts',
  'src/tools/engines/web-search/nativeSearch.ts',
  'src/tools/engines/web-search/searchDoor.ts',
  'src/tools/enter-worktree/EnterWorktreeTool.ts',
  'src/tools/eval/EvalTool.ts',
  'src/tools/eval/rows.tsx',
  'src/tools/exit-worktree/ExitWorktreeTool.ts',
  'src/tools/git/GitTool.ts',
  'src/tools/git/rows.tsx',
  'src/tools/glob/GlobTool.ts',
  'src/tools/glob/rows.tsx',
  'src/tools/godot/GodotTool.ts',
  'src/tools/grep/GrepTool.ts',
  'src/tools/grep/rows.tsx',
  'src/tools/inspect/InspectTool.ts',
  'src/tools/inspect/rows.tsx',
  'src/tools/journey/JourneyTool.ts',
  'src/tools/journey/rows.tsx',
  'src/tools/kit/InlineChangeView.tsx',
  'src/tools/kit/bridgeToolRows.tsx',
  'src/tools/kit/toolList.ts',
  'src/tools/launch/LaunchTool.ts',
  'src/tools/launch/rows.tsx',
  'src/tools/lsp/lspTools.ts',
  'src/tools/lsp/mercuryOps.ts',
  'src/tools/lsp/rows.tsx',
  'src/tools/monitor/MonitorTool.ts',
  'src/tools/monitor/watchReceipts.ts',
  'src/tools/notebook-edit/NotebookEditRejectedMessage.tsx',
  'src/tools/notebook-edit/NotebookEditTool.ts',
  'src/tools/notebook-edit/rows.tsx',
  'src/tools/powershell/PowerShellTool.tsx',
  'src/tools/powershell/rows.tsx',
  'src/tools/resume-crewmate/ResumeAgentTool.ts',
  'src/tools/schedule-wakeup/ScheduleWakeupTool.ts',
  'src/tools/send-message/SendMessageTool.ts',
  'src/tools/send-message/crewAddress.ts',
  'src/tools/service/ServiceTool.ts',
  'src/tools/service/rows.tsx',
  'src/tools/structure/StructureTool.ts',
  'src/tools/structure/rows.tsx',
  'src/tools/task-stop/TaskStopTool.ts',
  'src/tools/test/TestTool.ts',
  'src/tools/test/rows.tsx',
  'src/tools/transaction/TransactionTool.ts',
  'src/tools/transaction/rows.tsx',
  'src/tools/unity/UnityTool.ts',
  'src/tools/video/VideoTool.tsx',
  'src/tools/web-search/ProviderSearchTool.ts',
  'src/tools/web-search/WebSearchTool.ts',
  'src/tools/write/FileEditToolUseRejectedMessage.tsx',
  'src/tools/write/WriteTool.ts',
  'src/tools/write/rows.tsx',
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
