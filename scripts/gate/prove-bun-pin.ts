import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const pin = readFileSync(join(root, '.bun-version'), 'utf8').trim()
assert.match(pin, /^\d+\.\d+\.\d+$/)
const workflows = join(root, '.github/workflows')
let gatePins = 0
let pins = 0
for (const file of readdirSync(workflows).filter(file => /\.ya?ml$/.test(file))) {
  const source = readFileSync(join(workflows, file), 'utf8')
  const versions = [...source.matchAll(/^\s*bun-version:\s*([^\s#]+)\s*(?:#.*)?$/gm)]
  if (source.includes('oven-sh/setup-bun@')) assert.ok(versions.length > 0, `${file} must pin Bun`)
  for (const [, version] of versions) {
    assert.equal(version?.replace(/^['"]|['"]$/g, ''), pin, `${file} disagrees with .bun-version`)
    pins++
    if (file === 'gate.yml') gatePins++
  }
}
assert.ok(gatePins > 0, 'the gate must pin Bun')
console.log(`PASS .bun-version ${pin} agrees with all ${pins} workflow pins (${gatePins} gate pins)`)
