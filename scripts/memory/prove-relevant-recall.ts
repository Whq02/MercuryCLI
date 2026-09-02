#!/usr/bin/env bun

const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on)
    (globalThis as Record<string, unknown>)[MACRO_KEY] = {
      VERSION: '1.0.0',
    }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

setStamp(true)

const {
  relevantMemoryRecallEnabled,
  filterInjectedMemoryFilesByRecall,
} = (await import('../../src/memdir/paths.ts')) as typeof import('../../src/memdir/paths.js')

const { formatMemoryManifest } = (await import(
  '../../src/memdir/memoryScan.ts'
)) as typeof import('../../src/memdir/memoryScan.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(
    `  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`,
  )
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' relevant-memory-recall mode — DEFAULT-OFF opt-in proof')
console.log('============================================================')

type F = { type: string; path: string; content: string }
const files: F[] = [
  { type: 'AutoMem', path: '/m/MEMORY.md', content: 'auto' },
  { type: 'TeamMem', path: '/m/TEAM.md', content: 'team' },
  { type: 'Project', path: '/p/MERCURY.md', content: 'proj' },
  { type: 'User', path: '/u/USER.md', content: 'user' },
  { type: 'Local', path: '/p/MERCURY.local.md', content: 'local' },
]
const allTypes = files.map(f => f.type).sort().join(',')
const noAutoTeam = files
  .filter(f => f.type !== 'AutoMem' && f.type !== 'TeamMem')
  .map(f => f.type)
  .sort()
  .join(',')

function injectedSet(): string {
  return filterInjectedMemoryFilesByRecall(files, relevantMemoryRecallEnabled())
    .map(f => f.type)
    .sort()
    .join(',')
}

section('GATE — DEFAULT-OFF / opt-in resolution (stamped build)')
delete process.env.MERCURY_RELEVANT_RECALL
check('fork + env unset ⇒ gate OFF', relevantMemoryRecallEnabled() === false)
process.env.MERCURY_RELEVANT_RECALL = '1'
check('fork + env=1 ⇒ gate ON', relevantMemoryRecallEnabled() === true)
process.env.MERCURY_RELEVANT_RECALL = '0'
check('fork + env=0 ⇒ gate OFF', relevantMemoryRecallEnabled() === false)
process.env.MERCURY_RELEVANT_RECALL = 'true'
check(
  'fork + env=true ⇒ gate OFF (only the exact "1" opts in)',
  relevantMemoryRecallEnabled() === false,
)
process.env.MERCURY_RELEVANT_RECALL = 'yes'
check('fork + env=yes ⇒ gate OFF', relevantMemoryRecallEnabled() === false)

section('GATE — stamp-independent (a bare stamp cannot strip the opt-in)')
setStamp(false)
process.env.MERCURY_RELEVANT_RECALL = '1'
check(
  'bare stamp + env=1 ⇒ gate ON (stamp-independence)',
  relevantMemoryRecallEnabled() === true,
)
setStamp(true)

section('EFFECT — injected memory SET differs ON vs OFF (the real behavior)')
delete process.env.MERCURY_RELEVANT_RECALL
const setOff = injectedSet()
check(
  'OFF ⇒ injected set is UNCHANGED (all 5 files, incl. AutoMem+TeamMem)',
  setOff === allTypes,
  setOff,
)
process.env.MERCURY_RELEVANT_RECALL = '1'
const setOn = injectedSet()
check(
  'ON ⇒ AutoMem + TeamMem DROPPED from the injected set',
  setOn === noAutoTeam,
  setOn,
)
check(
  'ON ⇒ AutoMem absent',
  !filterInjectedMemoryFilesByRecall(files, true).some(
    f => f.type === 'AutoMem',
  ),
)
check(
  'ON ⇒ TeamMem absent',
  !filterInjectedMemoryFilesByRecall(files, true).some(
    f => f.type === 'TeamMem',
  ),
)
check(
  'ON ⇒ Project/User/Local STILL injected (MERCURY.md family untouched)',
  ['Project', 'User', 'Local'].every(t =>
    filterInjectedMemoryFilesByRecall(files, true).some(f => f.type === t),
  ),
)
check('ON set ⊊ OFF set (recall strictly narrows)', setOn !== setOff)

section('EFFECT — the pure filter honors its recallOn argument directly')
check(
  'filter(files, false) ⇒ unchanged (returns a copy, same types)',
  filterInjectedMemoryFilesByRecall(files, false).map(f => f.type).join(',') ===
    files.map(f => f.type).join(','),
)
check(
  'filter(files, false) returns a NEW array (not the input ref — caller-safe)',
  filterInjectedMemoryFilesByRecall(files, false) !== files,
)
check(
  'filter(files, true) ⇒ exactly AutoMem+TeamMem removed',
  filterInjectedMemoryFilesByRecall(files, true).length === files.length - 2,
)
check(
  'filter([], true) ⇒ [] (empty in, empty out, never throws)',
  filterInjectedMemoryFilesByRecall([] as F[], true).length === 0,
)

delete process.env.MERCURY_RELEVANT_RECALL
setStamp(false)

section('C7 — recall manifest unicode-sanitize (formatMemoryManifest)')

type Hdr = Parameters<typeof formatMemoryManifest>[0][number]
function hdr(over: Partial<Hdr>): Hdr {
  return {
    filename: 'note.md',
    filePath: '/m/note.md',
    mtimeMs: 0,
    description: null,
    type: undefined,
    problemClass: null,
    transferabilityScope: null,
    ...over,
  }
}
const TS0 = new Date(0).toISOString()

{
  const clean = [
    hdr({ filename: 'a.md', description: 'a plain ascii description' }),
  ]
  const got = formatMemoryManifest(clean, false)
  const want = `- a.md (${TS0}): a plain ascii description`
  check('clean ASCII description ⇒ byte-identical to pre-change format', got === want, got)
}

{
  const tagChar = String.fromCodePoint(0xe0001)
  const zeroWidth = '​‌‍﻿'
  const dirty = `safe${tagChar}${zeroWidth}text`
  const got = formatMemoryManifest([hdr({ description: dirty })], false)
  check(
    'Tag-char + zero-width run STRIPPED from description',
    got === `- note.md (${TS0}): safetext`,
    got,
  )
  check('manifest contains no U+E0001 tag char', !got.includes(tagChar))
  check(
    'manifest contains no zero-width / BOM chars',
    !/[​-‏﻿]/.test(got),
  )
}

{
  const tagChar = String.fromCodePoint(0xe0001)
  const got = formatMemoryManifest(
    [
      hdr({
        type: 'experience-card' as Hdr['type'],
        description: 'd',
        problemClass: `cls${tagChar}​`,
        transferabilityScope: `gen${tagChar}eral`,
      }),
    ],
    true,
  )
  check(
    'precision row: class=/scope= fields are sanitized (no tag/zero-width)',
    got.includes('class=cls') &&
      got.includes('scope=general') &&
      !got.includes(tagChar) &&
      !/[​-‏﻿]/.test(got),
    got,
  )
}

{
  const { partiallySanitizeUnicode } = (await import(
    '../../src/utils/sanitization.ts'
  )) as typeof import('../../src/utils/sanitization.js')
  check(
    'partiallySanitizeUnicode is identity on clean ASCII (fallback anchor)',
    partiallySanitizeUnicode('plain') === 'plain',
  )
  const multi = formatMemoryManifest(
    [
      hdr({ filename: 'one.md', description: 'first row' }),
      hdr({ filename: 'two.md', description: 'second row' }),
    ],
    false,
  )
  check(
    'multi-row manifest renders BOTH rows (one bad field never blanks the rest)',
    multi.split('\n').length === 2 &&
      multi.includes('one.md') &&
      multi.includes('two.md'),
    JSON.stringify(multi),
  )
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL RELEVANT-RECALL PROOFS PASS')
else console.log(`❌ ${failures} RELEVANT-RECALL PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
