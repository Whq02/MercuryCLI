#!/usr/bin/env bun
// gate-watch: src/mneme/memoryRefs.ts src/mneme/entryKnapsack.ts src/mneme/entryState.ts src/mneme/mnemeUsage.ts
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_ENTRYPOINT = 'headless'
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'cited-path-home-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE

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
const j = (v: unknown): string => JSON.stringify(v)

const DAY = 86_400_000
const T = Date.UTC(2026, 9, 15, 9, 0, 0, 0)
let frozen = T
Date.now = () => frozen

writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { startLimit: 1000 } }))
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'cited-path-repo-')))
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (...args: string[]): void => {
  const run = spawnSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
}
git('init', '-q', '-b', 'lane/quartz-rotation')
mkdirSync(join(repo, 'src', 'mneme'), { recursive: true })
mkdirSync(join(repo, 'docs'), { recursive: true })
mkdirSync(join(repo, 'scripts'), { recursive: true })
writeFileSync(join(repo, 'README.md'), 'quartz\n')
writeFileSync(join(repo, 'src', 'exists.ts'), 'export {}\n')
writeFileSync(join(repo, 'src', 'mneme', 'memoryRefs.ts'), 'export {}\n')
writeFileSync(join(repo, 'docs', 'guide.md'), '# guide\n')
git('add', '.')
git('commit', '-q', '-m', 'first')

const state = await import('../../src/bootstrap/state.ts')
process.chdir(repo)
state.setOriginalCwd(repo)
state.setCwdState(repo)
state.setProjectRoot(repo)
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { mnemeProjectKey } = await import('../../src/mneme/paths.ts')
const knapsack = await import('../../src/mneme/entryKnapsack.ts')
const { readProjectState } = await import('../../src/mneme/entryState.ts')
const refs = await import('../../src/mneme/memoryRefs.ts')
const { appendObservation } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
const { listTopicDocs } = await import('../../src/mneme/mnemeLibrary.ts')
const { pinFact, readPins, readUsage } = await import('../../src/mneme/mnemeUsage.ts')

const validate = (refs as { validateCitedPaths?: (text: string, root: string | null) => { checked: string[]; missing: string[]; other: string[] } }).validateCitedPaths
const tokens = (refs as { citedPathTokens?: (text: string) => string[] }).citedPathTokens
const report = (text: string) => (validate ? validate(text, repo) : { checked: [] as string[], missing: [] as string[], other: [] as string[] })
const stateOf = (text: string, opts: { seq?: number; pinned?: boolean } = {}) =>
  refs.factMemoryState({ seq: opts.seq ?? 1, time: new Date(T - 2 * DAY).toISOString(), text }, { pins: opts.pinned ? [{ seq: opts.seq ?? 1, at: new Date(T).toISOString() }] : [], usage: {}, now: new Date(T), projectRoot: repo })

section('§1 a citation is a whole token, never a path-shaped suffix of a longer one (the measure-recall seat\'s R4 case)')
{
  const r4 = 'the Linux reading of each fold runs in the Docker container on the box (lead-scripts/linux-gate/linux-gate-b29.sh); the hosted GitHub gate runs ONCE, on the final tip, never per fold.'
  check('the token is the whole lead-scripts path', tokens !== undefined && j(tokens(r4)) === j(['lead-scripts/linux-gate/linux-gate-b29.sh']), tokens ? j(tokens(r4)) : 'no citedPathTokens')
  const r = report(r4)
  check('lead-scripts is not a folder of this project, so the citation is other: not checked, not missing', r.checked.length === 0 && r.missing.length === 0 && j(r.other) === j(['lead-scripts/linux-gate/linux-gate-b29.sh']), j(r))
  const s = stateOf(r4)
  check('the fact stays current (the base demoted it on the scripts/… suffix)', s.status === 'current', j(s))
}

section('§2 every cited project path is checked, not only the first; a missing one is named')
{
  const text = 'deploy rides src/exists.ts and the old src/gone.ts; the guide is docs/guide.md'
  const r = report(text)
  check('three project citations checked', j(r.checked) === j(['src/exists.ts', 'src/gone.ts', 'docs/guide.md']), j(r))
  check('the one that is gone is named', j(r.missing) === j(['src/gone.ts']), j(r))
  const s = stateOf(text)
  check('the fact reads needs-review with the missing path carried', s.status === 'needs-review' && j(s.missingPaths) === j(['src/gone.ts']), j(s))
  check('the status words name the path', refs.memoryStatusWords(s) === 'needs review — cited path moved: src/gone.ts', refs.memoryStatusWords(s))
  check('the bare status keeps its old words', refs.memoryStatusWords({ status: 'needs-review' }) === 'needs review — cited path moved')
}

section('§3 external, unknown and non-path tokens are never demotion evidence')
{
  const cases: Array<[string, string]> = [
    ['a url', 'the paper is https://arxiv.org/abs/2610.17616 and the html at https://arxiv.org/html/2610.17616v1'],
    ['an absolute path elsewhere', 'the hosts file /etc/hosts and the launcher /Users/someone/.mercury/bin/mercury'],
    ['a tilde path', 'settings live in ~/.mercury/settings.json'],
    ['a git ref', 'rebase onto origin/main before the fold'],
    ['prose with slashes', 'either/or and 1/2 of the cases, input/output pairs'],
    ['a glob', 'every proof under scripts/**/prove-*.ts and src/**'],
    ['a sibling worktree', '/Users/someone/Developer/mercury-36/vendor/embed is the real folder'],
    ['a parent escape', 'the file src/../../outside.ts is not ours'],
    ["git's own state", 'the lock .git/config.lock and the ref .git/refs/heads/main are git\'s, not the tree\'s'],
  ]
  for (const [label, text] of cases) {
    const r = report(text)
    check(`${label}: nothing missing, nothing checked`, r.missing.length === 0 && r.checked.length === 0, j(r))
    check(`${label}: the fact stays current`, stateOf(text).status === 'current')
  }
  check('with no project root nothing is checked at all', validate !== undefined && j(validate('src/gone.ts is gone', null)) === j({ checked: [], missing: [], other: [] }))
}

section('§4 punctuation, quotes and line references around a citation do not change what is checked')
{
  const text = 'see (src/exists.ts:12–18), `src/mneme/memoryRefs.ts:68-73`, "docs/guide.md", src/exists.ts#L40, and src/exists.ts.'
  const r = report(text)
  check('the citations are read whole and once each', j(r.checked) === j(['src/exists.ts', 'src/mneme/memoryRefs.ts', 'docs/guide.md']), j(r))
  check('all present', r.missing.length === 0, j(r))
  const trailing = report('the file src/gone.ts, then src/gone.ts.')
  check('a missing path is reported once however it is punctuated', j(trailing.missing) === j(['src/gone.ts']), j(trailing))
}

section('§5 absolute citations inside the project are checked whole; the project root itself counts as present')
{
  const r = report(`${repo}/src/exists.ts and ${repo}/src/nope.ts and ${repo}`)
  check('the two files are checked, the root too', j(r.checked) === j([`${repo}/src/exists.ts`, `${repo}/src/nope.ts`, repo]), j(r))
  check('the absent one is missing', j(r.missing) === j([`${repo}/src/nope.ts`]), j(r))
  const dirs = report('the folder src/mneme/ holds it and src/absent-dir/ does not')
  check('a directory citation is checked as a directory', j(dirs.checked) === j(['src/mneme/', 'src/absent-dir/']) && j(dirs.missing) === j(['src/absent-dir/']), j(dirs))
}

section('§6 recovery: a path that comes back makes the fact current again; a deleted one demotes it')
{
  const text = 'the quartz keys rotate in src/exists.ts'
  check('present: current', stateOf(text).status === 'current')
  unlinkSync(join(repo, 'src', 'exists.ts'))
  const gone = stateOf(text)
  check('deleted: needs-review, the path named', gone.status === 'needs-review' && j(gone.missingPaths) === j(['src/exists.ts']), j(gone))
  writeFileSync(join(repo, 'src', 'exists.ts'), 'export {}\n')
  check('restored: current again, nothing retracted', stateOf(text).status === 'current')
}

section('§7 a pinned fact keeps its confidence whatever its paths do: review evidence, never a retraction')
{
  const pinned = stateOf('the pinned rule names src/gone.ts', { seq: 9, pinned: true })
  check('confidence stays 1 and the status is needs-review with the path named', pinned.confidence === 1 && pinned.status === 'needs-review' && j(pinned.missingPaths) === j(['src/gone.ts']), j(pinned))
}

section('§8 at session start a fact whose cited path is gone yields its room to a fresh one; an external citation never does')
const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const GONE_FACT = 'quartz rotation: the quartz keys rotate in src/gone.ts on the quartz rotation night'
const FRESH_FACT = `the quartz rotation moved to src/exists.ts on the owner's word; the nightly run is gone and the rotation ledger is written by the morning job ${'(the ledger line names the key, the holder, the time and the receipt) '.repeat(11).trim()}`
const EXTERNAL_FACT = 'quartz rotation: the quartz gate script is lead-scripts/linux-gate/linux-gate-b29.sh on the quartz box'
frozen = T - 2 * DAY
appendObservation({ text: GONE_FACT, source: 'proof', topicHint: 'quartz' }, dir)
appendObservation({ text: 'the amber archive is kept offline', source: 'proof', topicHint: 'amber' }, dir)
appendObservation({ text: FRESH_FACT, source: 'proof', topicHint: 'quartz' }, dir)
frozen = T - 1 * DAY
const landed = maybeConsolidate({ force: true, dir, now: new Date(frozen) })
check('the two quartz facts and the amber one landed through the real road', landed.consolidated && landed.entries === 3, landed.reason)
frozen = T
const seqOf = (text: string): number => {
  for (const doc of listTopicDocs(dir)) for (const s of doc.sections) for (const e of s.entries) if (e.text === text) return e.seq
  throw new Error(`no fact reads ${text}`)
}
const goneSeq = seqOf(GONE_FACT)
const freshSeq = seqOf(FRESH_FACT)
const PK = mnemeProjectKey()
{
  const entries = new Map(listTopicDocs(dir).flatMap(doc => doc.sections.flatMap(s => s.entries.map(e => [e.seq, e] as const))))
  const goneState = refs.factMemoryState(entries.get(goneSeq)!, { pins: readPins(dir), usage: readUsage(dir), now: new Date(T), projectRoot: repo })
  check('the dense fact citing src/gone.ts reads needs-review, two days old', goneState.status === 'needs-review' && goneState.confidence > 0.9, j(goneState))
  const page = await knapsack.composeMemoryAtStart({ projectKey: PK, sessionId: 'review-session', root: repo, dir, now: new Date(T) })
  const status = knapsack.memoryAtStartStatus()
  check('the page composed with one fact in the thousand', page !== null && status !== null && status.rodeFacts === 1 && status.facts === 3, j(status))
  check('the fresh fact rides', page !== null && page.includes(`<seq=${freshSeq}>`), page ?? 'null')
  check('the fact whose path is gone is left for Recall (the base let it ride first by density)', page !== null && !page.includes(`<seq=${goneSeq}>`), page ?? 'null')
  const projectState = await readProjectState({ projectKey: PK, root: repo, now: new Date(T), ledger: [] })
  const unmarked = knapsack.composeStartPage({ dir, projectKey: PK, state: projectState, previous: [], limit: 1000, now: T, root: repo })
  check('the control: without the demotion the dense gone-path fact wins the thousand', unmarked.choice.rode[0]?.seq === goneSeq, j(unmarked.choice.rode.map(c => c.id)))
  const marked = knapsack.composeStartPage({ dir, projectKey: PK, state: unmarked.state, previous: [], limit: 4000, now: T, root: repo, stale: c => c.seq === goneSeq, mark: () => ` [${refs.memoryStatusWords(goneState)}]` })
  const goneRow = marked.choice.rode.find(c => c.seq === goneSeq)
  check('with room for both the demoted fact still rides, marked with the path that moved (an order, not a ban)', goneRow !== undefined && goneRow.block.endsWith(' [needs review — cited path moved: src/gone.ts]'), goneRow?.block ?? 'left')
}
{
  appendObservation({ text: EXTERNAL_FACT, source: 'proof', topicHint: 'quartz' }, dir)
  const landedMore = maybeConsolidate({ force: true, dir, now: new Date(T) })
  check('the external-citation fact landed', landedMore.consolidated && landedMore.entries === 1, landedMore.reason)
  const externalSeq = seqOf(EXTERNAL_FACT)
  const page = await knapsack.composeMemoryAtStart({ projectKey: PK, sessionId: 'review-session', root: repo, dir, now: new Date(T) })
  const lines = (page ?? '').split('\n')
  const externalAt = lines.findIndex(l => l.includes(`<seq=${externalSeq}>`))
  const goneAt = lines.findIndex(l => l.includes(`<seq=${goneSeq}>`))
  check('the dense external-citation fact is not demoted: it rides first by density, unmarked', externalAt >= 0 && !lines[externalAt]!.includes('needs review'), page ?? 'null')
  check('the gone-path fact rides in the room that is left, carrying the path that moved (an order, not a ban; the page prints by score)', goneAt >= 0 && lines[goneAt]!.endsWith('[needs review — cited path moved: src/gone.ts]'), page ?? 'null')
  pinFact(goneSeq, dir, new Date(T))
  const pinnedPage = await knapsack.composeMemoryAtStart({ projectKey: PK, sessionId: 'review-session', root: repo, dir, now: new Date(T) })
  const pinnedStatus = knapsack.memoryAtStartStatus()
  check('pinned, the gone-path fact leaves the knapsack for the pinned shelf: it is no candidate any more and no mark is written anywhere', pinnedPage !== null && pinnedStatus !== null && pinnedStatus.facts === 3 && readPins(dir).some(p => p.seq === goneSeq) && !pinnedPage.includes(`<seq=${goneSeq}>`) && !pinnedPage.includes('cited path moved'), pinnedPage ?? 'null')
}

rmSync(repo, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })
console.log('\n' + '═'.repeat(76))
console.log(`${failures === 0 ? 'PASS' : 'FAIL'} — prove-memory-cited-path-validator (${checks} checks, ${failures} failures)`)
process.exit(failures === 0 ? 0 : 1)
