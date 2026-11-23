import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import catalogue from '../../src/integrations/extensions/bundled/mercury-media/server/catalog.json' with { type: 'json' }

const root = fileURLToPath(new URL('../..', import.meta.url))
const media = readFileSync(resolve(root, 'docs/MEDIA.md'), 'utf8')
const host = readFileSync(resolve(root, 'docs/LLM-HOST.md'), 'utf8')
const source = catalogue.runtime.platforms['linux-x64'].find((row: { variant: string }) => row.variant === 'cuda12')!.source
assert.ok(media.includes(source.revision), `docs/MEDIA.md missing pinned cuda12 source revision ${source.revision}; check docs/MEDIA.md against catalog.json`)
for (const text of [media, host]) assert.doesNotMatch(text, new RegExp(['Doc'+'ker', 'Orb'+'Stack', ['host', 'name'].join(''), 'w'+'hq', 'on this'+' machine', 'blo'+'cked', '\\/Users\\/', 'mercury-'+'handbook'].join('|')))
console.log('media host docs: setup and host sections, pinned source, saved choice, local results, cross-link and privacy')
