#!/usr/bin/env bun
// ============================================================================
//  prove-session-flip-chord — the ⊞ SESSIONS strip's ⌥←→ flip is REAL
// (the find: the strip advertised "⌥←→ flip", the
//  action graph's surface-cycle comment called ⌥←/→ "the session tab-flip",
//  and neither a binding nor a handler existed anywhere — a fully
//  advertised dead chord; a driven ⌥← did nothing).
//
//  §1 the actions live in the graph (Chat context) and the default Chat
//     bindings carry meta+left/meta+right. §2 SessionTabs consumes BOTH
//     actions through useKeybinding, armed exactly as advertised (empty
//     prompt + a tab), dispatching the SAME `/sessiontab <id>` road the
//     clicks ride. §3 the advert names the chord ONLY while it can fire
//     (no tabs ⇒ /sessions alone — a printed key that does not fire is a
// lie). Driven green on the built bundle by drive 10
//     (release → tab → ⌥← → "resumed clean" → a new turn).
// ============================================================================
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
// The advert spelling folds through keyHintLabel (the
// platform-true hint); the LAW is unchanged — the chord is named only with
// tabs to flip to, and the dead-chord bare-promptEmpty advert stays gone.
check('the chord is named only with tabs to flip to', strip.includes("promptEmpty && tabList.length > 0") && /promptEmpty && tabList\.length > 0\s*\?[^]{0,400}?`   \$\{keyHintLabel\('⌥←→'\)\} flip · \/sessions`/.test(strip))
check("POISON: the bare promptEmpty advert (the dead-chord spelling) is gone", !/promptEmpty\s*\?\s*`   \$\{keyHintLabel\('⌥←→'\)\} flip · \/sessions`/.test(strip) && !/promptEmpty\s*\?\s*'   ⌥←→ flip · \/sessions'/.test(strip))

console.log(failures === 0 ? '\nsession flip chord: GREEN' : `\nsession flip chord: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
