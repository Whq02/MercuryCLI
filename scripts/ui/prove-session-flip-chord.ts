#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('§1 the actions and the default chords')
const { ACTION_GRAPH } = await import('../../src/keybindings/actionGraph.js')
const graph = ACTION_GRAPH as Record<string, { contexts: string[] }>
check('chat:flipSessionForward lives in the Chat context', graph['chat:flipSessionForward']?.contexts.includes('Chat') === true)
check('chat:flipSessionBack lives in the Chat context', graph['chat:flipSessionBack']?.contexts.includes('Chat') === true)
const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.js')
const blocks = DEFAULT_BINDINGS as { context: string; bindings: Record<string, string> }[]
const chat = Object.assign({}, ...blocks.filter(b => b.context === 'Chat').map(b => b.bindings)) as Record<string, string>
check('meta+left → chat:flipSessionBack', chat['meta+left'] === 'chat:flipSessionBack')
check('meta+right → chat:flipSessionForward', chat['meta+right'] === 'chat:flipSessionForward')

console.log('§2 the strip consumes both actions on the click road')
const strip = readFileSync(join(REPO, 'src', 'components', 'mercury-ui', 'SessionTabs.tsx'), 'utf8')
check('both actions ride useKeybinding with the armed condition', /useKeybinding\('chat:flipSessionForward', \(\) => flipTo\(tabList\[0\]\), \{ context: 'Chat', isActive: flipArmed \}\)/.test(strip) && /useKeybinding\('chat:flipSessionBack', \(\) => flipTo\(tabList\[tabList\.length - 1\]\), \{ context: 'Chat', isActive: flipArmed \}\)/.test(strip))
check('armed = the advert\'s own condition (rail painted · empty prompt · a tab to flip to)', strip.includes('const flipArmed = railVisible && promptEmpty && tabList.length > 0'))
check('the flip dispatches the SAME /sessiontab road the clicks ride', /const flipTo = \(log: LogOption \| undefined\): void => \{[^]{0,300}?requestCommandDispatch\(`\/sessiontab \$\{id\}`\)/.test(strip))
check('registered BEFORE the visibility return (hook order)', strip.includes("useKeybinding('chat:flipSessionForward'") && strip.indexOf("useKeybinding('chat:flipSessionForward'") < strip.indexOf('if (!railVisible) return null'))

console.log('§3 the advert is honest')
check('the chord is named only with tabs to flip to', strip.includes("promptEmpty && tabList.length > 0") && /promptEmpty && tabList\.length > 0\s*\?[^]{0,400}?`   \$\{keyHintLabel\('⌥←→'\)\} flip · \/sessions`/.test(strip))
check("POISON: the bare promptEmpty advert (the dead-chord spelling) is gone", !/promptEmpty\s*\?\s*`   \$\{keyHintLabel\('⌥←→'\)\} flip · \/sessions`/.test(strip) && !/promptEmpty\s*\?\s*'   ⌥←→ flip · \/sessions'/.test(strip))

console.log(failures === 0 ? '\nsession flip chord: GREEN' : `\nsession flip chord: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
