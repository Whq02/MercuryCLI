// ============================================================================
//  scripts/pings/prove-strip-badge.ts — the strip badge:
//  the focused chat's status strip carries `⚑ N need you` while sessions
//  need you, beside an ADVERTISED jump key that is a real, resolvable
//  binding to the board.
//
//  Structural pins over the one strip (MercuryFrame) + functional pins over
//  the binding table the runtime resolves against:
//    §1 the badge is the ruled shape, fed by the ONE attention view, and
//       renders only while something waits;
//    §2 the advertised chord comes from the resolver's own display
//       (useShortcutDisplay) — a rebind can never leave the advert stale;
//    §3 the advertised action exists in the action graph, holds a Global
//       default chord, and its handler enters the Concourse (the board) —
//       never a dead advertised key.
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')

const { ACTION_GRAPH } = await import('../../src/keybindings/actionGraph.js')
const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.js')
const { FLAG_ICON } = await import('../../src/constants/figures.js')

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${name}`)
  else {
    failures += 1
    console.log(`  ❌ ${name}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n── ${title} ──`)
}

const frame = readFileSync(join(ROOT, 'src', 'components', 'MercuryFrame.tsx'), 'utf8')

//
section('§1 the badge is the ruled shape on the one strip')
//
check(
  'the badge speaks the ruled grammar through the ONE count owner ({FLAG_ICON} needsYouCount(N))',
  frame.includes('{FLAG_ICON} {needsYouCount(attentionView.needsYou)}'),
)
// THE COUNT GRAMMAR (the find — "⚑ 1 need you" read off
// for N=1): one owner for every count chip, the verb agreeing with its
// subject. Poison = the retired fixed spelling on either side of one.
{
  const { needsYouCount } = await import('../../src/utils/needsYouCount.js')
  check('needsYouCount(1) = "1 needs you"', needsYouCount(1) === '1 needs you', needsYouCount(1))
  check('needsYouCount(2) = "2 need you"', needsYouCount(2) === '2 need you', needsYouCount(2))
  check('needsYouCount(0) = "0 need you"', needsYouCount(0) === '0 need you', needsYouCount(0))
  const strips = readFileSync(join(ROOT, 'src', 'components', 'concourse', 'ConcourseStrips.tsx'), 'utf8')
  check(
    "the board's status strip counts through the same owner (both paint sites)",
    (strips.match(/needsYouCount\(counts\.needsYou\)/g) ?? []).length === 2 && !/needsYou\} needs you/.test(strips),
  )
}
check('the flag glyph is the sanctioned FLAG_ICON (census-cleared ⚑)', FLAG_ICON === '⚑')
check(
  'the badge renders only while something actually waits',
  frame.includes('attentionView.needsYou > 0 ?'),
)
check(
  'the count is the ONE attention view-model (the same facts the board and the ping engine read)',
  frame.includes('cachedAttentionView') && frame.includes('subscribeAttentionView'),
)

//
section('§2 the advertised chord is the resolver’s own display')
//
check(
  "the advert rides useShortcutDisplay('app:openSurfaceSwitcher', 'Global', …)",
  /useShortcutDisplay\('app:openSurfaceSwitcher',\s*'Global'/.test(frame),
)
check('the badge advertises the chord beside the count', frame.includes('{boardChord} board'))

//
section('§3 the advertised action is real and reaches the board')
//
check(
  'app:openSurfaceSwitcher exists in the action graph (the atlas row)',
  'app:openSurfaceSwitcher' in ACTION_GRAPH,
)
const globalBlock = DEFAULT_BINDINGS.find(b => b.context === 'Global')
const chord = Object.entries(globalBlock?.bindings ?? {}).find(
  ([, action]) => action === 'app:openSurfaceSwitcher',
)?.[0]
check("a Global default chord binds it (ctrl+x c)", chord === 'ctrl+x c', `got ${String(chord)}`)
const globalKeys = readFileSync(join(ROOT, 'src', 'hooks', 'useGlobalKeybindings.tsx'), 'utf8')
check(
  'the handler enters the Concourse (the board) — never a dead advertised key',
  /'app:openSurfaceSwitcher':[\s\S]{0,200}enterConcourse\(\)/.test(globalKeys),
)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL STRIP-BADGE PROOFS PASS')
else console.log(`${failures} STRIP-BADGE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
