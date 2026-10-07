import { readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { armScratch, check, cleanup, finish, openToolDoor, REPO, TS_PROBE_FILES, TS_SIDECAR_ENTRY, writeProject } from './lspProofDoor.ts'

const scratch = armScratch('lsp-write-tools')
const project = writeProject(scratch, 'project', { ...TS_PROBE_FILES, 'folder/value.ts': 'export const value = 1\n', 'user.ts': 'import { value } from "./folder/value"\nexport const seen = value\n' })
symlinkSync(join(REPO, 'node_modules'), join(project, 'node_modules'), 'dir')
process.env.MERCURY_LSP_SIDECAR_ENTRY = TS_SIDECAR_ENTRY
const available = await import('../../src/tools/LSPTool/LSPTool.ts')
if (!('LspRenameTool' in available)) {
  check('the six writing tools have their own honest schemas', false)
  cleanup(scratch)
  finish('prove-lsp-write-tools')
}
const door = await openToolDoor(project)
const lib = join(project, 'lib.ts')
const main = join(project, 'main.ts')
const rename = { filePath: lib, line: 1, character: 14, newName: 'spend' }
const plain = (text: string) => text.replace(/<\/?tool_use_error>/g, '')
try {
  const requirements: Record<string, string[]> = { LspRename: ['filePath', 'line', 'character', 'newName'], LspMoveSymbol: ['filePath', 'line', 'character', 'targetPath'], LspMoveFile: ['filePath', 'newPath'], LspCodeAction: ['filePath', 'line', 'character'], LspFormat: ['filePath'], LspRequest: ['filePath', 'method'] }
  for (const [name, required] of Object.entries(requirements)) {
    const missing = await door.driveNamed(name, {})
    check(`${name} names every missing required argument`, missing.isError && required.every(key => missing.text.includes(key)), missing.text)
    const valid = Object.fromEntries(required.map(key => [key, key === 'filePath' ? lib : ['line', 'character'].includes(key) ? 1 : key === 'newPath' || key === 'targetPath' ? join(project, 'elsewhere.ts') : 'example']))
    const retired = await door.driveNamed(name, { ...valid, operation: 'rename' })
    const nonsense = await door.driveNamed(name, { ...valid, nonsense: 'rename' })
    check(`${name} treats operation like any unknown key`, retired.isError && nonsense.isError && retired.text.replaceAll('operation', 'nonsense') === nonsense.text, retired.text)
  }
  for (let i = 0; i < 4; i++) {
    const unread = await door.driveNamed('LspRename', { ...rename, apply: true })
    check(`unread-line refusal ${i + 1} never consumes a server-fault try`, unread.isError && /read-before-edit law/.test(unread.text) && !/Not tried/.test(unread.text), unread.text)
  }
  const preview = await door.driveNamed('LspRename', rename)
  const plan = preview.data?.plan
  check('rename preview prints edits and a plan without writing', !preview.isError && typeof plan === 'string' && /Preview only/.test(preview.text) && readFileSync(lib, 'utf8').includes('budget'), preview.text)
  writeFileSync(main, readFileSync(main, 'utf8') + '\n')
  const stale = await door.driveNamed('LspRename', { ...rename, apply: true, plan })
  check('stale plan refuses without writing', stale.isError && /no longer matches the edit set/.test(stale.text) && readFileSync(lib, 'utf8').includes('budget'), stale.text)
  const fresh = await door.driveNamed('LspRename', rename)
  const applied = await door.driveNamed('LspRename', { ...rename, apply: true, plan: fresh.data?.plan })
  check('rename applies exactly the fresh preview', !applied.isError && applied.data?.applied === true && /spend/.test(readFileSync(lib, 'utf8')) && /spend/.test(readFileSync(main, 'utf8')), applied.text)
  const source = join(project, 'folder')
  const newPath = join(project, 'moved')
  const move = await door.driveNamed('LspMoveFile', { filePath: source, newPath })
  check('a directory reaches the file-move preview', !move.isError && /Preview only/.test(move.text) && existsSync(source), move.text)
  const moved = await door.driveNamed('LspMoveFile', { filePath: source, newPath, apply: true, ...(move.data?.plan ? { plan: move.data.plan } : {}) })
  check('a directory moves with import updates', !moved.isError && existsSync(join(newPath, 'value.ts')) && !existsSync(source) && /moved\/value/.test(readFileSync(join(project, 'user.ts'), 'utf8')), moved.text)
  const same = await door.driveNamed('LspMoveFile', { filePath: lib, newPath: lib })
  check('move onto itself has M3 words', plain(same.text) === 'newPath is the same path as filePath; give the new location. Nothing was moved.', same.text)
  const occupied = await door.driveNamed('LspMoveFile', { filePath: lib, newPath: main })
  check('occupied destination uses the tool name and moves nothing', occupied.isError && /^LspMoveFile refused: Target already exists/.test(occupied.text), occupied.text)
  const formats = [
    [{ line: 1 }, 'LspFormat formats lines line through endLine: give both, or neither to format the whole file. Nothing was sent to a language server.'],
    [{ line: 2, endLine: 1 }, 'endLine (1) comes before line (2); the range is line through endLine. Nothing was sent to a language server.'],
    [{ line: 1, endLine: 1, organizeImports: true }, 'organizeImports works on the whole file; drop line and endLine. Nothing was sent to a language server.'],
  ] as const
  for (const [input, words] of formats) {
    const result = await door.driveNamed('LspFormat', { filePath: lib, ...input })
    check(`format range ${JSON.stringify(input)} has exact words`, result.isError && plain(result.text) === words, result.text)
  }
  const formatted = await door.driveNamed('LspFormat', { filePath: lib, line: 1, endLine: 1 })
  check('whole-line range reaches the formatter', !formatted.isError && formatted.data?.operation === 'formatRange', formatted.text)
  const actions = await door.driveNamed('LspCodeAction', { filePath: main, line: 2, character: 14 })
  check('code actions list through their own tool', !actions.isError && actions.data?.operation === 'codeActions', actions.text)
  const raw = await door.driveNamed('LspRequest', { filePath: lib, method: 'textDocument/rename' })
  check('raw rename is refused with the typed-tool reason', raw.isError && raw.text === "LspRequest refused: 'textDocument/rename' is an edit-class method — use LspRename — its result rides the drift-safe apply transaction. Nothing was sent.", raw.text)
  const invalidJson = await door.driveNamed('LspRequest', { filePath: lib, method: 'textDocument/documentHighlight', params: '{' })
  check('raw JSON refusal names the tool', invalidJson.isError && /^LspRequest failed: params is not valid JSON/.test(invalidJson.text), invalidJson.text)
  const moveSymbol = await door.driveNamed('LspMoveSymbol', { filePath: lib, line: 1, character: 14, targetPath: join(project, 'declaration.ts') })
  check('symbol move previews through its own tool', !moveSymbol.isError && moveSymbol.data?.operation === 'moveSymbol' && /Preview only/.test(moveSymbol.text), moveSymbol.text)
} finally {
  await door.close()
  cleanup(scratch)
}
finish('prove-lsp-write-tools')
