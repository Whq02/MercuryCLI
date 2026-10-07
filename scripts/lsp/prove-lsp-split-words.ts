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
  const { getLspDoctrineLine, getLspPackEvidenceText } = await import('../../src/services/lsp/mercuryLsp.ts')
  const { getRunProtocolSection } = await import('../../src/utils/cockpit/runProtocol.ts')
  const { computeHarnessMapLines } = await import('../../src/utils/cockpit/harnessMap.ts')
  const { isReadOnlyAllowlistedTool } = await import('../../src/utils/permissions/readOnlyAllowlist.ts')
  const { evaluateWards, BUILTIN_WARDS } = await import('../../src/utils/wards/wards.ts')
  const { remedyForLanguageServer } = await import('../../src/services/lsp/failureWords.ts')
  const doctrine = "<ide-evidence>When LspRead is available, edit with IDE evidence instead of guesses: LspRead goToDefinition/findReferences before changing a shared symbol, LspRead diagnostics on files you just edited before calling them done, and LspRename (preview, then apply) instead of hand-editing call sites across files.</ide-evidence>"
  check('the exact IDE-evidence doctrine names the read and rename tools', getLspDoctrineLine() === doctrine)
  check('the pack variant teaches those same tools', /LspRead diagnostics/.test(getLspPackEvidenceText() ?? '') && /LspRename/.test(getLspPackEvidenceText() ?? ''))
  const guidance = 'prefer LspRead for symbol discovery and references, LspRename for a structured rename and LspCodeAction for offered fixes; use direct file edits for small local changes where that is clearer. After a code mutation, get current diagnostics (LspRead diagnostics) when a language server covers the file, then run the smallest real proof that covers the changed behavior.'
  const protocol = getRunProtocolSection({ lspMounted: true, dapMounted: false }) ?? ''
  check('the run protocol carries the exact new guidance', protocol.includes(guidance) && protocol.includes('An Lsp tool or Debug operation') && !protocol.includes('LSP tool'))
  const map = computeHarnessMapLines().join('\n')
  check('the harness map names the loaded read tool and deferred refactors', map.includes('LspRead (diagnostics, definitions, references) and, loaded with ToolSearch, LspRename, LspMoveSymbol, LspMoveFile, LspCodeAction and LspFormat'))
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
