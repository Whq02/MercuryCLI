import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const media = readFileSync(resolve(root, 'docs/MEDIA.md'), 'utf8')
const host = readFileSync(resolve(root, 'docs/LLM-HOST.md'), 'utf8')
const catalogue = JSON.parse(readFileSync(resolve(root, 'src/extensions/bundled/mercury-media/server/catalog.json'), 'utf8'))
const source = catalogue.runtime.platforms['linux-x64'].find((row: { variant: string }) => row.variant === 'cuda12').source
assert.ok(media.includes('## Run on a rented GPU'))
assert.ok(media.includes(source.revision))
assert.ok(media.includes('`media.host`'))
assert.ok(media.includes('`remote`'))
assert.ok(media.includes('Vulkan'))
assert.ok(host.includes('## Images and video on a rented GPU'))
assert.ok(host.includes('(MEDIA.md#run-on-a-rented-gpu)'))
for (const text of [media, host]) assert.doesNotMatch(text, /Docker|OrbStack|hostname|whq|on this machine|blocked|\/Users\/|mercury-handbook/)
console.log('media host docs: setup and host sections, pinned source, saved choice, local results, cross-link and privacy')
