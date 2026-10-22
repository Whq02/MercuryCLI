import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
const root = resolve(import.meta.dir, '../..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')
const harbor = read('bench/harbor/README.md')
const installer = read('bench/harbor/mercury_harbor/install.sh')
assert.ok(installer.includes('target="linux-arm64"') && installer.includes('target="linux-x64"'))
assert.ok(!harbor.includes('ships only a Linux x86-64 archive'), 'the Harbor guide must not call a dual-architecture installer x64-only')
assert.ok(harbor.includes('x86-64 and arm64') && harbor.includes('linux/amd64'), 'the guide distinguishes supported releases from its selected task architecture')
assert.ok(!harbor.includes('No real key was available for this lane'), 'public cost guidance does not expose an internal work assignment')
for (const file of ['sdk/README.md', 'sdk-py/README.md']) {
  const text = read(file)
  assert.ok(!/\bdoors?\b/.test(text), file + ' names its APIs or interfaces rather than internal terminology')
  assert.ok(text.includes('Apache License 2.0') && text.includes('Business Source License 1.1'), file + ' retains the distinct SDK and CLI licences')
}
const node = JSON.parse(read('vendor/node.lock.json')) as { version: string; platforms: Record<string, { url: string; sha256: string }>; notes: string }
assert.equal(node.version, read('.node-version').trim())
assert.ok(node.platforms['linux-arm64'] && node.platforms['linux-x64'])
assert.ok(Object.values(node.platforms).every(pack => pack.url.includes('/v' + node.version + '/') && /^[a-f0-9]{64}$/.test(pack.sha256)))
assert.ok(!node.notes.includes('rewrite the five archive names'), 'runtime update instructions cover every platform in the lock')
console.log('PUBLIC HOSTING WORDS GREEN — platform guidance, SDK terminology, licence separation and runtime-lock instructions agree')
