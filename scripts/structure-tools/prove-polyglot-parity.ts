import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { check, finish } from '../ast-tools/lib/harness.ts'

const repoRoot = join(import.meta.dir, '..', '..')
const PROBE = `
const { StructureTool } = await import('./src/tools/StructureTool/StructureTool.ts')
const { getAllBaseTools } = await import('./src/tools.ts')
const schema = StructureTool.inputSchema
const keys = Object.keys(schema.shape)
const actions = schema.shape.action.unwrap().options
const prompt = await StructureTool.prompt({ getToolPermissionContext: () => ({}) })
console.log(JSON.stringify({ keys, actions, prompt, hint: StructureTool.searchHint, tools: getAllBaseTools().map(t => t.name) }))
`
function probe(env: Record<string, string>) {
  return JSON.parse(execFileSync(process.execPath, ['-e', PROBE], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...env } }).trim().split('\n').at(-1)!) as { keys: string[]; actions: string[]; prompt: string; hint: string; tools: string[] }
}
for (const [label, env, ast, structure] of [
  ['ON', { MERCURY_STRUCTURE: '1', MERCURY_STRUCTURE_POLYGLOT: '1' }, true, true],
  ['OFF', { MERCURY_STRUCTURE: '1', MERCURY_STRUCTURE_POLYGLOT: '0' }, false, true],
  ['MASTER OFF', { MERCURY_STRUCTURE: '0', MERCURY_STRUCTURE_POLYGLOT: '1' }, false, false],
] as const) {
  const result = probe(env)
  check(`${label}: Structure has only the 18 select fields`, result.keys.length === 18 && ['pattern', 'lang', 'out'].every(field => !result.keys.includes(field)))
  check(`${label}: no rewrite action`, result.actions.length === 8 && !result.actions.includes('rewrite'))
  check(`${label}: Structure discovery never advertises a duplicate lane`, !/pattern lane|metavariable|SYMBOL ADDRESSING|POLYGLOT/.test(result.prompt + result.hint))
  check(`${label}: AstSearch and AstEdit follow the polyglot and master gates`, ['AstSearch', 'AstEdit'].every(name => result.tools.includes(name) === ast))
  check(`${label}: Structure follows only its master gate`, result.tools.includes('Structure') === structure)
  check(`${label}: descriptions name Ast tools only while they are offered`, /AstSearch/.test(result.prompt) === ast && /AstEdit/.test(result.prompt) === ast)
}
finish('POLYGLOT PARITY')
