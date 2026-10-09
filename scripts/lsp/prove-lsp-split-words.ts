import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { armScratch, check, cleanup, FAKE_SERVER, finish, fixtureServer, openToolDoor, REPO, TS_PROBE_FILES, writeProject } from './lspProofDoor.ts'

const scratch = armScratch('lsp-split-words')
const project = writeProject(scratch, 'project', TS_PROBE_FILES)
const available = await import('../../src/tools/LSPTool/LSPTool.ts')
if (!('LSP_TOOLS' in available)) {
  check('the harness teaches the seven language-service tool names', false)
  cleanup(scratch)
  finish('prove-lsp-split-words')
}
process.env.MERCURY_LSP_SERVERS = JSON.stringify(fixtureServer('fixture', FAKE_SERVER, {}, '.fk', 'fake'))
const door = await openToolDoor(project)
try {
  const { getRunProtocolSection } = await import('../../src/utils/cockpit/runProtocol.ts')
  const { computeHarnessMapLines } = await import('../../src/utils/cockpit/harnessMap.ts')
  const { isReadOnlyAllowlistedTool } = await import('../../src/utils/permissions/readOnlyAllowlist.ts')
  const { evaluateWards, BUILTIN_WARDS } = await import('../../src/utils/wards/wards.ts')
  const { remedyForLanguageServer } = await import('../../src/services/lsp/failureWords.ts')
  const readTool = available.LSP_TOOLS.find(tool => tool.name === 'LspRead')
  const renameTool = available.LSP_TOOLS.find(tool => tool.name === 'LspRename')
  const readText = (await readTool?.prompt?.({} as never)) ?? ''
  const renameText = (await renameTool?.prompt?.({} as never)) ?? ''
  check('the read tool owns the IDE-evidence facts: definitions and references over text search, diagnostics on files just edited', readText.includes('Use this over Grep and Read for definitions and references') && readText.includes('Run it on files you just edited'))
  check('the rename tool owns the structured-rename fact', renameText.includes('Rename a symbol everywhere the language server sees it'))
  const protocol = getRunProtocolSection({ lspMounted: true, dapMounted: false }) ?? ''
  check('the run protocol repeats none of it (no IDE-loop paragraph, no "LSP tool")', !protocol.includes('IDE loop') && !protocol.includes('LspRead') && !protocol.includes('LSP tool'))
  const map = computeHarnessMapLines().join('\n')
  check('the harness map repeats none of it (the roster lists the tools)', !map.includes('Code intelligence is native'))
  for (const tool of available.LSP_TOOLS) {
    check(`${tool.name}: only the read tool belongs to the flow read-only allowlist`, isReadOnlyAllowlistedTool(tool.name) === (tool.name === 'LspRead'))
    const generated = '/work/project/scripts/builtin-tools/fixtures/tool-census.json'
    const writeTool = !['LspRead', 'LspRequest'].includes(tool.name)
    const input = { filePath: generated, targetPath: generated, newPath: generated, apply: true }
    const verdict = evaluateWards(BUILTIN_WARDS, { toolName: tool.name, input, resolvePath: path => ({ path, root: '/work/project' }) })
    check(`${tool.name}: apply target wards follow the writer`, verdict.allow === !writeTool)
    const preview = evaluateWards(BUILTIN_WARDS, { toolName: tool.name, input: { ...input, apply: false }, resolvePath: path => ({ path, root: '/work/project' }) })
    check(`${tool.name}: preview does not acquire edit targets`, preview.allow)
  }
  const remedy = remedyForLanguageServer({ name: 'fixture', config: { extensionToLanguage: { '.ts': 'typescript' } } } as never, join(project, 'lib.ts'), 'busy', project)
  check('the remedy names LspRead serverStatus', remedy === "check the files with npm run typecheck; LspRead serverStatus shows the server's state", remedy)
  const ops = readFileSync(join(REPO, 'src/tools/LSPTool/mercuryOps.ts'), 'utf8')
  check('all four transaction refusals are explicitly excluded from fault counting', (ops.match(/applyRefusal: true/g) ?? []).length === 4)
  process.env.MERCURY_LSP = '0'
  for (const tool of available.LSP_TOOLS.filter(tool => tool.name !== 'LspRead')) {
    const permission = await tool.checkPermissions({ filePath: join(project, 'lib.ts'), apply: true }, door.prover.ctx as never)
    check(`${tool.name}: a frozen tool cannot write after the live flag is off`, permission.behavior === 'deny')
  }
  const stopped = await available.LspRenameTool.call({ filePath: join(project, 'lib.ts'), line: 1, character: 14, newName: 'spend' }, door.prover.ctx as never)
  check('the call backstop refuses the disabled bridge before server work', stopped.effect?.outcome === 'failed' && /MERCURY_LSP is off/.test(stopped.data.result))
  const { getAllBaseTools } = await import('../../src/tools.ts')
  check('the master flag withholds all seven tools and the doctrine', !getAllBaseTools().some(tool => available.LSP_TOOLS.some(lsp => lsp.name === tool.name)) && getLspDoctrineLine() === null && getLspPackEvidenceText() === null)
} finally {
  await door.close()
  cleanup(scratch)
}
finish('prove-lsp-split-words')
