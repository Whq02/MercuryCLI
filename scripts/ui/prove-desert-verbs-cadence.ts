#!/usr/bin/env bun
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
const { getSpinnerVerbs, isTensorFoldTurn, sampleSpinnerVerb } = await import('../../src/screen/spinner/spinnerVerbs.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const LEGACY_SHORT = new Set(['Basking', 'Molting'])
const LEGACY_PAST = new Set(['Salt-burnt', 'Sand-slicked'])
const THREE_PART_CEILING = 'Salt-flat-gliding'

function auditDesertVerbs(desert: readonly string[], others: readonly string[]): string[] {
  const errs: string[] = []
  const seen = new Map<string, string>()
  for (const o of others) {
    seen.set(o.toLowerCase().replace(/[\s-]/g, ''), `other:${o}`)
  }
  for (let i = 0; i < desert.length; i++) {
    const v = desert[i]!
    if (/[.!?,;:…]$/.test(v)) errs.push(`${v}: trailing punctuation`)
    if (v.includes('!')) errs.push(`${v}: exclamation mark`)
    if (/\p{Extended_Pictographic}/u.test(v)) errs.push(`${v}: emoji`)
    const maxLen = 20
    const minLen = LEGACY_SHORT.has(v) && i < 37 ? 7 : 8
    if (v.length < minLen || v.length > maxLen) errs.push(`${v}: length ${v.length} outside ${minLen}..${maxLen}`)
    const shapeOk = v === THREE_PART_CEILING && i < 37
      ? /^[A-Z][a-z]+-[a-z]+-[a-z]+$/.test(v)
      : /^[A-Z][a-z]+(-[a-z]+)?$/.test(v)
    if (!shapeOk) errs.push(`${v}: fails Title-case desert verb shape`)
    const participleOk = (LEGACY_PAST.has(v) && i < 37) || v.endsWith('ing')
    if (!participleOk) errs.push(`${v}: not a present participle (-ing)`)
    const norm = v.toLowerCase().replace(/[\s-]/g, '')
    if (seen.has(norm)) errs.push(`${v}: duplicate of ${seen.get(norm)}`)
    seen.set(norm, v)
  }
  return errs
}

const APPROVED_PHRASES: readonly string[] = [
  'Parsing the dunes',
  'Hashing the oasis',
  'Compiling the mirage',
  'Encrypting the caravan',
  'Traversing the sandstorm',
  'Optimizing the pyramid',
  'Debugging the sphinx',
  'Reversing the hieroglyphs',
  'Fuzzing the nomad',
  'Injecting the scarab',
  'Exploiting the tomb',
  'Overflowing the Nile',
  'Obfuscating the pharaoh',
  'Tracing the trade routes',
  'Cracking the amulet',
  'Pwning the mummy',
  'Overclocking the sandglass',
  'Jailbreaking the labyrinth',
  'Ciphering the scrolls',
  'Shellcoding the djinn',
  'Bit-shifting the sundial',
  'Polymorphing the serpent',
  'Disassembling the ankh',
  'Hex-editing the sarcophagus',
]

function poolFor(hip: string | undefined, desertOn: string | undefined): string[] {
  if (hip === undefined) delete process.env.MERCURY_HIP
  else process.env.MERCURY_HIP = hip
  if (desertOn === undefined) delete process.env.MERCURY_DESERT_VERBS
  else process.env.MERCURY_DESERT_VERBS = desertOn
  return getSpinnerVerbs({ tensorfold: false })
}

const desertAll = poolFor('0', undefined)
const phraseStart = desertAll.indexOf(APPROVED_PHRASES[0]!)
const desert = phraseStart >= 0 ? desertAll.slice(0, phraseStart) : desertAll
const phrases = phraseStart >= 0 ? desertAll.slice(phraseStart) : []
const stock = poolFor('0', '0')
const quicksilverList = poolFor('1', undefined)
const others = [...stock, ...quicksilverList]
delete process.env.MERCURY_HIP
delete process.env.MERCURY_DESERT_VERBS

console.log('prove-desert-verbs-cadence — cadence laws and register for MERCURY_DESERT_VERBS')

{
  const baseSample = desert.slice(0, 37)
  check('self-test: purposeful trailing punctuation trips', auditDesertVerbs([...baseSample, 'Cairn-sighting…'], others).some(e => e.includes('trailing punctuation')))
  check('self-test: purposeful exclamation mark trips', auditDesertVerbs([...baseSample, 'Cairn-sighting!'], others).some(e => e.includes('exclamation mark')))
  check('self-test: purposeful emoji trips', auditDesertVerbs([...baseSample, 'Cairn-sighting🌵'], others).some(e => e.includes('emoji')))
  check('self-test: purposeful short verb (<8 chars) trips', auditDesertVerbs([...baseSample, 'Pacing'], others).some(e => e.includes('length')))
  check('self-test: purposeful long verb (>20 chars) trips', auditDesertVerbs([...baseSample, 'Sandstone-weathering-out'], others).some(e => e.includes('length')))
  check('self-test: purposeful lowercase or mid-cap trips', auditDesertVerbs([...baseSample, 'Cairn-Sighting'], others).some(e => e.includes('Title-case')) && auditDesertVerbs([...baseSample, 'cairn-sighting'], others).some(e => e.includes('Title-case')))
  check('self-test: purposeful 3-part compound beyond Salt-flat-gliding trips', auditDesertVerbs([...baseSample, 'Dry-wash-following'], others).some(e => e.includes('Title-case')))
  check('self-test: purposeful non-participle trips', auditDesertVerbs([...baseSample, 'Cairn-sighted'], others).some(e => e.includes('present participle')))
  check('self-test: purposeful hyphen-insensitive duplicate trips', auditDesertVerbs([...baseSample, 'Dunerunning'], others).some(e => e.includes('duplicate')))
  check('self-test: purposeful cross-list duplicate trips', auditDesertVerbs([...baseSample, 'Thinking'], others).some(e => e.includes('duplicate')))
}

const violations = auditDesertVerbs(desert, others)
check('every entry in MERCURY_DESERT_VERBS obeys all cadence and register laws', violations.length === 0, `${violations.join(' | ')} — rename or remove the listed verbs in MERCURY_DESERT_VERBS in src/screen/spinner/spinnerVerbs.ts`)
check('original 37 desert verbs stay anchored from Scuttling to Sand-slicked', desert[0] === 'Scuttling' && desert[36] === 'Sand-slicked', `0=${desert[0]} 36=${desert[36]} — keep the first 37 entries of MERCURY_DESERT_VERBS in src/screen/spinner/spinnerVerbs.ts in place and in order`)
const added = desert.slice(37)
check('20 or more new desert thinking verbs are landed after Sand-slicked (the 30 of the second batch, then the 20 ops verbs of 2026-10-26)', added.length >= 20, `added=${added.length} — MERCURY_DESERT_VERBS in src/screen/spinner/spinnerVerbs.ts needs 20 or more verbs after Sand-slicked`)

console.log('\nMERCURY_DESERT_PHRASES — the approved lines, their hygiene and their place in the pool')
check('MERCURY_DESERT_PHRASES holds exactly the 24 approved phrases, in order, verbatim', phrases.length === 24 && phrases.every((p, i) => p === APPROVED_PHRASES[i]), `${phrases.join(' | ')} — make MERCURY_DESERT_PHRASES in src/screen/spinner/spinnerVerbs.ts match APPROVED_PHRASES in this file`)
check('no phrase carries trailing punctuation, an exclamation mark or an emoji', phrases.every(p => !/[.!?,;:…]$/.test(p) && !p.includes('!') && !/\p{Extended_Pictographic}/u.test(p)), 'remove the trailing punctuation, exclamation mark or emoji from the phrase in MERCURY_DESERT_PHRASES in src/screen/spinner/spinnerVerbs.ts')
{
  const norm = (v: string): string => v.toLowerCase().replace(/[\s-]/g, '')
  const everyOther = new Set([...desert, ...others].map(norm))
  const dupes = phrases.filter((p, i) => everyOther.has(norm(p)) || phrases.findIndex(q => norm(q) === norm(p)) !== i)
  check('no phrase duplicates another entry in any list (hyphen and space insensitive)', dupes.length === 0, `${dupes.join(' | ')} — reword the duplicated phrase in MERCURY_DESERT_PHRASES in src/screen/spinner/spinnerVerbs.ts`)
}
check('the existing cadence laws still read the verbs alone (the phrase list is its own array)', !desert.some(v => v.includes(' ')) && !desert.some(v => phrases.includes(v)), `desert=${desert.length} — keep multi-word lines in MERCURY_DESERT_PHRASES, not in MERCURY_DESERT_VERBS, in src/screen/spinner/spinnerVerbs.ts`)
{
  const phraseSet = new Set(phrases)
  const desertSet = new Set(desert)
  const quicksilver = new Set(quicksilverList)
  const draw = (n: number): string[] => Array.from({ length: n }, () => sampleSpinnerVerb())
  delete process.env.MERCURY_HIP
  delete process.env.MERCURY_DESERT_VERBS
  const mixed = draw(400)
  check('the default pool (desert + quicksilver) draws the phrases and nothing outside the three sets', mixed.some(v => phraseSet.has(v)) && mixed.every(v => phraseSet.has(v) || desertSet.has(v) || quicksilver.has(v)), `${mixed.filter(v => !(phraseSet.has(v) || desertSet.has(v) || quicksilver.has(v))).join(' | ')} — check the default pool built in getSpinnerVerbs and sampleSpinnerVerb in src/screen/spinner/spinnerVerbs.ts`)
  process.env.MERCURY_HIP = '0'
  const desertOnly = draw(400)
  check('quicksilver off: every draw is a desert verb or a desert phrase, and the phrases do appear', desertOnly.some(v => phraseSet.has(v)) && desertOnly.every(v => phraseSet.has(v) || desertSet.has(v)), `${desertOnly.filter(v => !(phraseSet.has(v) || desertSet.has(v))).join(' | ')} — check getSpinnerVerbs and sampleSpinnerVerb in src/screen/spinner/spinnerVerbs.ts with MERCURY_HIP=0`)
  process.env.MERCURY_HIP = '1'
  check('quicksilver only: no phrase and no desert verb is drawn', draw(300).every(v => quicksilver.has(v)), 'with MERCURY_HIP=1 getSpinnerVerbs in src/screen/spinner/spinnerVerbs.ts must return only the quicksilver lists')
  delete process.env.MERCURY_HIP
  process.env.MERCURY_DESERT_VERBS = '0'
  const stockSet = new Set(stock)
  check('MERCURY_DESERT_VERBS=0 drops the phrases with the desert verbs: every draw is stock or quicksilver', draw(300).every(v => stockSet.has(v) || quicksilver.has(v)), 'with MERCURY_DESERT_VERBS=0 getSpinnerVerbs in src/screen/spinner/spinnerVerbs.ts must drop both MERCURY_DESERT_VERBS and MERCURY_DESERT_PHRASES')
  delete process.env.MERCURY_DESERT_VERBS
  check(
    'the six owner-added verbs are present in the pool in house form',
    ['Tensorfolding', 'Open-sourcing', 'Flatlining', 'Microsofting'].every(v => desertSet.has(v)) &&
      quicksilver.has("Chippin' in") &&
      quicksilver.has('Klepping high-grade chrome'),
    'restore the missing verb in MERCURY_DESERT_VERBS or the quicksilver lists in src/screen/spinner/spinnerVerbs.ts',
  )
  const plainCount = getSpinnerVerbs({ tensorfold: false }).filter(v => v === 'Tensorfolding').length
  const tfCount = getSpinnerVerbs({ tensorfold: true }).filter(v => v === 'Tensorfolding').length
  check(
    'Tensorfolding favours turns whose model is on TensorFold while respecting quicksilver-only and stock modes',
    plainCount === 1 && tfCount > plainCount && isTensorFoldTurn({ model: 'local/qwen3.8-27b' }) && !isTensorFoldTurn({ model: 'claude-opus-5-5' }),
    `plain=${plainCount} tf=${tfCount} — check isTensorFoldTurn and the tensorfold weighting in getSpinnerVerbs in src/screen/spinner/spinnerVerbs.ts`,
  )
}

console.log(failures === 0 ? '\n✅ prove-desert-verbs-cadence: ALL GREEN' : `\n❌ prove-desert-verbs-cadence: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
