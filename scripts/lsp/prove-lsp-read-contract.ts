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
    check(`${operation} names the missing position exactly`, plain(bad.text) === `${operation} reads filePath, line and character — the symbol's position, 1-based, as Read shows it — and line, character are missing. Example: {"operation":"${operation}","filePath":"/absolute/path/file.ts","line":12,"character":8}. Nothing was sent to a language server.`, bad.text)
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
    [{ operation: 'workspaceSymbol' }, 'workspaceSymbol reads query — a symbol name or part of one — which is missing or empty. Example: {"operation":"workspaceSymbol","query":"parseConfig"}. Nothing was sent to a language server.'],
    [{ operation: 'diagnostics' }, 'diagnostics reads paths — up to 50 files or directories — or filePath for one file, and neither was given. Example: {"operation":"diagnostics","paths":["/absolute/path/a.ts","/absolute/path/src"]}. Nothing was sent to a language server.'],
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
  const outside = writeProject(scratch, 'outside', { 'outside.ts': 'export const outside = 1\n' })
  const denied = await door.driveNamed('LspRead', { operation: 'diagnostics', paths: [main, join(outside, 'outside.ts')] }, 'deny')
  check('every paths entry takes read permission, not just the working directory', denied.isError && denied.asks.length > 0, denied.text)
} finally {
  await door.close()
  cleanup(scratch)
}
finish('prove-lsp-read-contract')
