import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const FACILITY = 'src/services/structure/tsFacility.ts'

const VALUE_LOADS = [
  /\brequire\(\s*['"]typescript['"]\s*\)/,
  /(?<!typeof\s)\bimport\(\s*['"]typescript['"]\s*\)(?!\s*\.)/,
  /^\s*import\s+(?!type\b)[^;\n]*?\bfrom\s+['"]typescript['"]/m,
]

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* sourceFiles(path)
    else if (/\.tsx?$/.test(entry.name)) yield path
  }
}

const offenders: string[] = []
let scanned = 0
for (const file of sourceFiles(SRC)) {
  const rel = relative(ROOT, file)
  if (rel === FACILITY) continue
  scanned++
  const text = readFileSync(file, 'utf8')
  for (const pattern of VALUE_LOADS) {
    const hit = text.match(pattern)
    if (hit === null) continue
    const line = text.slice(0, hit.index).split('\n').length
    offenders.push(`${rel}:${line}: ${hit[0].trim()}`)
  }
}

assert.ok(scanned > 100, `scanned ${scanned} source files`)
assert.deepEqual(
  offenders,
  [],
  `the typescript compiler is loaded through ${FACILITY} alone (resolveStructureTypescript + loadTs: workspace copy, else the vendored copy beside the bundle, else named unavailable); a bare require or import of the package makes the bundler inline the nine-megabyte compiler into mercury.mjs:\n  ${offenders.join('\n  ')}`,
)
console.log(`PASS compiler facility: ${scanned} source files load the typescript package through ${FACILITY} alone`)
