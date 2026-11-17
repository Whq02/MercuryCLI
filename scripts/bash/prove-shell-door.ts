#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')
const SELF = 'scripts/bash/prove-shell-door.ts'
const PARSE_DOOR = 'src/utils/permissions/decision/commandAnalysis.ts'

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
  'src/tools/PowerShellTool/PowerShellTool.tsx',
  'src/tools/PowerShellTool/UI.tsx',
]

type Kind = 'static' | 'lazy' | 'type'
type Edge = { from: string; to: string; kind: Kind; line: number }

let failures = 0
function check(label: string, cond: boolean, detail: string[] = []): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
  if (!cond) for (const line of detail) console.log(`         ${line}`)
}
const section = (title: string): void => console.log('\n' + '─'.repeat(76) + '\n' + title)

const files: string[] = []
const walk = (dir: string): void => {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) walk(`${dir}/${entry.name}`)
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(`${dir}/${entry.name}`)
  }
}
walk('src')
files.sort()
const known = new Set(files)
const inside = (file: string): boolean => SHELL_DIRS.some(dir => file.startsWith(dir)) || SHELL_FILES.includes(file)

function resolveSpec(from: string, spec: string): string | null {
  const base = spec.startsWith('.') ? posix.join(posix.dirname(from), spec) : spec.startsWith('src/') ? spec : null
  if (base === null) return null
  const tries = [base, base.replace(/\.jsx?$/, '.ts'), base.replace(/\.jsx?$/, '.tsx'), `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  return tries.find(candidate => known.has(candidate)) ?? null
}

const typeOnlyClause = (clause: ts.ImportClause): boolean =>
  clause.isTypeOnly === true || (clause as { phaseModifier?: ts.SyntaxKind }).phaseModifier === ts.SyntaxKind.TypeKeyword

function importKind(node: ts.ImportDeclaration): Kind {
  const clause = node.importClause
  if (!clause) return 'static'
  if (typeOnlyClause(clause)) return 'type'
  const bindings = clause.namedBindings
  if (clause.name || !bindings || ts.isNamespaceImport(bindings)) return 'static'
  return bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly) ? 'type' : 'static'
}

function exportKind(node: ts.ExportDeclaration): Kind {
  if (node.isTypeOnly) return 'type'
  const clause = node.exportClause
  return clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly) ? 'type' : 'static'
}

function importsOf(file: string): Edge[] {
  const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.ESNext, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: Edge[] = []
  const add = (spec: string, kind: Kind, node: ts.Node): void => {
    const to = resolveSpec(file, spec)
    if (to !== null) out.push({ from: file, to, kind, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text, importKind(node), node)
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text, exportKind(node), node)
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      const first = node.arguments[0]
      if (first && ts.isStringLiteralLike(first)) add(first.text, 'lazy', node)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text, 'type', node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

function largestCycle(pairs: Array<[string, string]>): Set<string> {
  const next = new Map<string, string[]>(files.map(file => [file, []]))
  for (const [from, to] of pairs) next.get(from)!.push(to)
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let counter = 0
  let best: string[] = []
  for (const root of files) {
    if (index.has(root)) continue
    const work: Array<[string, number]> = [[root, 0]]
    index.set(root, counter)
    low.set(root, counter)
    counter++
    stack.push(root)
    onStack.add(root)
    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const node = frame[0]
      const targets = next.get(node)!
      if (frame[1] < targets.length) {
        const target = targets[frame[1]++]!
        if (!index.has(target)) {
          index.set(target, counter)
          low.set(target, counter)
          counter++
          stack.push(target)
          onStack.add(target)
          work.push([target, 0])
        } else if (onStack.has(target)) low.set(node, Math.min(low.get(node)!, index.get(target)!))
      } else {
        if (low.get(node) === index.get(node)) {
          const component: string[] = []
          let member: string
          do {
            member = stack.pop()!
            onStack.delete(member)
            component.push(member)
          } while (member !== node)
          if (component.length > best.length) best = component
        }
        work.pop()
        if (work.length > 0) {
          const parent = work[work.length - 1]![0]
          low.set(parent, Math.min(low.get(parent)!, low.get(node)!))
        }
      }
    }
  }
  return new Set(best.length > 1 ? best : [])
}

console.log('============================================================')
console.log(' The shell door — two counts that may only fall')
console.log('============================================================')

const edges = files.flatMap(importsOf)
const shellFiles = files.filter(inside)
const misplaced = [...SHELL_DIRS.filter(dir => !files.some(file => file.startsWith(dir))), ...SHELL_FILES.filter(file => !known.has(file))]
check(
  `the shell path is where this proof names it: ${SHELL_DIRS.length} folders and ${SHELL_FILES.length} files, ${shellFiles.length} source files in all; ${files.length - shellFiles.length} files under src/ are outside it`,
  misplaced.length === 0,
  misplaced.map(path => `${path} holds no source file: name where it went in SHELL_DIRS or SHELL_FILES of ${SELF}`),
)
const inOrder = (rows: string[]): boolean => rows.every((row, i) => i === 0 || rows[i - 1]! < row)
check('both lists are in path order with no row twice', inOrder(IMPORTERS) && inOrder(IN_CYCLE), [`put the rows of ${inOrder(IMPORTERS) ? 'IN_CYCLE' : 'IMPORTERS'} in ${SELF} in path order, each once`])

section('(1) the door — files outside the shell path that import from inside it')
{
  const crossing = edges.filter(edge => !inside(edge.from) && inside(edge.to))
  const importers = [...new Set(crossing.map(edge => edge.from))].sort()
  const behindDoor = new Set(crossing.filter(edge => edge.from === PARSE_DOOR).map(edge => edge.to))
  check(`the door that already exists for parsing is ${PARSE_DOOR}: it imports ${behindDoor.size} shell-path files`, behindDoor.size > 0, [
    `${PARSE_DOOR} ${known.has(PARSE_DOOR) ? 'imports nothing from the shell path' : 'is gone'}: name the module that fronts the parser in PARSE_DOOR of ${SELF}`,
  ])

  const listed = new Set(IMPORTERS)
  const unlisted = importers.filter(file => !listed.has(file))
  const nameOnly = importers.filter(file => crossing.every(edge => edge.from !== file || edge.to.endsWith('/toolName.ts')))
  const lines = (kind: Kind): number => crossing.filter(edge => edge.kind === kind).length
  check(
    `every outside file that imports from inside is on the list: ${importers.length} files, ${crossing.length} import lines (${lines('static')} static, ${lines('lazy')} lazy, ${lines('type')} type-only), ${nameOnly.length} files taking only a toolName.ts`,
    unlisted.length === 0,
    [
      ...unlisted.flatMap(file => [
        `${file} is not on the list:`,
        ...crossing
          .filter(edge => edge.from === file)
          .map(edge => `  line ${edge.line} imports ${edge.to} — ${behindDoor.has(edge.to) ? `take it from ${PARSE_DOOR}, the door that already exists for parsing` : 'no door holds that file: take the import out of this line'}`),
      ]),
      `IMPORTERS in ${SELF} only shrinks: a new row is not the fix`,
    ],
  )

  const active = new Set(importers)
  const stale = IMPORTERS.filter(file => !active.has(file))
  check(
    `every row of the list still imports from inside: ${IMPORTERS.length} rows`,
    stale.length === 0,
    stale.map(file => `${file} ${known.has(file) ? 'imports nothing from inside the shell path' : 'is gone'}: delete its row from IMPORTERS in ${SELF}`),
  )
}

section('(2) the cycle — shell-path files inside the static import cycle, the largest group of files under src/ that reach one another through static imports')
{
  const pairs = [...new Set(edges.filter(edge => edge.kind === 'static' && edge.from !== edge.to).map(edge => `${edge.from}\t${edge.to}`))].map(pair => pair.split('\t') as [string, string])
  const cycle = largestCycle(pairs)
  const inCycle = shellFiles.filter(file => cycle.has(file))
  const allowed = new Set(IN_CYCLE)
  const loose = inCycle.filter(file => !allowed.has(file))

  const ties = (): string[] => {
    const looseSet = new Set(loose)
    const rows = pairs
      .filter(([from, to]) => looseSet.has(from) && cycle.has(to))
      .map(([from, to]) => {
        const rest = largestCycle(pairs.filter(pair => pair[0] !== from || pair[1] !== to))
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
        ? ['one static import ties them in:', ...freeing.map(row => `  ${row.site} — without it ${row.left} shell-path files stay inside, all on the list`)]
        : ['no single static import frees them all; the ones that free the most:', ...rows.slice(0, 5).map(row => `  ${row.site} — without it ${row.left} stay inside, ${row.loose} not on the list`)]),
      `load that import at the call that needs it (await import(...) inside the function) or take it out; IN_CYCLE in ${SELF} only shrinks`,
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
}

console.log('')
console.log(failures === 0 ? 'prove-shell-door: BOTH COUNTS HOLD' : `prove-shell-door: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
