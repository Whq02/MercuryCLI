#!/usr/bin/env bun
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { largestCycle, readImports, staticPairs, type Edge, type Kind, type Unread } from '../lib/importCycle.ts'

const ROOT = join(import.meta.dir, '..', '..')
const SELF = 'scripts/gate/prove-shell-door.ts'
const PARSE_DOOR = 'src/permissions/rules/decision/commandAnalysis.ts'
const PROBE = 'src/tools/shell/bashPermissions.ts'

const SHELL_DIRS = [
  'src/utils/shell/',
  'src/platform/shell/bash/',
  'src/permissions/rules/decision/command-analysis/',
  'src/tools/shell/',
  'src/tools/powershell/',
  'src/utils/powershell/',
  'src/engine/tasks/local-shell/',
]
const SHELL_FILES = ['src/platform/shell/shellExec.ts', 'src/platform/shell/shellProcess.ts']

const IMPORTERS = [
  'src/boot/entrypoints/cli.tsx',
  'src/boot/entrypoints/init.ts',
  'src/boot/entrypoints/shellParentGuard.ts',
  'src/boot/sessionSetup.ts',
  'src/commands/exit/WorktreeExitDialog.tsx',
  'src/daemon/runner-link/runnerScript.ts',
  'src/daemon/runner/runHeadless.ts',
  'src/daemon/runner/runnerAsks.ts',
  'src/daemon/runner/sendNow.ts',
  'src/daemon/switchboard/sessionReceipts.ts',
  'src/engine/connector/shellRunning.ts',
  'src/engine/connector/workRoster.ts',
  'src/engine/messages/apiSystemAndToolSchema.ts',
  'src/engine/messages/attachmentText.ts',
  'src/engine/rows/turn/turnRows.ts',
  'src/engine/system-prompt/defaultSystemPrompt.ts',
  'src/engine/task-framework/taskOutput.ts',
  'src/engine/tasks/stopTask.ts',
  'src/engine/tasks/taskState.ts',
  'src/engine/tasks/tasks.ts',
  'src/engine/tool-dispatch/promptShellExecution.ts',
  'src/engine/user-input/BashModeProgress.tsx',
  'src/engine/user-input/processBashCommand.tsx',
  'src/integrations/acp/ideToolBridge.ts',
  'src/integrations/debugger/dapTerminal.ts',
  'src/integrations/event-hook-schemas/hooks.ts',
  'src/integrations/event-hooks/commandRunner.ts',
  'src/integrations/extensions/manifest.ts',
  'src/integrations/mcp/mcpServer.ts',
  'src/integrations/mcp/stdioCommandSafety.ts',
  'src/permissions/capability-census/census.ts',
  'src/permissions/cards/PermissionRequest.tsx',
  'src/permissions/cards/bash/ShellPermissionRequest.tsx',
  'src/permissions/cards/bash/shellAskOptions.tsx',
  'src/permissions/cards/powershell/PowerShellPermissionRequest.tsx',
  'src/permissions/cards/sed-edit/SedEditPermissionRequest.tsx',
  'src/permissions/guards/generatedAssets.ts',
  'src/permissions/rules/commandContent.ts',
  'src/permissions/rules/decision/commandAnalysis.ts',
  'src/permissions/rules/flowLaw.ts',
  'src/permissions/rules/shellProtectedPaths.ts',
  'src/permissions/rules/shellRuleMatching.ts',
  'src/permissions/wards/wardsShellRead.ts',
  'src/platform/health/healthReport.ts',
  'src/platform/health/readiness.ts',
  'src/platform/processes/spawnPlan.ts',
  'src/screen/chat/interruptKeys.ts',
  'src/screen/chat/useChatBoot.tsx',
  'src/screen/cockpit-gauges/helmLanesModel.ts',
  'src/screen/composer/typeahead/accept.ts',
  'src/screen/composer/typeahead/tokens.ts',
  'src/screen/messages-list/foldShellNotices.ts',
  'src/screen/messages/UserBashOutputMessage.tsx',
  'src/screen/messages/collapseReadSearch.ts',
  'src/screen/session-chooser/crossProjectResume.ts',
  'src/screen/settings/config/configRowsEngine.tsx',
  'src/screen/settings/config/useConfigExits.ts',
  'src/screen/tasks/BackgroundTask.tsx',
  'src/screen/tasks/BackgroundTasksDialog.tsx',
  'src/screen/tasks/ShellDetailDialog.tsx',
  'src/screen/tasks/ShellProgress.tsx',
  'src/screen/tasks/background-tasks/actions.ts',
  'src/screen/tasks/background-tasks/views.tsx',
  'src/tools/computer/call/call.ts',
  'src/tools/computer/roads/sequence.ts',
  'src/tools/crewmate/foregroundExecution.tsx',
  'src/tools/crewmate/reviewerPolicy.ts',
  'src/tools/crewmate/runCrewmate.ts',
  'src/tools/crewmate/scoutPolicy.ts',
  'src/tools/debug/DebugTool.ts',
  'src/tools/enter-worktree/EnterWorktreeTool.ts',
  'src/tools/exit-worktree/ExitWorktreeTool.ts',
  'src/tools/journey/JourneyTool.ts',
  'src/tools/kit/notebook.ts',
  'src/tools/kit/toolErrors.ts',
  'src/tools/kit/toolList.ts',
  'src/tools/monitor/MonitorTool.ts',
  'src/tools/monitor/watchReceipts.ts',
  'src/tools/service/ServiceTool.ts',
  'src/tools/task-stop/TaskStopTool.ts',
]

const IN_CYCLE: string[] = []

const UNREAD: Array<[string, number]> = [
  ['src/crew/board/seam.ts', 1],
  ['src/crew/board/store.ts', 1],
  ['src/integrations/desktop/pack.ts', 1],
  ['src/integrations/extensions/installConsent.ts', 2],
  ['src/integrations/lsp/ts-sidecar/sidecar.ts', 1],
  ['src/integrations/media/host.ts', 1],
  ['src/integrations/media/settings.ts', 2],
  ['src/integrations/voice-pack/voicePack.ts', 1],
  ['src/integrations/voice/whisperPack.ts', 1],
  ['src/integrations/vulcan/engine/leases.ts', 1],
  ['src/platform/grammars/grammarFacility.ts', 1],
  ['src/platform/shell/bash/commandSpecs.ts', 1],
  ['src/sessions/mneme/embedPack.ts', 1],
  ['src/tools/engines/structure/tsFacility.ts', 1],
  ['src/tools/kit/pdfTextWorker.mjs', 1],
  ['src/tools/read/jsonQueryWorker.mjs', 1],
  ['src/tools/read/readRichFormats.ts', 1],
]

const GRAMMAR_READERS: Array<[string, number]> = [
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
const lists: Array<[string, string[]]> = [
  ['IMPORTERS', IMPORTERS],
  ['IN_CYCLE', IN_CYCLE],
  ['UNREAD', UNREAD.map(row => row[0])],
  ['GRAMMAR_READERS', GRAMMAR_READERS.map(row => row[0])],
]
check(
  'the four lists are in path order with no row twice',
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

section('(4) the record — which shell this is, asked in one place: places that test a shell\'s name or spell one shell\'s own words, in the shell folder and in every file that asks the record')
{
  const RECORD = 'src/platform/shell/shellRecord.ts'
  const WORDS = /ZSH_VERSION|BASH_VERSION|BASHPID|setopt |shopt |pipestatus/i
  const STILL_OUTSIDE: Record<string, number> = {
    'src/platform/shell/bash/shellSnapshot.ts': 1,
  }
  const SHELL_WORDS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh', 'fish', 'ash', 'mksh', 'yash', 'csh', 'tcsh'])
  const namesAShell = (text: string): boolean => /^(?:.*\/)?(?:zsh|bash)(?:\.exe)?$/.test(text)
  const NAME_METHODS = new Set(['includes', 'endsWith', 'startsWith', 'indexOf'])
  const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])
  const toolTypeRead = (node: ts.Expression): boolean => (ts.isIdentifier(node) && /^(?:shell)?type$/i.test(node.text)) || (ts.isPropertyAccessExpression(node) && /^(?:shell)?type$/i.test(node.name.text))
  const askers = new Set(edges.filter(edge => edge.to === RECORD).map(edge => edge.from))
  const scope = files.filter(file => file.startsWith('src/utils/shell/') || askers.has(file))
  const placesIn = (file: string, text: string): number[] => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const hit = new Set<number>()
    const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && NAME_METHODS.has(node.expression.name.text) && node.arguments.length >= 1) {
        const asked = node.arguments[0]!
        if (ts.isStringLiteralLike(asked) && namesAShell(asked.text)) hit.add(lineOf(node))
      }
      if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
        const [name, other] = ts.isStringLiteralLike(node.left) ? [node.left, node.right] : ts.isStringLiteralLike(node.right) ? [node.right, node.left] : [null, null]
        if (name !== null && other !== null && namesAShell(name.text) && !toolTypeRead(other)) hit.add(lineOf(node))
      }
      if (ts.isCaseClause(node) && ts.isStringLiteralLike(node.expression) && namesAShell(node.expression.text) && !toolTypeRead(node.parent.parent.expression)) hit.add(lineOf(node))
      if (ts.isRegularExpressionLiteral(node) && /(?:^|[^a-z])(?:zsh|bash)(?:[^a-z]|$)/i.test(node.text)) hit.add(lineOf(node))
      if (ts.isArrayLiteralExpression(node) && node.elements.filter(element => ts.isStringLiteralLike(element) && SHELL_WORDS.has(element.text)).length >= 2) hit.add(lineOf(node))
      if ((ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && WORDS.test(node.text)) hit.add(lineOf(node))
      ts.forEachChild(node, visit)
    }
    visit(source)
    return [...hit].sort((a, b) => a - b)
  }
  const SPELLINGS: Array<[string, string]> = [
    ['includes', "const a = shell.includes('zsh')"],
    ['endsWith', "const a = shell.endsWith('/zsh')"],
    ['startsWith', "const a = name.startsWith('bash')"],
    ['an equality', "const a = basename(shell) === 'zsh'"],
    ['an inequality', "const a = name !== 'bash'"],
    ['a case', "switch (name) { case 'zsh': break }"],
    ['a pattern', 'const a = /(?:^|\\/)zsh$/.test(shell)'],
    ['a set of names', "const NAMES = new Set(['bash', 'zsh', 'sh', 'dash'])"],
    ["one shell's own word", "const a = 'setopt NO_NOMATCH'"],
  ]
  const unread = SPELLINGS.filter(([, text]) => placesIn('spelling.ts', text).length !== 1).map(([name]) => name)
  check(`a comparison of a shell's name is read however it is spelled: ${SPELLINGS.map(([name]) => name).join(', ')}`, unread.length === 0, unread.map(name => `${name} is not read: make placesIn in ${SELF} count that spelling as one place`))
  const NOT_A_NAME = ["if (shellType === 'bash') run()", "const TYPES = ['bash', 'powershell'] as const", "if (provider.type !== 'bash') run()", "const found = which('bash')"]
  const misread = NOT_A_NAME.filter(text => placesIn('spelling.ts', text).length !== 0)
  check("the tool's own type word is not a shell's name: shellType and a provider's type against 'bash', the list of tool types, a search for a program", misread.length === 0, misread.map(text => `${text} is read as a comparison of a shell's name: narrow placesIn in ${SELF} so it leaves this spelling alone`))

  const found = scope.map(file => ({ file, lines: placesIn(file, readFileSync(join(ROOT, file), 'utf8')) })).filter(row => row.lines.length > 0)
  const outside = found.filter(row => row.file !== RECORD)
  const inside = found.find(row => row.file === RECORD)?.lines.length ?? 0
  const unlisted = outside.filter(row => row.lines.length > (STILL_OUTSIDE[row.file] ?? 0))
  const fallen = Object.entries(STILL_OUTSIDE).filter(([file, count]) => (outside.find(row => row.file === file)?.lines.length ?? 0) < count)
  check(
    `no file but the record asks which shell this is, but for the list that may only fall: ${outside.reduce((n, row) => n + row.lines.length, 0)} places in ${outside.length} files outside ${RECORD} (the list holds ${Object.values(STILL_OUTSIDE).reduce((n, count) => n + count, 0)}: ${Object.keys(STILL_OUTSIDE).join(', ')}), ${inside} inside it, over the ${scope.length} files of the shell folder and the record's askers (${askers.size})`,
    known.has(RECORD) && askers.size > 0 && unlisted.length === 0 && fallen.length === 0,
    known.has(RECORD)
      ? [
          ...unlisted.flatMap(row => row.lines.map(line => `${row.file}:${line} tests a shell's name or spells one shell's own words`)),
          ...fallen.map(([file, count]) => `${file} holds fewer than its row of ${count}: lower the row in STILL_OUTSIDE of ${SELF}, or delete it at 0`),
          `ask ${RECORD} instead: shellRecord() and systemShellRecord() give the path, the dialect, the version and the origin; shellRecordWords() the prompt's words; getGlobPreambleCommand(origin) the preamble; a word only one shell understands is a constant of the record`,
        ]
      : [
          `${RECORD} is gone: name the module that owns the record of the shell in RECORD of ${SELF}`,
          ...outside.flatMap(row => row.lines.map(line => `${row.file}:${line} tests a shell's name or spells one shell's own words`)),
        ],
  )
}

section("(5) the walker — files under src/ outside the walker folder and parser.ts that compare a .type with a grammar node kind or import the parser's Node")
{
  const WALKER_DIR = 'src/permissions/rules/decision/command-analysis/'
  const PARSER = 'src/platform/shell/bash/parser.ts'
  const BASH_PARSER = 'src/platform/shell/bash/bashParser.ts'
  const COMPLETION = 'src/platform/shell/bash/shellCompletion.ts'
  const WRITE = process.argv.includes('--write')
  const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken])
  const SHARED_WORDS = new Set(['string', 'number', 'local', 'done', 'readonly', 'list', 'command', 'comment', 'ERROR', 'function_definition', 'compound_statement'])
  const isDotType = (node: ts.Expression): boolean => ts.isPropertyAccessExpression(node) && node.name.text === 'type'
  const isNodeSource = (file: string): boolean => file === PARSER || file === BASH_PARSER || file === PARSE_DOOR || file.startsWith(WALKER_DIR)

  type TypeHit = { line: number; text: string; words: string[] }
  const collectSets = (source: ts.SourceFile): Map<string, Set<string>> => {
    const sets = new Map<string, Set<string>>()
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let init = node.initializer
        while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression
        let arr: ts.ArrayLiteralExpression | undefined
        if (ts.isArrayLiteralExpression(init)) arr = init
        else if (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'Set' && init.arguments?.[0] && ts.isArrayLiteralExpression(init.arguments[0])) arr = init.arguments[0]
        if (arr) {
          const vals = new Set<string>()
          for (const el of arr.elements) if (ts.isStringLiteralLike(el)) vals.add(el.text)
          if (vals.size > 0) sets.set(node.name.text, vals)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return sets
  }

  const typeHitsIn = (file: string, text: string): TypeHit[] => {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const sets = collectSets(source)
    const hits: TypeHit[] = []
    const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const visit = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
        const lit = isDotType(node.left) && ts.isStringLiteralLike(node.right)
          ? node.right
          : isDotType(node.right) && ts.isStringLiteralLike(node.left)
            ? node.left
            : null
        if (lit) hits.push({ line: lineOf(node), text: node.getText(source), words: [lit.text] })
      }
      if (ts.isSwitchStatement(node) && isDotType(node.expression)) {
        const words: string[] = []
        for (const clause of node.caseBlock.clauses) {
          if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) words.push(clause.expression.text)
        }
        if (words.length > 0) hits.push({ line: lineOf(node), text: `switch (${node.expression.getText(source)})`, words })
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.arguments.length === 1 && isDotType(node.arguments[0]!)) {
        const method = node.expression.name.text
        const target = node.expression.expression
        if (method === 'has' && ts.isIdentifier(target) && sets.has(target.text)) {
          hits.push({ line: lineOf(node), text: node.getText(source), words: [...sets.get(target.text)!] })
        }
        if (method === 'includes') {
          if (ts.isIdentifier(target) && sets.has(target.text)) {
            hits.push({ line: lineOf(node), text: node.getText(source), words: [...sets.get(target.text)!] })
          } else if (ts.isArrayLiteralExpression(target)) {
            const words: string[] = []
            for (const el of target.elements) if (ts.isStringLiteralLike(el)) words.push(el.text)
            if (words.length > 0) hits.push({ line: lineOf(node), text: node.getText(source), words })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    return hits
  }

  const hitsByFile = new Map(files.map(file => [file, typeHitsIn(file, readFileSync(join(ROOT, file), 'utf8'))]))
  const listed = new Map(GRAMMAR_READERS)
  const kindSources = files.filter(file => file.startsWith(WALKER_DIR) || file === PARSER)
  const grammarKinds = new Set<string>()
  for (const file of kindSources) {
    for (const hit of hitsByFile.get(file) ?? []) {
      for (const word of hit.words) grammarKinds.add(word)
    }
  }
  check(
    `grammar node kinds read from the walker folder and ${PARSER}: ${grammarKinds.size} kinds across ${kindSources.length} source file(s)`,
    grammarKinds.size > 0,
    [`no grammar node kinds were found in ${WALKER_DIR} or ${PARSER}: check WALKER_DIR and PARSER in ${SELF} name where the walker still lives, or fix typeHitsIn there`],
  )

  const matchHits = (hits: TypeHit[], touchesDoor: boolean): TypeHit[] =>
    hits.filter(hit => {
      const matched = hit.words.filter(word => grammarKinds.has(word))
      if (matched.length === 0) return false
      return touchesDoor ? true : matched.some(word => !SHARED_WORDS.has(word))
    })

  const SPELLINGS: Array<[string, string]> = [
    ['equality', "if (node.type === 'command') run()"],
    ['inequality', "if (child.type !== 'command_name') run()"],
    ['switch', "switch (node.type) { case 'file_redirect': break }"],
    ['Set.has', "const KINDS = new Set(['variable_assignment', 'declaration_command']); if (KINDS.has(node.type)) run()"],
    ['inline array includes', "if (['command', 'pipeline'].includes(node.type)) run()"],
    ['const array includes', "const KINDS = ['word', 'string']; if (KINDS.includes(child.type)) run()"],
  ]
  const missed = SPELLINGS.filter(([, text]) => matchHits(typeHitsIn('spelling.ts', text), true).length !== 1).map(([name]) => name)
  check(`a grammar node kind test is read however it is spelled: ${SPELLINGS.map(([name]) => name).join(', ')}`, missed.length === 0, missed.map(name => `${name} is not read: make typeHitsIn or matchHits in ${SELF} count that spelling as one place`))

  const NOT_A_KIND = ["if (type === 'command') run()", "if (context.type !== 'file') run()", "if (rule.type === 'exact') run()"]
  const misread = NOT_A_KIND.filter(text => matchHits(typeHitsIn('spelling.ts', text), true).length !== 0)
  check("non-grammar type checks are not read as grammar kinds (including shellCompletion's type === 'command' and context.type !== 'file')", misread.length === 0, misread.map(text => `${text} is read as a grammar node kind test: narrow typeHitsIn or matchHits in ${SELF} so it leaves this spelling alone`))

  const nodeImports = new Map<string, number>()
  const doorImporters = new Set<string>()
  for (const edge of edges) {
    if (isNodeSource(edge.to) && (edge.names.includes('Node') || edge.names.includes('TsNode'))) {
      nodeImports.set(edge.from, (nodeImports.get(edge.from) ?? 0) + 1)
    }
    if (isNodeSource(edge.to)) doorImporters.add(edge.from)
  }

  type FoundReader = { total: number; typeHits: TypeHit[]; nodeImports: number }
  const found = new Map<string, FoundReader>()
  for (const file of files) {
    if (file.startsWith(WALKER_DIR) || file === PARSER) continue
    const importsNode = file === PARSE_DOOR ? 0 : (nodeImports.get(file) ?? 0)
    const touchesDoor = doorImporters.has(file) || file.startsWith('src/platform/shell/bash/')
    const typeHits = matchHits(hitsByFile.get(file) ?? [], touchesDoor)
    const total = typeHits.length + importsNode
    if (total > 0) found.set(file, { total, typeHits, nodeImports: importsNode })
  }

  const completionHits = found.get(COMPLETION)?.total ?? 0
  check(
    `the eleventh file of the brief (${COMPLETION}) is not a grammar reader: ${completionHits} grammar-kind reads (its type === 'command' is ShellCompletionType)`,
    known.has(COMPLETION) && completionHits === 0,
    completionHits > 0 ? [`${COMPLETION} now holds ${completionHits} grammar-kind read(s)`] : [`${COMPLETION} is gone`],
  )

  const over = [...found].filter(([file, row]) => row.total > (listed.get(file) ?? 0)).sort((a, b) => (a[0] < b[0] ? -1 : 1))
  let under = GRAMMAR_READERS.filter(([file, count]) => (found.get(file)?.total ?? 0) < count)

  if (WRITE && over.length === 0 && under.length > 0) {
    const nextRows: Array<[string, number]> = []
    for (const [file] of GRAMMAR_READERS) {
      const now = found.get(file)?.total ?? 0
      if (now > 0) nextRows.push([file, now])
    }
    const selfPath = join(ROOT, SELF)
    const raw = readFileSync(selfPath, 'utf8')
    const marker = 'const GRAMMAR_READERS: Array<[string, number]> = ['
    const start = raw.indexOf(marker)
    const end = start === -1 ? -1 : raw.indexOf('\n]', start)
    if (start !== -1 && end !== -1) {
      const body = nextRows.map(([file, count]) => `  ['${file}', ${count}],`).join('\n')
      const block = nextRows.length === 0 ? `${marker}\n]` : `${marker}\n${body}\n]`
      writeFileSync(selfPath, raw.slice(0, start) + block + raw.slice(end + 2))
      console.log(`  [WRITE] lowered GRAMMAR_READERS in ${SELF}: ${GRAMMAR_READERS.length} -> ${nextRows.length} rows (${under.map(([file, count]) => `${file} ${count}->${found.get(file)?.total ?? 0}`).join(', ')})`)
      under = []
    }
  }

  const totalPlaces = [...found.values()].reduce((sum, row) => sum + row.total, 0)
  check(
    `every file outside ${WALKER_DIR} and ${PARSER} that tests a grammar node kind or imports Node is on GRAMMAR_READERS: ${found.size} files, ${totalPlaces} places`,
    over.length === 0,
    [
      ...over.flatMap(([file, row]) => {
        const allowed = listed.get(file) ?? 0
        const details = [
          ...row.typeHits.map(hit => `  ${file}:${hit.line} ${hit.text}`),
          ...(row.nodeImports > 0 ? [`  ${file} imports Node from the parser (${row.nodeImports})`] : []),
        ]
        return [
          allowed > 0
            ? `${file} holds ${row.total} places and GRAMMAR_READERS says ${allowed}:`
            : `${file} is not on GRAMMAR_READERS (${row.total} places):`,
          ...details,
        ]
      }),
      `ask ${PARSE_DOOR} instead; GRAMMAR_READERS in ${SELF} only shrinks (--write lets rows fall and nothing else)`,
    ],
  )

  check(
    `every row of GRAMMAR_READERS still holds as many: ${GRAMMAR_READERS.length} rows`,
    under.length === 0,
    [
      ...under.map(([file, count]) => {
        const now = found.get(file)?.total ?? 0
        if (now === 0) return `${file} ${known.has(file) ? 'holds 0 grammar-kind reads' : 'is gone'}: delete its row from GRAMMAR_READERS`
        return `${file} holds ${now} and GRAMMAR_READERS says ${count}: lower its row to ${now}`
      }),
      `run \`bun ${SELF} --write\` to lower fallen rows (rows may only fall)`,
    ],
  )
}
console.log('')
console.log(failures === 0 ? 'prove-shell-door: BOTH COUNTS HOLD' : `prove-shell-door: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
