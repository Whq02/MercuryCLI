#!/usr/bin/env bun
import { join } from 'node:path'
import ts from 'typescript'
import { largestCycle, readImports, staticPairs, type Edge, type Kind, type Unread } from '../lib/importCycle.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-shell-door.ts'
const PARSE_DOOR = 'src/utils/permissions/decision/commandAnalysis.ts'
const PROBE = 'src/tools/BashTool/bashPermissions.ts'

const SHELL_DIRS = [
  'src/utils/shell/',
  'src/utils/bash/',
  'src/tools/BashTool/',
  'src/tools/PowerShellTool/',
  'src/utils/powershell/',
  'src/tasks/LocalShellTask/',
]
const SHELL_FILES = ['src/utils/Shell.ts', 'src/utils/ShellCommand.ts']

const IMPORTERS = [
  'src/cli/headless/runnerAsks.ts',
  'src/cli/headless/sendNow.ts',
  'src/cli/run.ts',
  'src/components/BashModeProgress.tsx',
  'src/components/MercuryTurnRollup.tsx',
  'src/components/Settings/Config.tsx',
  'src/components/WorktreeExitDialog.tsx',
  'src/components/messages/AssistantToolUseMessage.tsx',
  'src/components/messages/CollapsedReadSearchContent.tsx',
  'src/components/messages/UserBashOutputMessage.tsx',
  'src/components/messages/UserToolResultMessage/UserToolSuccessMessage.tsx',
  'src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx',
  'src/components/permissions/BashPermissionRequest/bashToolUseOptions.tsx',
  'src/components/permissions/PermissionRequest.tsx',
  'src/components/permissions/PowerShellPermissionRequest/PowerShellPermissionRequest.tsx',
  'src/components/permissions/PowerShellPermissionRequest/powershellToolUseOptions.tsx',
  'src/components/permissions/SedEditPermissionRequest/SedEditPermissionRequest.tsx',
  'src/components/permissions/rules/PermissionRuleDescription.tsx',
  'src/components/permissions/rules/PermissionRuleInput.tsx',
  'src/components/tasks/BackgroundTask.tsx',
  'src/components/tasks/BackgroundTasksDialog.tsx',
  'src/components/tasks/ShellDetailDialog.tsx',
  'src/components/tasks/ShellProgress.tsx',
  'src/constants/prompts.ts',
  'src/daemon/runnerScript.ts',
  'src/entrypoints/cli.tsx',
  'src/entrypoints/init.ts',
  'src/entrypoints/mcp.ts',
  'src/entrypoints/shellParentGuard.ts',
  'src/extensions/manifest.ts',
  'src/guards/commitGate.ts',
  'src/guards/generatedAssets.ts',
  'src/hooks/useCancelRequest.ts',
  'src/hooks/useTypeahead.tsx',
  'src/rows/turn.ts',
  'src/schemas/hooks.ts',
  'src/screens/Chat.tsx',
  'src/services/acp/ideToolBridge.ts',
  'src/services/dap/dapTerminal.ts',
  'src/services/engine-connector/shellRunning.ts',
  'src/services/mcp/stdioCommandSafety.ts',
  'src/services/switchboard/sessionReceipts.ts',
  'src/services/tools/toolExecution.ts',
  'src/setup.ts',
  'src/tasks.ts',
  'src/tasks/stopTask.ts',
  'src/tasks/types.ts',
  'src/tools.ts',
  'src/tools/AgentTool/AgentTool.tsx',
  'src/tools/AgentTool/foregroundExecution.tsx',
  'src/tools/AgentTool/reviewerPolicy.ts',
  'src/tools/AgentTool/runAgent.ts',
  'src/tools/AgentTool/scoutPolicy.ts',
  'src/tools/ComputerTool/ComputerTool.ts',
  'src/tools/DebugTool/DebugTool.ts',
  'src/tools/EnterWorktreeTool/EnterWorktreeTool.ts',
  'src/tools/ExitWorktreeTool/ExitWorktreeTool.ts',
  'src/tools/JourneyTool/JourneyTool.ts',
  'src/tools/MonitorTool/MonitorTool.ts',
  'src/tools/MonitorTool/watchReceipts.ts',
  'src/tools/ServiceTool/ServiceTool.ts',
  'src/tools/TaskStopTool/TaskStopTool.ts',
  'src/utils/api.ts',
  'src/utils/attachments/diagnostics.ts',
  'src/utils/capability/census.ts',
  'src/utils/cockpit/helmLanesModel.ts',
  'src/utils/cockpit/runtimePosture.ts',
  'src/utils/collapseBackgroundBashNotifications.ts',
  'src/utils/collapseReadSearch.ts',
  'src/utils/contextSuggestions.ts',
  'src/utils/crossProjectResume.ts',
  'src/utils/gitRules.ts',
  'src/utils/healthReport.ts',
  'src/utils/hooks/commandRunner.ts',
  'src/utils/messages/attachmentText.ts',
  'src/utils/notebook.ts',
  'src/utils/permissions/commandContent.ts',
  'src/utils/permissions/decision/commandAnalysis.ts',
  'src/utils/permissions/decision/rules.ts',
  'src/utils/permissions/flowLaw.ts',
  'src/utils/permissions/permissionSetup.ts',
  'src/utils/permissions/ruleReason.ts',
  'src/utils/permissions/runtimeProtection.ts',
  'src/utils/permissions/shellProtectedPaths.ts',
  'src/utils/permissions/shellRuleMatching.ts',
  'src/utils/processUserInput/processBashCommand.tsx',
  'src/utils/promptShellExecution.ts',
  'src/utils/readiness.ts',
  'src/utils/spawnPlan.ts',
  'src/utils/task/TaskOutput.ts',
  'src/utils/task/workRoster.ts',
  'src/utils/toolErrors.ts',
  'src/utils/wards/wardsShellRead.ts',
]

const IN_CYCLE = [
  'src/tasks/LocalShellTask/LocalShellTask.tsx',
  'src/tasks/LocalShellTask/killShellTasks.ts',
  'src/tools/BashTool/BashTool.tsx',
  'src/tools/BashTool/BashToolResultMessage.tsx',
  'src/tools/BashTool/UI.tsx',
  'src/tools/BashTool/utils.ts',
]

const UNREAD: Array<[string, number]> = [
  ['src/extensions/installConsent.ts', 2],
  ['src/mneme/embedPack.ts', 1],
  ['src/services/crewBoard/seam.ts', 1],
  ['src/services/crewBoard/store.ts', 1],
  ['src/services/desktop/pack.ts', 1],
  ['src/services/lsp/tsSidecar/sidecar.ts', 1],
  ['src/services/media/host.ts', 1],
  ['src/services/media/settings.ts', 2],
  ['src/services/structure/grammarFacility.ts', 1],
  ['src/services/structure/tsFacility.ts', 1],
  ['src/services/voice/voicePack.ts', 1],
  ['src/services/voice/whisperPack.ts', 1],
  ['src/services/vulcan/engine/leases.ts', 1],
  ['src/tools/FileReadTool/jsonQueryWorker.mjs', 1],
  ['src/tools/FileReadTool/readRichFormats.ts', 1],
  ['src/utils/bash/registry.ts', 1],
  ['src/utils/pdfTextWorker.mjs', 1],
]

let failures = 0
function check(label: string, cond: boolean, detail: string[] = []): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (!cond) for (const line of detail) console.log(`         ${line}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)

const inside = (file: string): boolean => SHELL_DIRS.some(dir => file.startsWith(dir)) || SHELL_FILES.includes(file)

console.log('============================================================')
console.log(' The shell door — two counts that may only fall')
console.log('============================================================')

const { files, known, tsconfig, aliases, edges, unread, passedOn } = readImports(ROOT)
const shellFiles = files.filter(inside)
const misplaced = [...SHELL_DIRS.filter(dir => !files.some(file => file.startsWith(dir))), ...SHELL_FILES.filter(file => !known.has(file))]
check(
  `the shell path is where this proof names it: ${SHELL_DIRS.length} folders and ${SHELL_FILES.length} files, ${shellFiles.length} source files in all; ${files.length - shellFiles.length} files under src/ are outside it`,
  misplaced.length === 0,
  misplaced.map(path => `${path} holds no source file: name where it went in SHELL_DIRS or SHELL_FILES of ${SELF}`),
)
const inOrder = (rows: string[]): boolean => rows.every((row, i) => i === 0 || rows[i - 1]! < row)
const lists: Array<[string, string[]]> = [['IMPORTERS', IMPORTERS], ['IN_CYCLE', IN_CYCLE], ['UNREAD', UNREAD.map(row => row[0])]]
check(
  'the three lists are in path order with no row twice',
  lists.every(([, rows]) => inOrder(rows)),
  lists.filter(([, rows]) => !inOrder(rows)).map(([name]) => `put the rows of ${name} in ${SELF} in path order, each once`),
)
check(`tsconfig.json is read for the aliases its paths map into src/: ${aliases.length}`, tsconfig.error === undefined, [
  `tsconfig.json at the root of the tree cannot be read: ${tsconfig.error === undefined ? '' : ts.flattenDiagnosticMessageText(tsconfig.error.messageText, ' ')}`,
])

section('(1) the door — files outside the shell path that import from inside it')
{
  const crossing = edges.filter(edge => !inside(edge.from) && inside(edge.to))
  const importers = [...new Set(crossing.map(edge => edge.from))].sort()
  const doorEdges = crossing.filter(edge => edge.from === PARSE_DOOR)
  const fronted = new Set(doorEdges.map(edge => edge.to))
  const exported = new Set(
    doorEdges.flatMap(edge =>
      edge.leaves ? (edge.names.length > 0 ? edge.names : ['*']).map(name => `${edge.to}\t${name}`) : edge.names.filter(name => passedOn.has(`${PARSE_DOOR}\t${name}`)).map(name => `${edge.to}\t${name}`),
    ),
  )
  const behind = (file: string, name: string): boolean => exported.has(`${file}\t${name}`) || exported.has(`${file}\t*`)
  check(`the door that already exists for parsing is ${PARSE_DOOR}: it imports ${fronted.size} shell-path files and exports ${exported.size} of their names`, fronted.size > 0, [
    `${PARSE_DOOR} ${known.has(PARSE_DOOR) ? 'imports nothing from the shell path' : 'is gone'}: name the module that fronts the parser in PARSE_DOOR of ${SELF}`,
  ])

  const advice = (edge: Edge): string[] => {
    const at = `  line ${edge.line}`
    const it = (names: string[]): string => (names.length === 1 ? 'it' : 'them')
    if (!fronted.has(edge.to)) return [`${at} ${edge.names.length > 0 ? `imports ${edge.names.join(', ')} from` : 'takes the whole of'} ${edge.to} — no door holds that file: take the import out of this line`]
    if (edge.names.length === 0) {
      const offered = [...exported].filter(key => key.startsWith(`${edge.to}\t`)).map(key => key.slice(edge.to.length + 1))
      if (offered.includes('*')) return [`${at} takes the whole of ${edge.to} — take it from ${PARSE_DOOR}, the door that already exists for parsing: the door exports all of it`]
      if (offered.length === 0) return [`${at} takes the whole of ${edge.to} — not behind the door yet (${PARSE_DOOR} exports none of that file's names): add the names this caller needs to the door's exports, or keep this caller outside by taking the import out of this line`]
      return [`${at} takes the whole of ${edge.to} — ${PARSE_DOOR}, the door that already exists for parsing, exports ${offered.join(', ')} of that file: take those from the door; for any other name, add it to the door's exports or keep this caller outside by taking the import out of this line`]
    }
    const ready = edge.names.filter(name => behind(edge.to, name))
    const missing = edge.names.filter(name => !behind(edge.to, name))
    return [
      ...(ready.length > 0 ? [`${at} imports ${ready.join(', ')} from ${edge.to} — take ${it(ready)} from ${PARSE_DOOR}, the door that already exists for parsing: the door exports ${it(ready)}`] : []),
      ...(missing.length > 0
        ? [`${at} imports ${missing.join(', ')} from ${edge.to} — not behind the door yet (${PARSE_DOOR} does not export ${it(missing)}): add ${it(missing)} to the door's exports, or keep this caller outside by taking the import out of this line`]
        : []),
    ]
  }

  const listed = new Set(IMPORTERS)
  const unlisted = importers.filter(file => !listed.has(file))
  const nameOnly = importers.filter(file => crossing.every(edge => edge.from !== file || edge.to.endsWith('/toolName.ts')))
  const lines = (kind: Kind): number => crossing.filter(edge => edge.kind === kind).length
  check(
    `every outside file that imports from inside is on the list: ${importers.length} files, ${crossing.length} import lines (${lines('static')} static, ${lines('lazy')} lazy, ${lines('type')} type-only), ${nameOnly.length} files taking only a toolName.ts`,
    unlisted.length === 0,
    [...unlisted.flatMap(file => [`${file} is not on the list:`, ...crossing.filter(edge => edge.from === file).flatMap(advice)]), `IMPORTERS in ${SELF} only shrinks: a new row is not the fix`],
  )

  const active = new Set(importers)
  const stale = IMPORTERS.filter(file => !active.has(file))
  check(
    `every row of the list still imports from inside: ${IMPORTERS.length} rows`,
    stale.length === 0,
    stale.map(file => `${file} ${known.has(file) ? 'imports nothing from inside the shell path' : 'is gone'}: delete its row from IMPORTERS in ${SELF}`),
  )
}

section('(2) the cycle — shell-path files inside the static import cycle: the largest group of files under src/ that reach one another through imports that run when a file is loaded (import and export statements, and require() or import() calls that no function encloses)')
{
  const pairs = staticPairs(edges)
  const cycle = largestCycle(files, pairs)
  const inCycle = shellFiles.filter(file => cycle.has(file))
  const allowed = new Set(IN_CYCLE)
  const loose = inCycle.filter(file => !allowed.has(file))

  const ties = (): string[] => {
    const looseSet = new Set(loose)
    const rows = pairs
      .filter(([from, to]) => looseSet.has(from) && cycle.has(to))
      .map(([from, to]) => {
        const rest = largestCycle(files, pairs.filter(pair => pair[0] !== from || pair[1] !== to))
        const left = shellFiles.filter(file => rest.has(file))
        const line = edges.find(edge => edge.kind === 'static' && edge.from === from && edge.to === to)!.line
        return { site: `${from}:${line} imports ${to}`, left: left.length, loose: left.filter(file => !allowed.has(file)).length, outward: !inside(to) }
      })
      .sort((a, b) => a.loose - b.loose || Number(b.outward) - Number(a.outward) || (a.site < b.site ? -1 : 1))
    const first = rows[0]
    const freeing = first && first.loose === 0 ? rows.filter(row => row.loose === 0 && row.outward === first.outward) : []
    return [
      `${inCycle.length} shell-path files are inside the cycle and ${loose.length} of them are not on the list:`,
      ...loose.map(file => `  ${file}`),
      ...(freeing.length > 0
        ? ['one import that runs when its file is loaded ties them in:', ...freeing.map(row => `  ${row.site} — without it ${row.left} shell-path files stay inside, all on the list`)]
        : ['no single import frees them all; the ones that free the most:', ...rows.slice(0, 5).map(row => `  ${row.site} — without it ${row.left} stay inside, ${row.loose} not on the list`)]),
      `load it inside the function that needs it (await import(...) at the call) or take it out; IN_CYCLE in ${SELF} only shrinks`,
    ]
  }
  check(
    `every shell-path file inside the cycle is on the list: ${inCycle.length} of its ${cycle.size} files, ${IN_CYCLE.length} at most`,
    loose.length === 0,
    loose.length === 0 ? [] : ties(),
  )

  const still = new Set(inCycle)
  const gone = IN_CYCLE.filter(file => !still.has(file))
  check(
    `every row of the list is still inside the cycle: ${IN_CYCLE.length} rows`,
    gone.length === 0,
    gone.map(file => `${file} ${known.has(file) ? 'is no longer inside the cycle' : 'is gone'}: delete its row from IN_CYCLE in ${SELF}`),
  )

  const next = new Map<string, string[]>()
  for (const [from, to] of pairs) {
    const targets = next.get(from)
    if (targets) targets.push(to)
    else next.set(from, [to])
  }
  const loaded = new Set([PROBE])
  const queue = [PROBE]
  while (queue.length > 0) {
    for (const target of next.get(queue.shift()!) ?? []) {
      if (loaded.has(target)) continue
      loaded.add(target)
      queue.push(target)
    }
  }
  check(`for information, with nothing asserted on the number: importing ${PROBE} loads ${loaded.size} files under src/`, known.has(PROBE), [
    `${PROBE} is gone: name the file this line follows in PROBE of ${SELF}`,
  ])
}

section('(3) what no reader can follow — require(), import() and createRequire() calls whose specifier is not one string literal')
{
  const found = new Map<string, Unread[]>()
  for (const call of unread) found.set(call.file, [...(found.get(call.file) ?? []), call])
  const listed = new Map(UNREAD)
  const over = [...found].filter(([file, calls]) => calls.length > (listed.get(file) ?? 0))
  check(`every such call is on the list: ${unread.length} calls in ${found.size} files`, over.length === 0, [
    ...over.flatMap(([file, calls]) =>
      listed.has(file)
        ? [`${file} holds ${calls.length} such calls and the list says ${listed.get(file)}: lines ${calls.map(call => call.line).join(', ')} — write the new one's path in the call as one string literal`]
        : calls.map(call => `${file}:${call.line} ${call.text} — the door and the cycle cannot be read through this call: write the path in the call as one string literal`),
    ),
    `UNREAD in ${SELF} only shrinks: a new row or a larger number is not the fix`,
  ])

  const under = UNREAD.filter(([file, count]) => (found.get(file)?.length ?? 0) < count)
  check(
    `every row of the list still holds as many: ${UNREAD.length} rows`,
    under.length === 0,
    under.map(([file, count]) => {
      const now = found.get(file)?.length ?? 0
      if (now === 0) return `${file} ${known.has(file) ? 'holds no such call' : 'is gone'}: delete its row from UNREAD in ${SELF}`
      return `${file} holds ${now} such call(s) and the list says ${count}: write ${now} in its row of UNREAD in ${SELF}`
    }),
  )
}

console.log('')
console.log(failures === 0 ? 'prove-shell-door: BOTH COUNTS HOLD' : `prove-shell-door: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
