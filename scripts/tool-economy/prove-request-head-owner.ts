#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import { FORBIDDEN_PROVIDER_WORDS, requestHeadIsPlain, requestHeadSource } from './requestHeadSource.ts'

const t = checker()
const ROOT = join(import.meta.dir, '..', '..')
const providerRoot = join(ROOT, 'src/services/providers')
const files = [...new Bun.Glob('**/*.{ts,tsx}').scanSync(providerRoot)].sort()
const hits = files.flatMap(file => {
  const source = readFileSync(join(providerRoot, file), 'utf8')
  return FORBIDDEN_PROVIDER_WORDS.filter(word => source.toLowerCase().includes(word.toLowerCase())).map(word => `${file}: ${word}`)
})
t.check('every provider source is scanned', files.length > 100)
t.check('no provider retains a retired head word or field', hits.length === 0, hits.join('\n'))
for (const route of ['anthropic', 'openai', 'zai', 'openai-compat', 'local']) {
  const source = requestHeadSource(route)
  t.check(`${route}: the request uses only normalization or the admission-record projection`, requestHeadIsPlain(route, source))
  const variable = route === 'anthropic' ? 'messagesForAPI' : 'wireMessages'
  t.check(`${route}: a synthetic head cannot pass the source pin`, !requestHeadIsPlain(route, source.replace(`let ${variable} =`, `let ${variable} = [newHead, ...oldMessages]; let other =`).replace(`const ${variable} =`, `const ${variable} = [newHead, ...oldMessages]; const other =`)))
  t.check(`${route}: a later prepend cannot pass the source pin`, !requestHeadIsPlain(route, `${source}\n${variable}.unshift(newHead)`))
}
const local = readFileSync(join(providerRoot, 'local/localCallModel.ts'), 'utf8')
t.check('the local estimate weighs schema bytes without another tool-head term', local.includes('Math.ceil(wire.schemaBytes / LOCAL_WIRE_BYTES_PER_TOKEN)'))
t.check('the local request delegates to the shared message owner', /compatChatCallModel\(/.test(local))
t.finish('prove-request-head-owner')
