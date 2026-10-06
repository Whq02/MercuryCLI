#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

console.log('§1 the registry carries no flip action and no default chord for it')
const { ACTION_GRAPH } = await import('../../src/keybindings/actionGraph.js')
const graph = ACTION_GRAPH as Record<string, { contexts: string[] }>
check('no chat:flipSession* action stands in the graph', !Object.keys(graph).some(name => name.startsWith('chat:flipSession')), Object.keys(graph).filter(name => name.startsWith('chat:flipSession')).join(', '))
const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.js')
const blocks = DEFAULT_BINDINGS as { context: string; bindings: Record<string, string> }[]
const chat = Object.assign({}, ...blocks.filter(b => b.context === 'Chat').map(b => b.bindings)) as Record<string, string>
check('the Chat defaults bind neither meta+left nor meta+right', chat['meta+left'] === undefined && chat['meta+right'] === undefined, `${chat['meta+left'] ?? ''} ${chat['meta+right'] ?? ''}`)
check('no module under src registers a flip keybinding', !read('src/components/PromptInput/useComposerRawKeys.ts').includes("useKeybinding('chat:flipSession") && !existsSync(join(REPO, 'src/components/mercury-ui/SessionTabs.tsx')))

console.log('§2 the chord has one road: the composer, on an empty plain prompt')
const composer = read('src/components/PromptInput/useComposerRawKeys.ts')
check('⌥←/→ on an empty plain prompt is handled by the composer itself', /emptyPlainPrompt &&\s*key\.meta &&\s*!key\.ctrl &&\s*\(key\.leftArrow \|\| key\.rightArrow\)/.test(composer))
check('the handler stops the key there (no second road may fire)', /\(key\.leftArrow \|\| key\.rightArrow\)\s*\)\s*\{\s*event\.stopImmediatePropagation\(\)/.test(composer))

console.log('§3 no standing advert of the chord')
const srcFiles: string[] = []
for await (const p of new Bun.Glob('src/**/*.{ts,tsx}').scan(REPO)) srcFiles.push(p)
const adverts = srcFiles.filter(p => /⌥←→ flip|flip · \/sessions/.test(read(p)))
check('no screen advertises "⌥←→ flip" (the strip that named it is gone)', adverts.length === 0, adverts.join(', '))

console.log(failures === 0 ? '\nsession flip chord: GREEN' : `\nsession flip chord: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
