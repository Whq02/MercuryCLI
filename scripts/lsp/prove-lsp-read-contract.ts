import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { armScratch, check, cleanup, finish, openToolDoor, REPO, TS_PROBE_FILES, TS_SIDECAR_ENTRY, writeProject } from './lspProofDoor.ts'

const scratch = armScratch('lsp-read-contract')
const project = writeProject(scratch, 'project', TS_PROBE_FILES)
symlinkSync(join(REPO, 'node_modules'), join(project, 'node_modules'), 'dir')
process.env.MERCURY_LSP_SIDECAR_ENTRY = TS_SIDECAR_ENTRY
const available = await import('../../src/tools/LSPTool/LSPTool.ts')
if (!('LspReadTool' in available)) {
  check('LspRead answers through its own read-only tool', false)
  cleanup(scratch)
  finish('prove-lsp-read-contract')
}
const door = await openToolDoor(project)
const lib = join(project, 'lib.ts')
const main = join(project, 'main.ts')
const plain = (text: string) => text.replace(/<\/?tool_use_error>/g, '')
try {
  for (const operation of ['goToDefinition', 'findReferences', 'hover', 'goToImplementation', 'typeDefinition', 'incomingCalls', 'outgoingCalls']) {
    const input = { operation, filePath: lib, line: 1, character: 14 }
    const answer = await door.drive(input)
    const filled = await door.drive({ ...input, query: 'unused', limit: 1, paths: [join(project, 'absent.ts')] })
    check(`${operation} answers with its own arguments`, !answer.isError && answer.data?.operation === operation, answer.text)
    check(`${operation} ignores advertised arguments it does not read`, answer.text === filled.text && answer.isError === filled.isError, filled.text)
    const bad = await door.drive({ operation, filePath: lib })
    check(`${operation} names the missing position exactly`, plain(bad.text) === `${operation} requires filePath, line and character (1-based symbol position, as Read shows it); missing: line, character. Example: {"operation":"${operation}","filePath":"/absolute/path/file.ts","line":12,"character":8}. Nothing was sent to a language server.`, bad.text)
  }
  for (const input of [{ operation: 'documentSymbol', filePath: lib }, { operation: 'workspaceSymbol', query: 'budget', filePath: lib }, { operation: 'serverStatus' }]) {
    const answer = await door.drive(input)
    const filled = await door.drive({ line: 1, character: 1, paths: [join(project, 'absent.ts')], ...input })
    check(`${input.operation} answers and ignores unread keys`, !answer.isError && answer.text === filled.text, filled.text)
  }
  const diagnostic = await door.drive({ operation: 'diagnostics', filePath: main })
  check('diagnostics filePath preserves the single-file result', !diagnostic.isError && /1 diagnostics \(1 errors, 0 warnings\)/.test(diagnostic.text), diagnostic.text)
  const workspace = await door.drive({ operation: 'diagnostics', paths: [project] })
  check('diagnostics paths expands directories and keeps the public operation', !workspace.isError && /2 of 2 file\(s\) checked/.test(workspace.text) && workspace.data?.operation === 'diagnostics', workspace.text)
  const empty = await door.drive({ operation: 'diagnostics', paths: [], filePath: main })
  check('empty paths takes the single-file road', !empty.isError && /1 diagnostics/.test(empty.text), empty.text)
  const tooMany = await door.drive({ operation: 'diagnostics', paths: Array(51).fill(main) })
  check('51 paths is a schema refusal', tooMany.isError && /50/.test(tooMany.text), tooMany.text)
  const missingMessages = [
    [{ operation: 'documentSymbol' }, 'documentSymbol reads filePath, which is missing. Example: {"operation":"documentSymbol","filePath":"/absolute/path/file.ts"}. Nothing was sent to a language server.'],
    [{ operation: 'workspaceSymbol' }, 'workspaceSymbol requires a non-empty query (a symbol name or substring). Example: {"operation":"workspaceSymbol","query":"parseConfig"}. Nothing was sent to a language server.'],
    [{ operation: 'diagnostics' }, 'diagnostics requires paths (up to 50 files or directories) or filePath for one file; neither was given. Example: {"operation":"diagnostics","paths":["/absolute/path/a.ts","/absolute/path/src"]}. Nothing was sent to a language server.'],
  ] as const
  for (const [input, expected] of missingMessages) {
    const answer = await door.drive(input)
    check(`${input.operation} missing-argument words`, answer.isError && plain(answer.text) === expected, answer.text)
  }
  for (const operation of ['rename', 'moveSymbol', 'pathRename', 'codeActions', 'fixDiagnostic', 'formatDocument', 'formatRange', 'organizeImports', 'rawRequest', 'workspaceDiagnostics', 'prepareCallHierarchy', 'switchSourceHeader', 'capabilities', 'nonsense']) {
    const answer = await door.drive({ operation })
    const expected = `${operation} is not an LspRead operation. LspRead answers goToDefinition, findReferences, hover, goToImplementation, typeDefinition, incomingCalls, outgoingCalls, documentSymbol, workspaceSymbol, diagnostics and serverStatus; renaming, moving, code actions, formatting and raw requests are LspRename, LspMoveSymbol, LspMoveFile, LspCodeAction, LspFormat and LspRequest.`
    check(`${operation} takes the generic unknown-operation road`, answer.isError && plain(answer.text) === expected, answer.text)
  }
  const missing = join(project, 'created.ts')
  for (let i = 0; i < 5; i++) {
    const answer = await door.drive({ operation: 'diagnostics', filePath: missing })
    check(`missing file refusal ${i + 1} never latches`, answer.isError && plain(answer.text) === `${missing} does not exist. diagnostics needs an existing file; Glob finds a file by name. Nothing was sent to a language server.`, answer.text)
  }
  writeFileSync(missing, 'export const created = 1\n')
  const created = await door.drive({ operation: 'diagnostics', filePath: missing })
  check('a file created after validation refusals is tried again', !created.isError && !/Not tried/.test(created.text), created.text)
  const directory = await door.drive({ operation: 'hover', filePath: project, line: 1, character: 1 })
  check('a directory where a file is needed has R9 words', directory.isError && plain(directory.text) === `${project} is a directory; hover reads one file. Nothing was sent to a language server.`, directory.text)
  if (process.platform !== 'win32') {
    const { execFileSync } = await import('node:child_process')
    const pipe = join(project, 'named-pipe.ts')
    execFileSync('mkfifo', [pipe], { windowsHide: true })
    const refusedPipe = await door.drive({ operation: 'diagnostics', filePath: pipe })
    check('directory support never admits a blocking special file', refusedPipe.isError && /not a regular file/.test(refusedPipe.text), refusedPipe.text)
  }
  const race = writeProject(project, 'race', {
    'package.json': '{"type":"module"}',
    'jsconfig.json': '{"compilerOptions":{"allowJs":true},"include":["*.mjs"]}',
    'cache.mjs': 'export function cache() { return {} }\n',
    'label.mjs': "import { cache } from './cache.mjs';\n\nexport function label(region) {\n  const pct = 7;\n\n  cache()[region] = pct;\n}\n",
    'many.mjs': "import { cache } from './cache.mjs';\n" + Array.from({ length: 55 }, (_, i) => `cache().value${i} = ${i};`).join('\n'),
  })
  const reference = await door.drive({ operation: 'findReferences', filePath: join(race, 'label.mjs'), line: 6, character: 3 })
  check('the shared-table writer is readable beside its reference', reference.text.includes('cache()[region] = pct;'), reference.text)
  check('references stop at 50 hits and count the remainder', reference.text.includes('9 more references.') && (reference.text.match(/  Line /g) ?? []).length === 50 && reference.text.length < 12_000, reference.text)
  const definition = await door.drive({ operation: 'goToDefinition', filePath: join(race, 'label.mjs'), line: 6, character: 3 })
  check('definitions carry their trimmed source line', definition.text.includes('export function cache() { return {} }'), definition.text)
  const outside = writeProject(scratch, 'outside', { 'outside.ts': 'export const outside = 1\n' })
  const manager = door.manager()!
  const send = manager.sendRequest.bind(manager)
  const { pathToFileURL } = await import('node:url')
  const hit = (file: string, line = 0) => ({ uri: pathToFileURL(file).href, range: { start: { line, character: 0 }, end: { line, character: 1 } } })
  try {
    manager.sendRequest = async () => [hit(join(outside, 'outside.ts'))] as never
    const concealed = await door.drive({ operation: 'findReferences', filePath: lib, line: 1, character: 14 })
    check('an outside target keeps its position but not unread source', concealed.text.includes('outside.ts:1:1') && !concealed.text.includes('export const outside'), concealed.text)
    const linked = join(project, 'linked.ts')
    symlinkSync(join(outside, 'outside.ts'), linked)
    manager.sendRequest = async () => [hit(linked)] as never
    const escaped = await door.drive({ operation: 'goToDefinition', filePath: lib, line: 1, character: 14 })
    check('source-line permission follows an escaping symlink', !escaped.text.includes('export const outside'), escaped.text)
    manager.sendRequest = async () => [hit(join(project, 'gone.ts'))] as never
    const absent = await door.drive({ operation: 'goToDefinition', filePath: lib, line: 1, character: 14 })
    check('an unreadable definition still has its position', !absent.isError && absent.text.includes('gone.ts:1:1'), absent.text)
    writeFileSync(join(project, 'long.ts'), '  ' + 'x'.repeat(300) + '\n')
    manager.sendRequest = async () => Array.from({ length: 55 }, () => hit(join(project, 'long.ts'))) as never
    const capped = await door.drive({ operation: 'goToDefinition', filePath: lib, line: 1, character: 14 })
    check('definition source lines trim to 160 characters and stop at 50 hits', capped.text.includes('5 more definitions.') && capped.text.split('\n').filter(line => line.trim() === 'x'.repeat(160)).length === 50 && !capped.text.includes('x'.repeat(161)), capped.text)
    const types = await door.drive({ operation: 'typeDefinition', filePath: lib, line: 1, character: 14 })
    check('type definitions use the same bounded source-line road', types.text.includes('5 more type definitions.') && types.text.split('\n').filter(line => line.trim() === 'x'.repeat(160)).length === 50, types.text)
    const target = hit(join(race, 'label.mjs'), 5)
    manager.sendRequest = async () => [{ targetUri: target.uri, targetRange: hit(lib).range, targetSelectionRange: target.range }] as never
    const selection = await door.drive({ operation: 'goToDefinition', filePath: lib, line: 1, character: 14 })
    check('a definition link reads the selected line, not the enclosing range', selection.text.includes('label.mjs:6:1') && selection.text.includes('cache()[region] = pct;'), selection.text)
  } finally {
    manager.sendRequest = send
  }
  const denied = await door.driveNamed('LspRead', { operation: 'diagnostics', paths: [main, join(outside, 'outside.ts')] }, 'deny')
  check('every paths entry takes read permission, not just the working directory', denied.isError && denied.asks.length > 0, denied.text)
} finally {
  await door.close()
  cleanup(scratch)
}
finish('prove-lsp-read-contract')
