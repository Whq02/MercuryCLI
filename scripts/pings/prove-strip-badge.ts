

const { ACTION_GRAPH } = await import('../../src/keybindings/actionGraph.js')
const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.js')
const { FLAG_ICON } = await import('../../src/constants/figures.js')
const { needsYouJump } = await import('../../src/components/mercury-ui/needsYouJump.js')

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


section('§1 the badge is the ruled shape on the one strip')
{
  const { needsYouCount } = await import('../../src/utils/needsYouCount.js')
  check('needsYouCount(1) = "1 needs you"', needsYouCount(1) === '1 needs you', needsYouCount(1))
  check('needsYouCount(2) = "2 need you"', needsYouCount(2) === '2 need you', needsYouCount(2))
  check('needsYouCount(0) = "0 need you"', needsYouCount(0) === '0 need you', needsYouCount(0))
}
check('the flag glyph is the sanctioned FLAG_ICON (census-cleared ⚑)', FLAG_ICON === '⚑')

section('§2 the advertised chord is the resolver’s own display')
check(
  'the board jump advertises the resolver chord, including a rebind',
  needsYouJump({ plain: false, ownOnly: false, boardChord: 'alt+g' }) === 'alt+g board',
)
check(
  'the plain chat names its own waiting ask without advertising a board',
  needsYouJump({ plain: true, ownOnly: true, boardChord: 'alt+g' }) === 'this chat',
)
check(
  'the plain chat names the resume door for another waiting session',
  needsYouJump({ plain: true, ownOnly: false, boardChord: 'alt+g' }) === '/sessions',
)

section('§3 the advertised action is real and reaches the board')
check(
  'app:openSurfaceSwitcher exists in the action graph (the atlas row)',
  'app:openSurfaceSwitcher' in ACTION_GRAPH,
)
const globalBlock = DEFAULT_BINDINGS.find(b => b.context === 'Global')
const chord = Object.entries(globalBlock?.bindings ?? {}).find(
  ([, action]) => action === 'app:openSurfaceSwitcher',
)?.[0]
check("a Global default chord binds it (ctrl+x c)", chord === 'ctrl+x c', `got ${String(chord)}`)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL STRIP-BADGE PROOFS PASS')
else console.log(`${failures} STRIP-BADGE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
