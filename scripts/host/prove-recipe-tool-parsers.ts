import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
delete process.env.MERCURY_HOME
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const shipped = JSON.parse(readFileSync(join(import.meta.dir, '../../assets/host/recipes.json'), 'utf8')) as { recipes: { id: string; engine?: string; model: string; image: string; flags: string[] }[] }

let checks = 0
const check = (name: string, truth: unknown, detail = ''): void => { assert.ok(truth, name + (detail ? ': ' + detail : '')); checks++; console.log('PASS ' + name) }
const parserOf = (flags: readonly string[]): string | undefined => { const at = flags.indexOf('--tool-call-parser'); return at >= 0 ? flags[at + 1] : undefined }

for (const [source, rows] of [['src/services/host/recipes.ts', HOST_RECIPES], ['assets/host/recipes.json', shipped.recipes]] as const) {
  const vllm = rows.filter(row => row.engine === 'vllm')
  check(source + ' carries vLLM recipes to check', vllm.length >= 3, String(vllm.length))
  for (const row of vllm) {
    const parser = parserOf(row.flags)
    check(source + ' · ' + row.id + ' declares a tool-call parser and auto tool choice', parser !== undefined && parser !== '' && !parser.startsWith('--') && row.flags.includes('--enable-auto-tool-choice'), JSON.stringify(row.flags))
  }
  const gptOss = vllm.filter(row => row.model === 'openai/gpt-oss-120b')
  check(source + ' · both gpt-oss-120b shapes parse tool calls with the openai parser', gptOss.length === 2 && gptOss.every(row => parserOf(row.flags) === 'openai'), gptOss.map(row => row.id + ':' + parserOf(row.flags)).join(','))
  check(source + ' · the gpt-oss-120b shapes keep prefix caching on', gptOss.every(row => row.flags.includes('--enable-prefix-caching')))
}
console.log('RECIPE TOOL PARSERS GREEN — ' + checks + ' checks; the shipped source and the exported file, no network')
