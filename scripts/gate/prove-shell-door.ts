#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')
const SELF = 'scripts/bash/prove-shell-door.ts'
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
  'src/tools/PowerShellTool/PowerShellTool.tsx',
  'src/tools/PowerShellTool/UI.tsx',
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

type Kind = 'static' | 'lazy' | 'type'
type Edge = { from: string; to: string; kind: Kind; line: number; names: string[]; leaves: boolean }
type Unread = { file: string; line: number; text: string }

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
    else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) files.push(`${dir}/${entry.name}`)
  }
}
walk('src')
files.sort()
const known = new Set(files)
const inside = (file: string): boolean => SHELL_DIRS.some(dir => file.startsWith(dir)) || SHELL_FILES.includes(file)

const tsconfig = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile)
const aliases = Object.entries(((tsconfig.config as { compilerOptions?: { paths?: Record<string, string[]> } } | undefined)?.compilerOptions?.paths ?? {}))

function aliased(spec: string): string[] {
  const out: string[] = []
  for (const [pattern, targets] of aliases) {
    const star = pattern.indexOf('*')
    const head = star < 0 ? pattern : pattern.slice(0, star)
    const tail = star < 0 ? '' : pattern.slice(star + 1)
    if (star < 0 ? spec !== pattern : spec.length < head.length + tail.length || !spec.startsWith(head) || !spec.endsWith(tail)) continue
    const middle = star < 0 ? '' : spec.slice(head.length, spec.length - tail.length)
    for (const target of targets) out.push(posix.normalize(target.replace('*', middle)))
  }
  return out
}

const SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
function resolveSpec(from: string, spec: string): string | null {
  const bases = spec.startsWith('.') ? [posix.join(posix.dirname(from), spec)] : spec.startsWith('src/') ? [spec] : aliased(spec)
  for (const base of bases) {
    const tries = [
      base,
      base.replace(/\.jsx?$/, '.ts'),
      base.replace(/\.jsx?$/, '.tsx'),
      base.replace(/\.mjs$/, '.mts'),
      base.replace(/\.cjs$/, '.cts'),
      ...SUFFIXES.map(suffix => base + suffix),
      ...SUFFIXES.map(suffix => `${base}/index${suffix}`),
    ]
    const hit = tries.find(candidate => known.has(candidate))
    if (hit !== undefined) return hit
  }
  return null
}

function bare(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) current = current.expression
  return current
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

function importedNames(clause: ts.ImportClause | undefined): string[] {
  const bindings = clause?.namedBindings
  if (!clause || (bindings && ts.isNamespaceImport(bindings))) return []
  return [...(clause.name ? ['default'] : []), ...(bindings ? bindings.elements.map(element => (element.propertyName ?? element.name).text) : [])]
}

function exportKind(node: ts.ExportDeclaration): Kind {
  if (node.isTypeOnly) return 'type'
  const clause = node.exportClause
  return clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly) ? 'type' : 'static'
}

const unread: Unread[] = []
const passedOn = new Set<string>()

function importsOf(file: string): Edge[] {
  const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.ESNext, false, kind)
  const out: Edge[] = []
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  const add = (spec: string, edgeKind: Kind, node: ts.Node, names: string[] = [], leaves = false): void => {
    const to = resolveSpec(file, spec)
    if (to !== null) out.push({ from: file, to, kind: edgeKind, line: lineOf(node), names, leaves })
  }
  const makers = new Set(['createRequire'])
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined
    if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === 'createRequire') makers.add(element.name.text)
  }
  const makesRequire = (expression: ts.Expression): boolean => {
    const call = bare(expression)
    if (!ts.isCallExpression(call)) return false
    const callee = bare(call.expression)
    return ts.isIdentifier(callee) ? makers.has(callee.text) : ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRequire'
  }
  const calledInPlace = new Set<ts.Node>()
  const visit = (node: ts.Node, enclosed: boolean, requires: ReadonlySet<string>): void => {
    let inner = enclosed
    let scope = requires
    if (ts.isFunctionLike(node) ? !calledInPlace.has(node) : ts.isPropertyDeclaration(node) && !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) inner = true
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseOrDefaultClause(node)) {
      const bound: string[] = []
      for (const statement of node.statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer && makesRequire(declaration.initializer)) bound.push(declaration.name.text)
      }
      if (bound.length > 0) scope = new Set([...requires, ...bound])
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text, importKind(node), node, importedNames(node.importClause))
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause
      add(node.moduleSpecifier.text, exportKind(node), node, clause && ts.isNamedExports(clause) ? clause.elements.map(element => (element.propertyName ?? element.name).text) : [], true)
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) passedOn.add(`${file}\t${(element.propertyName ?? element.name).text}`)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      add(node.moduleReference.expression.text, node.isTypeOnly ? 'type' : 'static', node)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text, 'type', node)
    else if (ts.isCallExpression(node)) {
      const callee = bare(node.expression)
      if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) calledInPlace.add(callee)
      const first = node.arguments[0]
      if (first && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && requires.has(callee.text)) || makesRequire(callee))) {
        const specifier = bare(first)
        if (ts.isStringLiteralLike(specifier)) add(specifier.text, enclosed ? 'lazy' : 'static', node)
        else unread.push({ file, line: lineOf(node), text: node.getText(source).replace(/\s+/g, ' ').slice(0, 80) })
      }
    }
    ts.forEachChild(node, child => visit(child, inner, scope))
  }
  visit(source, false, new Set(['require']))
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
