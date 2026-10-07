import { join } from 'node:path'
import { symlinkSync } from 'node:fs'
import { armScratch, check, cleanup, finish, openToolDoor, REPO, TS_PROBE_FILES, TS_SIDECAR_ENTRY, writeProject } from './lspProofDoor.ts'

const scratch = armScratch('lsp-advertised-keys')
process.env.MERCURY_LSP_SIDECAR_ENTRY = TS_SIDECAR_ENTRY
const project = writeProject(scratch, 'project', TS_PROBE_FILES)
symlinkSync(join(REPO, 'node_modules'), join(project, 'node_modules'), 'dir')
const door = await openToolDoor(project)
const { LSP_INPUT_JSON_SCHEMAS, readArguments } = await import('../../src/tools/LSPTool/schemas.ts')
const { LSP_DESCRIPTIONS } = await import('../../src/tools/LSPTool/prompt.ts')
const here = join(project, 'lib.ts')
const samples: Record<string, unknown> = { filePath: here, line: 1, character: 1, query: 'budget', limit: 50, newName: 'spend', newPath: join(project, 'moved.ts'), apply: false, actionId: 'ca-12345678', actionIndex: 0, endLine: 1, endCharacter: 2, paths: [here], plan: 'lsp-0000', kind: 'quickfix', targetPath: join(project, 'target.ts'), method: 'textDocument/hover', params: '{}', organizeImports: false }
try {
  for (const tool of door.tools) {
    const wire = tool.inputJSONSchema as { type: string; properties: Record<string, { description?: string }>; required: string[] }
    check(`${tool.name}: the advertised schema is one object`, wire.type === 'object')
    const keys = Object.keys(wire.properties)
    check(`${tool.name}: every field has an independent sample`, keys.every(key => key === 'operation' || key in samples))
    if (tool.name === 'LspRead') {
      for (const operation of LSP_INPUT_JSON_SCHEMAS.LspRead.properties.operation.enum) {
        const input = { ...Object.fromEntries(keys.filter(key => key !== 'operation').map(key => [key, samples[key]])), operation }
        check(`${operation}: every advertised read key parses`, tool.inputSchema.safeParse(input).success)
        const verdict = await tool.validateInput!(input, door.prover.ctx as never)
        check(`${operation}: advertised read keys validate`, verdict.result, verdict.result ? '' : verdict.message)
        const own = readArguments(input)
        if (!['workspaceSymbol', 'diagnostics'].includes(operation)) check(`${operation}: unused workspace arguments are dropped`, !('query' in own) && !('limit' in own) && !('paths' in own))
      }
    } else {
      const input = Object.fromEntries(keys.map(key => [key, samples[key]]))
      check(`${tool.name}: every advertised field parses`, tool.inputSchema.safeParse(input).success)
      for (const key of wire.required) {
        const without = { ...input }
        delete without[key]
        check(`${tool.name}: required ${key} is enforced`, !tool.inputSchema.safeParse(without).success)
      }
    }
    check(`${tool.name}: genuinely unknown fields are refused`, !tool.inputSchema.safeParse({ ...Object.fromEntries(wire.required.map(key => [key, key === 'operation' ? 'serverStatus' : samples[key]])), frobnicate: true }).success)
    check(`${tool.name}: the prompt names no legacy selector`, !/legacy/i.test(LSP_DESCRIPTIONS[tool.name as keyof typeof LSP_DESCRIPTIONS]))
  }
  const opsSource = await Bun.file(join(REPO, 'src/tools/LSPTool/mercuryOps.ts')).text()
  check('the codeActions re-run hint keeps its positional-selector words', /actionIndex is the positional selector from this listing/.test(opsSource) && !/legacy positional/.test(opsSource))
  const actionIndex = LSP_INPUT_JSON_SCHEMAS.LspCodeAction.properties.actionIndex.description
  check('actionIndex remains positional and actionId remains preferred', actionIndex.includes('positional selector from a prior listing') && actionIndex.includes('actionId is preferred'))
  const air = { operation: 'diagnostics', paths: [here, join(project, 'main.ts')], line: 1, character: 1, query: 'unused', limit: 50 }
  const answer = await door.drive(air)
  check('the filled read schema answers the reported multi-file diagnostic case', !answer.isError && /2322/.test(answer.text) && /2 of 2 file\(s\) checked/.test(answer.text), answer.text)
  check('unused positions are not echoed as a filePath', answer.data?.filePath === '')
  const again = await door.drive(air)
  check('the same filled read shape answers again without an argument retry', !again.isError && /2322/.test(again.text), again.text)
  const unknown = await door.drive({ ...air, frobnicate: true })
  check('the door names the unknown field before server work', unknown.isError && /frobnicate/.test(unknown.text), unknown.text)
  const missing = await door.drive({ operation: 'diagnostics' })
  check('the conditional required paths/filePath remain enforced', missing.isError && /neither was given/.test(missing.text), missing.text)
  const noName = await door.driveNamed('LspRename', { filePath: here, line: 1, character: 14 })
  check('rename without newName remains refused', noName.isError && /newName/.test(noName.text), noName.text)
} finally {
  await door.close()
  cleanup(scratch)
}
finish('prove-lsp-advertised-keys')
