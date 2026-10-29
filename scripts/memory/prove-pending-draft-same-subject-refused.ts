#!/usr/bin/env bun
// gate-watch: src/mneme/mnemeContradiction.ts src/mneme/memoryVerbs.ts src/mneme/mnemeText.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0', PACKAGE_URL: 'https://example.invalid/mercury' }
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-pending-draft-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const key of ['MERCURY_HOME', 'MERCURY_BARE', 'TYPESAFE_API_KEY', 'NODE_ENV', 'https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY']) delete process.env[key]

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

writeFileSync(join(HOME, '.mercury.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 3 }))
const { enableConfigs } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
const { contradictionBetween, restates } = await import('../../src/mneme/mnemeContradiction.ts')
const { retainItems, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')

const dir = mnemeLibraryDir()
type Outcome = ReturnType<typeof retainItems>[number]
const describe = (o: Outcome): string => (o.status === 'refused' ? `refused: ${o.reason}` : `${o.status} ${'id' in o ? o.id : ''}`)
const refusedNaming = (o: Outcome, word: string): boolean => o.status === 'refused' && o.reason.includes('conflicts with') && o.reason.includes(word)

function retainOne(content: string, context: string | undefined, session: string): Outcome {
  _resetMemoryVerbSessionStateForTesting()
  return retainItems([{ content, ...(context === undefined ? {} : { context }), topic: 'field' }], { session }, dir)[0]!
}

section('§1 the field\'s shapes: the first draft is still pending, the second Retain changes the count, the source or the location — each carries its own context')
const vault7 = retainOne('The vault holds 7 coins.', "Stated by the user as a 'remember:' filler fact in session 18 (2026-10-17), continuing the same series as the scratch-drawer spoon facts.", 'session-18')
check('the first vault fact stores as a pending draft', vault7.status === 'stored' && vault7.id.startsWith('pending:'), describe(vault7))
const vault9 = retainOne('The vault holds 9 coins.', undefined, 'session-19')
check('a changed count about the same subject is refused while the draft is pending, the pending record named', refusedNaming(vault9, 'a pending fact') && vault9.status === 'refused' && vault9.reason.includes('The vault holds 7 coins'), describe(vault9))
check('the buffer holds one vault fact, not two', pendingRows(dir).filter(row => row.text.includes('vault holds')).length === 1, pendingRows(dir).map(row => row.text.slice(0, 40)).join(' | '))

const choir3 = retainOne('The choir has 3 singers.', "Stated by the user as a 'remember:' fact in this session.", 'session-20')
const choir5 = retainOne('The choir has 5 singers.', "Stated by the user as a 'remember:' fact in this session; the newest word.", 'session-21')
check('the choir count stores once and the changed count is refused against the pending draft', choir3.status === 'stored' && refusedNaming(choir5, 'The choir has 3 singers'), `${describe(choir3)} · ${describe(choir5)}`)

const build36 = retainOne('The nightly build runs from the mercury-36 folder.', 'Stated by the user in session 22.', 'session-22')
const build37 = retainOne('The nightly build runs from the mercury-37 folder.', 'Stated by the user in session 23.', 'session-23')
check('a changed source folder about the same build is refused against the pending draft', build36.status === 'stored' && refusedNaming(build37, 'mercury-36'), `${describe(build36)} · ${describe(build37)}`)
const wingEast = retainOne('The archive lives in the east wing.', 'Stated by the user in session 22b.', 'session-22b')
const wingWest = retainOne('The archive lives in the west wing.', 'Stated by the user in session 23b.', 'session-23b')
check('a changed location about the same subject is refused against the pending draft, with no context tail leaked in the quote', wingEast.status === 'stored' && refusedNaming(wingWest, 'The archive lives in the east wing.') && wingWest.status === 'refused' && !wingWest.reason.includes('(context:'), `${describe(wingEast)} · ${describe(wingWest)}`)

const drawer10 = retainOne('Scratch filler fact number 10: the scratch drawer 10 holds 10 spoons.', "Stated directly by the user as a 'remember:' filler fact in session 10 (2026-10-17), continuing the scratch drawer 1-9 series from earlier sessions.", 'session-10')
const drawer12 = retainOne('The scratch drawer 10 holds 12 spoons.', "Stated directly by the user as a 'remember:' filler fact in session 13 (2026-10-17), continuing the scratch drawer 1-9 and 12 series from earlier sessions.", 'session-13')
check('a changed count whose subject phrase sits inside a longer pending sentence is refused, the draft named', drawer10.status === 'stored' && refusedNaming(drawer12, 'Scratch filler fact number 10') && drawer12.status === 'refused' && drawer12.reason.includes(drawer10.id), `${describe(drawer10)} · ${describe(drawer12)}`)

section('§2 what still stores: distinct subjects, a true restatement, a different predicate')
const drawer11 = retainOne('The scratch drawer 11 holds 11 spoons.', 'Stated by the user in session 11.', 'session-11')
check('a different drawer with its own count stores beside drawer 10 (the round-9 false conflict stays dead)', drawer11.status === 'stored', describe(drawer11))
const vault7again = retainOne('The vault holds 7 coins.', 'Restated by the user in session 24.', 'session-24')
check('the same count restated with another context is not a conflict', vault7again.status !== 'refused', describe(vault7again))
const vaultDoor = retainOne('The vault door is 9 feet tall.', 'Stated by the user in session 25.', 'session-25')
check('another fact about the vault with its own number stores', vaultDoor.status === 'stored', describe(vaultDoor))
const kitchenDrawer = retainOne('The kitchen drawer 10 holds 12 spoons.', 'Stated by the user in session 26.', 'session-26')
check('a drawer in another room is another subject and stores', kitchenDrawer.status === 'stored', describe(kitchenDrawer))

section('§3 the detector reads the fact, not its context tail')
const withTail = "The vault holds 7 coins. (context: Stated by the user as a 'remember:' filler fact in session 18 (2026-10-17), continuing the same series as the scratch-drawer spoon facts.)"
check('a bare candidate against a stored fact that carries its context: the number flip is seen', contradictionBetween('The vault holds 9 coins.', withTail)?.flip === 'a number that differs', JSON.stringify(contradictionBetween('The vault holds 9 coins.', withTail)))
check('the same count against the same stored fact is a restatement, not a conflict', contradictionBetween('The vault holds 7 coins.', withTail) === null, JSON.stringify(contradictionBetween('The vault holds 7 coins.', withTail)))
check('a candidate carrying its own context tail compares the same way', contradictionBetween('The vault holds 9 coins. (context: said again in session 19.)', withTail)?.flip === 'a number that differs')
check('the subject phrase inside a longer sentence: one changed slot after the predicate is the flip', contradictionBetween('The scratch drawer 10 holds 12 spoons.', 'Scratch filler fact number 10: the scratch drawer 10 holds 10 spoons.')?.flip === 'a number that differs')
check('two changed slots inside the longer sentence are two subjects, not a flip', contradictionBetween('The scratch drawer 11 holds 11 spoons.', 'Scratch filler fact number 10: the scratch drawer 10 holds 10 spoons.') === null)
check('a window that breaks the subject phrase is not a match', contradictionBetween('The scratch drawer 10 holds 12 spoons.', 'The kitchen scratch drawer 10 holds 10 spoons.') === null)
check('restates strips the context tail on a true restatement and never calls a changed count a restatement', restates('The vault holds 7 coins.', withTail) && !restates('The vault holds 9 coins.', 'The vault holds 7 coins.'))
check('a single-digit count change against a two-sentence draft is caught as a number flip', contradictionBetween('The vault holds 9 coins.', 'The vault sits in the cellar. The vault holds 7 coins. (context: Stated in session 18.)')?.flip === 'a number that differs')

section('§4 after consolidation the same law holds against the library')
check('the drafts consolidate', maybeConsolidate({ force: true, dir }).consolidated)
const vault11 = retainOne('The vault holds 11 coins.', 'Stated by the user in session 27.', 'session-27')
check('a changed count against the consolidated fact is refused with the fact named', vault11.status === 'refused' && vault11.reason.includes('conflicts with fact') && vault11.reason.includes('The vault holds 7 coins'), describe(vault11))

console.log(`\n${checks} checks, ${failures} failed`)
console.log(failures === 0 ? 'GREEN: a changed value about a pending draft is refused with the draft named' : `RED: ${failures} check(s) let a same-subject change land beside its draft`)
process.exit(failures === 0 ? 0 : 1)
