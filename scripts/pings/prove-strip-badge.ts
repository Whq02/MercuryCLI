

const { ACTION_GRAPH } = await import('../../src/screen/keys/actionGraph.js')
const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.js')
const { FLAG_ICON } = await import('../../src/screen/theme/rowGlyphs.js')
const { needsYouJump } = await import('../../src/screen/widgets/needsYouJump.js')

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
  const { needsYouCount } = await import('../../src/screen/attention/needsYouCount.js')
  check('needsYouCount(1) = "1 needs you"', needsYouCount(1) === '1 needs you', `${needsYouCount(1)}; fix the singular and plural wording in needsYouCount in src/screen/attention/needsYouCount.ts`)
  check('needsYouCount(2) = "2 need you"', needsYouCount(2) === '2 need you', `${needsYouCount(2)}; fix the plural wording in needsYouCount in src/screen/attention/needsYouCount.ts`)
  check('needsYouCount(0) = "0 need you"', needsYouCount(0) === '0 need you', `${needsYouCount(0)}; fix the zero-count wording in needsYouCount in src/screen/attention/needsYouCount.ts`)
}
check('the flag glyph is the sanctioned FLAG_ICON (census-cleared ⚑)', FLAG_ICON === '⚑', 'set FLAG_ICON back to the sanctioned glyph in src/screen/theme/rowGlyphs.ts')

section('§2 the advertised chord is the resolver’s own display')
check(
  'the board jump advertises the resolver chord, including a rebind',
  needsYouJump({ plain: false, ownOnly: false, boardChord: 'alt+g' }) === 'alt+g board',
  'needsYouJump in src/screen/widgets/needsYouJump.ts must return the boardChord followed by board when not plain',
)
check(
  'the plain chat names its own waiting ask without advertising a board',
  needsYouJump({ plain: true, ownOnly: true, boardChord: 'alt+g' }) === 'this chat',
  'needsYouJump in src/screen/widgets/needsYouJump.ts must return this chat when plain and ownOnly',
)
check(
  'the plain chat names the resume door for another waiting session',
  needsYouJump({ plain: true, ownOnly: false, boardChord: 'alt+g' }) === '/sessions',
  'needsYouJump in src/screen/widgets/needsYouJump.ts must return /sessions when plain and not ownOnly',
)

section('§3 the advertised action is real and reaches the board')
check(
  'app:openSurfaceSwitcher exists in the action graph (the atlas row)',
  'app:openSurfaceSwitcher' in ACTION_GRAPH,
  'add the app:openSurfaceSwitcher action to ACTION_GRAPH in src/screen/keys/actionGraph.ts',
)
const globalBlock = DEFAULT_BINDINGS.find(b => b.context === 'Global')
const chord = Object.entries(globalBlock?.bindings ?? {}).find(
  ([, action]) => action === 'app:openSurfaceSwitcher',
)?.[0]
check("a Global default chord binds it (ctrl+x c)", chord === 'ctrl+x c', `got ${String(chord)}; bind ctrl+x c to app:openSurfaceSwitcher in the Global block of src/screen/keys/defaultBindings.ts`)

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL STRIP-BADGE PROOFS PASS')
else console.log(`${failures} STRIP-BADGE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
