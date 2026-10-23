import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { registerGeneratedAsset, registerOnlyRequested } from '../lib/generated-assets-map.mjs'
import { LLAMACPP_ENGINE_SHA } from '../../src/services/host/recipes.ts'

const root = resolve(import.meta.dir, '../..')
const ASSET = 'assets/host/llamacpp-engine.json'
const DOCKERFILE = 'scripts/host/Dockerfile.llamacpp'
const WORKFLOW = '.github/workflows/engine-image.yml'
const ROW = {
  assets: ASSET,
  generator: 'bun scripts/host/export-llamacpp-engine.ts',
  check: 'bun scripts/host/export-llamacpp-engine.ts --check',
  sources: 'src/services/host/recipes.ts ' + DOCKERFILE + ' ' + WORKFLOW + ' scripts/host/export-llamacpp-engine.ts',
}
if (registerOnlyRequested(ROW)) process.exit(0)

interface EngineTableFile { generatedBy: string; llamacpp: string; source: string; sourceSha256: string; architectures: string[]; tensors: string[] }

const shaArgument = (): string => { const at = process.argv.indexOf('--sha'); return at >= 0 && process.argv[at + 1] ? process.argv[at + 1]! : LLAMACPP_ENGINE_SHA }
const sourceUrl = (sha: string): string => 'https://raw.githubusercontent.com/ggml-org/llama.cpp/' + sha + '/src/llama-arch.cpp'

function engineTableFromSource(source: string, sha: string): EngineTableFile {
  const architectures = [...source.matchAll(/\{\s*LLM_ARCH_([A-Z0-9_]+),\s*"([^"]+)"\s*\}/g)].filter(match => match[1] !== 'UNKNOWN').map(match => match[2]!)
  const tensors = [...source.matchAll(/\{\s*LLM_TENSOR_[A-Z0-9_]+,\s*"([^"]+)"\s*\}/g)].map(match => match[1]!.replaceAll('%d', 'N'))
  if (architectures.length < 50 || tensors.length < 100) throw new Error('llama-arch.cpp at ' + sha + ' yielded ' + architectures.length + ' architectures and ' + tensors.length + ' tensor names; the source shape changed')
  return { generatedBy: 'scripts/host/export-llamacpp-engine.ts', llamacpp: sha, source: 'https://github.com/ggml-org/llama.cpp/blob/' + sha + '/src/llama-arch.cpp', sourceSha256: createHash('sha256').update(source).digest('hex'), architectures: [...new Set(architectures)].sort(), tensors: [...new Set(tensors)].sort() }
}

function pinsOf(): { dockerfile: string | undefined; workflowDefault: string | undefined; workflowFallback: string | undefined } {
  const dockerfile = readFileSync(resolve(root, DOCKERFILE), 'utf8')
  const workflow = readFileSync(resolve(root, WORKFLOW), 'utf8')
  return {
    dockerfile: /^ARG LLAMA_CPP_SHA=([0-9a-f]{40})$/m.exec(dockerfile)?.[1],
    workflowDefault: /^\s+default: ([0-9a-f]{40})$/m.exec(workflow)?.[1],
    workflowFallback: /inputs\.upstream_sha \|\| '([0-9a-f]{40})'/.exec(workflow)?.[1],
  }
}

function check(): void {
  const asset = JSON.parse(readFileSync(resolve(root, ASSET), 'utf8')) as EngineTableFile
  const problems: string[] = []
  if (asset.llamacpp !== LLAMACPP_ENGINE_SHA) problems.push('the table was generated at llama.cpp ' + asset.llamacpp + ' but recipes.ts pins ' + LLAMACPP_ENGINE_SHA)
  const pins = pinsOf()
  for (const [name, value] of Object.entries(pins)) if (value !== LLAMACPP_ENGINE_SHA) problems.push(name + ' pins ' + value + ' while recipes.ts pins ' + LLAMACPP_ENGINE_SHA)
  if (!Array.isArray(asset.architectures) || asset.architectures.length < 50 || !Array.isArray(asset.tensors) || asset.tensors.length < 100) problems.push('the table is too small to be llama-arch.cpp')
  if (!/^[0-9a-f]{64}$/.test(asset.sourceSha256)) problems.push('the table carries no source digest')
  if (problems.length) { for (const problem of problems) console.error('llamacpp-engine: ' + problem); process.exit(1) }
  console.log('llamacpp-engine: ' + ASSET + ' is current for llama.cpp ' + asset.llamacpp + ' (' + asset.architectures.length + ' architectures, ' + asset.tensors.length + ' tensor names)')
}

if (import.meta.main) {
  if (process.argv.includes('--check')) check()
  else {
    const sha = shaArgument()
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('--sha wants a full llama.cpp commit')
    const response = await fetch(sourceUrl(sha))
    if (!response.ok) throw new Error('GitHub answered HTTP ' + response.status + ' for ' + sourceUrl(sha))
    const table = engineTableFromSource(await response.text(), sha)
    const target = resolve(root, ASSET)
    writeFileSync(target, JSON.stringify(table, null, 2) + '\n')
    registerGeneratedAsset(ROW)
    console.log('llamacpp-engine: wrote ' + ASSET + ' for llama.cpp ' + sha + ' (' + table.architectures.length + ' architectures, ' + table.tensors.length + ' tensor names)')
    if (sha !== LLAMACPP_ENGINE_SHA) console.error('llamacpp-engine: recipes.ts still pins ' + LLAMACPP_ENGINE_SHA + '; the check stays red until it names ' + sha)
  }
}
