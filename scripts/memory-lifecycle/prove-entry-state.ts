#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_ENTRYPOINT = 'headless'
const HOME = mkdtempSync(join(tmpdir(), 'entry-state-home-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_BARE

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const j = (v: unknown): string => JSON.stringify(v)

const realNow = Date.now
let frozen = Date.UTC(2026, 9, 13, 8, 0, 0, 0)
Date.now = () => frozen

const state = await import('../../src/mneme/entryState.ts')
const { lookupTokens, lookupTerms, scoreCandidates } = await import('../../src/mneme/mnemeLookup.ts')
type LookupCandidate = import('../../src/mneme/mnemeLookup.ts').LookupCandidate
const ledger = await import('../../src/mneme/ledger.ts')

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd: string, ...args: string[]): string => {
  const run = spawnSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
  return run.stdout
}
const candidate = (id: string, text: string): LookupCandidate => ({ id, text, signature: '', slug: 'proof', pagePath: '/proof', pending: false, time: '2026-10-12T00:00:00.000Z' })

try {
  section('§1 the words of the state: the branch name whole and in words, a file whole, relative, by name and in name words')
  {
    const lane = state.branchWords('lane/beta35-mneme-entry')
    check('a branch gives its whole name and its words of three letters or more', j(lane) === j(['lane/beta35-mneme-entry', 'lane', 'beta35', 'mneme', 'entry']), j(lane))
    check('working-35 gives the whole name and the word working (a two-digit word is no word); the chunker then drops working as a stop word and keeps the whole name', j(state.branchWords('working-35')) === j(['working-35', 'working']) && j(state.stateQueryChunks(state.branchWords('working-35'))) === j(['working-35']), j(state.branchWords('working-35')))
    const file = state.fileWords('/work/proj/src/mneme/entryPage.ts', '/work/proj')
    check('an absolute file under the root gives the absolute path, the relative path, the base name and the name words (camel case split)', j(file) === j(['/work/proj/src/mneme/entryPage.ts', 'src/mneme/entryPage.ts', 'entryPage.ts', 'entry', 'Page']), j(file))
    const outside = state.fileWords('/elsewhere/notes/plan-of-record.md', '/work/proj')
    check('a file outside the root gives no relative path; a kebab name splits into words', j(outside) === j(['/elsewhere/notes/plan-of-record.md', 'plan-of-record.md', 'plan', 'record']), j(outside))
    check('a relative path from the working tree gives itself, the base name and the words', j(state.fileWords('scripts/memory/prove-recall-ranking.ts', '/work/proj')) === j(['scripts/memory/prove-recall-ranking.ts', 'prove-recall-ranking.ts', 'prove', 'recall', 'ranking']))
    const units = state.stateUnits({ branch: 'working-35', files: ['src/a/deployGuide.ts'], note: { text: 'Decided: the quartz certificates rotate on Tuesdays.', session: 2, at: '2026-10-12T00:00:00.000Z' }, at: '2026-10-13T00:00:00.000Z' }, '/work/proj')
    check('the units are the branch words, the file words, then the note split on the lookup separators (punctuation dropped, words kept whole)', j(units) === j(['working-35', 'working', 'src/a/deployGuide.ts', 'deployGuide.ts', 'deploy', 'Guide', 'Decided', 'the', 'quartz', 'certificates', 'rotate', 'on', 'Tuesdays.']), j(units))
  }

  section('§2 the query chunks: sixteen stems at most per chunk, no stem twice, raw words only — the chunks together score every word of the state')
  {
    const words = Array.from({ length: 40 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}x`)
    const chunks = state.stateQueryChunks(words)
    check('forty distinct words give three chunks of sixteen, sixteen and eight stems', chunks.length === 3 && chunks.map(c => lookupTokens(c).length).join(',') === '16,16,8', j(chunks.map(c => lookupTokens(c).length)))
    const all = chunks.flatMap(c => lookupTokens(c))
    check('no stem appears in two chunks and every word is kept', new Set(all).size === all.length && all.length === 40, `${new Set(all).size} of ${all.length}`)
    const repeated = state.stateQueryChunks(['deploying', 'deployed', 'Deploy', 'certificates', 'certificate', 'the', 'an', 'ok'])
    check('words that share a stem count once (the first spelling kept); stop words and two-letter words drop', j(repeated) === j(['deploying certificates']), j(repeated))
    const spoken = state.stateQueryChunks(['successfully', 'successful', 'success'])
    check('a chunk carries raw words, never stems fed back to the stemmer (one pass: successfully → successful, successful → success — two stems, kept as two raw words that re-tokenize to the same two stems)', j(spoken) === j(['successfully successful']) && lookupTerms('successfully')[0] === 'successful' && lookupTerms('successful')[0] === 'success' && j(lookupTokens(spoken[0]!)) === j(['successful', 'success']), j(spoken))
    const pool = [candidate('a', 'the quartz certificates rotate on tuesdays'), candidate('b', 'the amber archives are kept offline'), candidate('c', 'wordy0x is the thirtieth word of the state')]
    const query = [...Array.from({ length: 30 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}x`), 'quartz', 'certificates']
    const chunked = state.stateQueryChunks(query)
    const sum = (id: string): number => chunked.reduce((n, chunk) => n + (scoreCandidates(chunk, pool, frozen).find(s => s.id === id)?.score ?? 0), 0)
    const single = scoreCandidates(query.join(' '), pool, frozen)
    check('a single capped call misses the words past the sixteenth: the quartz fact scores nothing there', (single.find(s => s.id === 'a')?.score ?? 0) === 0 && (single.find(s => s.id === 'c')?.score ?? 0) === 0, j(single.map(s => [s.id, s.score])))
    check('the chunk sum scores the quartz fact and the thirtieth word, and leaves the amber fact at nothing', sum('a') > 0 && sum('c') > 0 && sum('b') === 0, j(pool.map(p => [p.id, sum(p.id)])))
    const short = ['quartz', 'certificates', 'rotate']
    const whole = scoreCandidates(short.join(' '), pool, frozen).find(s => s.id === 'a')!.score
    const halves = [state.stateQueryChunks(short.slice(0, 1)), state.stateQueryChunks(short.slice(1))].flat()
    const split = halves.reduce((n, chunk) => n + scoreCandidates(chunk, pool, frozen).find(s => s.id === 'a')!.score, 0)
    check('the score is additive over chunks: two chunks of a short query sum to the one-call score', Math.abs(whole - split) < 1e-9, `${whole} vs ${split}`)
    check('an empty state gives no chunk', state.stateQueryChunks([]).length === 0 && state.stateQuery({ branch: null, files: [], note: null, at: '' }, null).length === 0)
  }

  section('§3 the state read from a scratch repository and a scratch ledger: the branch from HEAD, the files touched now and lately, the last note')
  {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'entry-state-repo-')))
    git(root, 'init', '-q', '-b', 'lane/proof-branch')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'kept.ts'), 'export const kept = 1\n')
    writeFileSync(join(root, 'src', 'changed.ts'), 'export const changed = 1\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'first')
    writeFileSync(join(root, 'src', 'changed.ts'), 'export const changed = 2\n')
    writeFileSync(join(root, 'fresh.md'), 'untracked\n')
    const KEY = 'entry-state-project'
    const session = (sid: string, files: string[], handoff?: string): void => {
      ledger.openEntry(KEY, { sessionId: sid, model: 'claude-fable-5-1' })
      for (const file of files) ledger.recordFile(KEY, sid, file)
      frozen += 60_000
      ledger.closeEntry(KEY, sid, { outcome: 'closed', ...(handoff !== undefined ? { handoff } : {}) })
      frozen += 60_000
    }
    session('s-1', ['/old/one.ts'], 'note one')
    session('s-2', ['/w/two.ts', '/w/shared.ts'])
    session('s-3', ['/w/three.ts', '/w/shared.ts'], 'The work: the probe.\nStill to do: the second probe.')
    session('s-4', ['/w/four.ts'])
    ledger.openEntry(KEY, { sessionId: 's-5', model: 'claude-fable-5-1' })
    ledger.recordFile(KEY, 's-5', '/w/own.ts')
    const read = await state.readProjectState({ projectKey: KEY, sessionId: 's-5', root, now: new Date(frozen) })
    check('the branch is read from HEAD', read.branch === 'lane/proof-branch', j(read.branch))
    check('the working tree\'s modified and untracked files come first', read.files.slice(0, 2).join(',') === 'src/changed.ts,fresh.md' || read.files.slice(0, 2).join(',') === 'fresh.md,src/changed.ts', j(read.files))
    check('then the files of the last three sessions, most recent first, once each, never the session\'s own', read.files.slice(2).join(',') === '/w/four.ts,/w/three.ts,/w/shared.ts,/w/two.ts', j(read.files))
    check('the last note is the newest note left, with its session and time (session 4 left none, session 3 did)', read.note?.session === 3 && read.note.text === 'The work: the probe.\nStill to do: the second probe.' && read.note.at !== '', j(read.note))
    check('the session date is the clock', read.at === new Date(frozen).toISOString(), read.at)
    const again = await state.readProjectState({ projectKey: KEY, sessionId: 's-5', root, now: new Date(frozen) })
    check('the same inputs read the same state twice', j(again) === j(read))
    git(root, 'checkout', '-q', '--detach')
    const detached = await state.readProjectState({ projectKey: KEY, sessionId: 's-5', root, now: new Date(frozen) })
    check('a detached HEAD gives no branch; the files and the note still read', detached.branch === null && detached.files.length === read.files.length && detached.note?.session === 3, j(detached))
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'entry-state-plain-')))
    const noGit = await state.readProjectState({ projectKey: KEY, sessionId: 's-5', root: plain, now: new Date(frozen) })
    check('a directory that is no repository gives no branch and no working-tree files; the ledger\'s files remain', noGit.branch === null && noGit.files.join(',') === '/w/four.ts,/w/three.ts,/w/shared.ts,/w/two.ts', j(noGit))
    const nothing = await state.readProjectState({ projectKey: 'never-seen', sessionId: 's-1', root: plain, now: new Date(frozen) })
    check('a project with no record gives an empty state', nothing.branch === null && nothing.files.length === 0 && nothing.note === null, j(nothing))
    const chunks = state.stateQuery(read, root)
    const stems = chunks.flatMap(c => lookupTokens(c))
    check('the query of the read state carries the branch, the files and the note as the lookup stems them (lane, proof, branch, changed.ts, chang, w/three.ts, probe)', ['lane/proof-branch', 'lane', 'proof', 'branch', 'src/changed.ts', 'changed.ts', 'chang', 'fresh.md', 'fresh', 'w/three.ts', 'three.ts', 'three', 'probe', 'second'].every(word => stems.includes(word)), j(stems))
    check('every chunk holds at most sixteen stems', chunks.every(c => lookupTokens(c).length <= 16), j(chunks.map(c => lookupTokens(c).length)))
    check('the paths parse: a rename keeps the new name, a quoted path loses its quotes, a short line is skipped', j(state.parseStatusPaths(' M src/a.ts\nR  old.ts -> new.ts\n?? "sp ace.md"\n\n')) === j(['src/a.ts', 'new.ts', 'sp ace.md']))
  }
} finally {
  Date.now = realNow
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ ENTRY STATE GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ENTRY STATE RED (${failures} of ${checks} checks failed)`)
process.exit(1)
