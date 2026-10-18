#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SRC_PATH = join(ROOT, 'src/constants/spinnerVerbs.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function extractList(src: string, name: string): string[] {
  const re = new RegExp(`(?:export\\s+)?const\\s+${name}:\\s*readonly\\s+string\\[\\]\\s*=\\s*\\[([\\s\\S]*?)\\n\\]`)
  const m = re.exec(src)
  if (!m) return []
  return [...m[1]!.matchAll(/^\s*'([^']+)',\s*$/gm)].map(hit => hit[1]!)
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

const src = readFileSync(SRC_PATH, 'utf8')
const desert = extractList(src, 'MERCURY_DESERT_VERBS')
const stock = extractList(src, 'STOCK_VERBS')
const qsMain = extractList(src, 'MERCURY_QUICKSILVER')
const qsCode = extractList(src, 'MERCURY_QUICKSILVER_CODE')
const qsFlow = extractList(src, 'MERCURY_QUICKSILVER_FLOW')
const others = [...stock, ...qsMain, ...qsCode, ...qsFlow]

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
check('every entry in MERCURY_DESERT_VERBS obeys all cadence and register laws', violations.length === 0, violations.join(' | '))
check('original 37 desert verbs stay anchored from Scuttling to Sand-slicked', desert[0] === 'Scuttling' && desert[36] === 'Sand-slicked', `0=${desert[0]} 36=${desert[36]}`)
const added = desert.slice(37)
check('20 to 30 new desert thinking verbs are landed after Sand-slicked', added.length >= 20 && added.length <= 30, `added=${added.length}`)

console.log(failures === 0 ? '\n✅ prove-desert-verbs-cadence: ALL GREEN' : `\n❌ prove-desert-verbs-cadence: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
