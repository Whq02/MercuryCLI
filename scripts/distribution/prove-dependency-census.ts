#!/usr/bin/env bun
// gate-class: pure
// gate-watch: package.json scripts/distribution/dependency-census.tsv
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const CLASSES = ['library', 'tool', 'protocol-sdk', 'vendor-platform', 'vendor-model-sdk'] as const
type Class = (typeof CLASSES)[number]

const VENDOR_MODEL_SDK_RATCHET: readonly string[] = []
const VENDOR_PLATFORM_RATCHET: readonly string[] = []
const VENDOR_NAME_MARKS: readonly RegExp[] = [
  /^@anthropic-ai\//,
  /^openai$/,
  /^@openai\//,
  /^@google\/gen(erative-)?ai$/,
  /^@google-cloud\/vertexai$/,
  /^@aws-sdk\/client-bedrock/,
  /^@mistralai\//,
  /^cohere-ai$/,
  /^@cohere-ai\//,
  /^groq-sdk$/,
  /^@cerebras\//,
  /^together-ai$/,
  /^@xai-org\//,
  /^@deepseek\//,
  /^ollama$/,
  /^@huggingface\/inference$/,
]

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log(`\n${'─'.repeat(76)}\n${t}`)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
const deps = Object.keys(pkg.dependencies ?? {}).sort()
const rows = readFileSync(join(ROOT, 'scripts', 'distribution', 'dependency-census.tsv'), 'utf8')
  .split('\n')
  .filter(line => line.trim() !== '' && !line.startsWith('#'))
  .slice(1)
  .map(line => line.split('\t'))
  .map(([name, cls, purpose]) => ({ name: name ?? '', cls: (cls ?? '') as Class, purpose: purpose ?? '' }))
const byName = new Map(rows.map(row => [row.name, row]))

section('§1 every runtime dependency has a row, every row names a dependency, every row is complete')
{
  const missing = deps.filter(name => !byName.has(name))
  check('every dependency in package.json has a census row', missing.length === 0, `add a row for: ${missing.join(', ')}`)
  const stale = rows.filter(row => !deps.includes(row.name)).map(row => row.name)
  check('no census row names a dependency that is gone', stale.length === 0, `remove the row for: ${stale.join(', ')}`)
  const badClass = rows.filter(row => !CLASSES.includes(row.cls)).map(row => `${row.name}:${row.cls}`)
  check(`every class is one of ${CLASSES.join(' · ')}`, badClass.length === 0, badClass.join(', '))
  const thin = rows.filter(row => row.purpose.trim().length < 4).map(row => row.name)
  check('every row says what the package is for', thin.length === 0, thin.join(', '))
  const dupes = rows.map(row => row.name).filter((name, i, all) => all.indexOf(name) !== i)
  check('no package has two rows', dupes.length === 0, dupes.join(', '))
}

section('§2 the vendor classes are a ratchet: they only shrink, and a model vendor\'s SDK never enters under another class')
{
  const modelSdks = rows.filter(row => row.cls === 'vendor-model-sdk').map(row => row.name)
  const newModelSdk = modelSdks.filter(name => !VENDOR_MODEL_SDK_RATCHET.includes(name))
  check('no vendor model SDK beyond the ratchet list', newModelSdk.length === 0, `a model vendor's SDK entered the product: ${newModelSdk.join(', ')}`)
  const platforms = rows.filter(row => row.cls === 'vendor-platform').map(row => row.name)
  const newPlatform = platforms.filter(name => !VENDOR_PLATFORM_RATCHET.includes(name))
  check('no vendor platform package beyond the ratchet list', newPlatform.length === 0, newPlatform.join(', '))
  const looseRatchet = [...VENDOR_MODEL_SDK_RATCHET, ...VENDOR_PLATFORM_RATCHET].filter(name => !deps.includes(name))
  check('a ratchet entry whose package has left the tree is struck from the ratchet (it only shrinks)', looseRatchet.length === 0, `strike from the ratchet: ${looseRatchet.join(', ')}`)
  const marked = deps.filter(name => VENDOR_NAME_MARKS.some(mark => mark.test(name)))
  const misclassed = marked.filter(name => {
    const cls = byName.get(name)?.cls
    return cls !== 'vendor-model-sdk' && cls !== 'vendor-platform'
  })
  check('every dependency carrying a model vendor\'s name is classed as the vendor\'s, never as a library', misclassed.length === 0, misclassed.join(', '))
  const leaving = rows.filter(row => row.cls === 'vendor-model-sdk' || row.cls === 'vendor-platform').filter(row => !/leaving: lane /.test(row.purpose)).map(row => row.name)
  check('every vendor row names the lane that removes it', leaving.length === 0, leaving.join(', '))
  console.log(`  vendor model SDKs: ${modelSdks.length === 0 ? 'none' : modelSdks.join(', ')} · vendor platform packages: ${platforms.length === 0 ? 'none' : platforms.join(', ')} · ${deps.length} runtime dependencies classed`)
}

console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ prove-dependency-census: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-dependency-census: every runtime dependency is named, classed and explained; the vendor classes only shrink')
