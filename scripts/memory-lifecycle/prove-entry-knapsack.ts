#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
process.env.MERCURY_ENTRYPOINT = 'headless'
const HOME = mkdtempSync(join(tmpdir(), 'entry-knapsack-home-'))
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
const ROOT = join(import.meta.dir, '..', '..')

const PROMPT_SIZE_B33 = 7499

const usage = await import('../../src/mneme/mnemeUsage.ts')
const settings = await import('../../src/utils/settings/settings.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')

section('§1 the allowance for what rides at start beyond the pinned rules: a named constant under the .33 prompt size, a setting beside the pinned limit')
{
  check(`the default allowance is ${usage.START_TEXT_LIMIT_DEFAULT} characters (the owner's ruling), under the ${PROMPT_SIZE_B33} the .33 prompt sent before the first message`, usage.START_TEXT_LIMIT_DEFAULT === 4000 && usage.START_TEXT_LIMIT_DEFAULT <= PROMPT_SIZE_B33)
  check('the limit moves by a thousand and never below a thousand', usage.START_TEXT_LIMIT_MIN === 1000 && usage.START_TEXT_LIMIT_STEP === 1000)
  check('with nothing set the limit is the default', usage.startTextLimit() === usage.START_TEXT_LIMIT_DEFAULT)
  mkdirSync(HOME, { recursive: true })
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { startLimit: 12500 } }))
  resetSettingsCache()
  check('memory.startLimit in settings is the limit', usage.startTextLimit() === 12500, String(usage.startTextLimit()))
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { startLimit: 4321.9 } }))
  resetSettingsCache()
  check('a fraction is not an integer: the parser skips the value and the default stands', usage.startTextLimit() === usage.START_TEXT_LIMIT_DEFAULT && settings.parseSettingsFile(join(HOME, 'settings.json')).errors.some(e => e.path === 'memory.startLimit'), String(usage.startTextLimit()))
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { startLimit: 200 } }))
  resetSettingsCache()
  check('a value under the floor is ignored for the default', usage.startTextLimit() === usage.START_TEXT_LIMIT_DEFAULT, String(usage.startTextLimit()))
  const parsed = settings.parseSettingsFile(join(HOME, 'settings.json'))
  check('the settings parser names the fault: at least 1000', parsed.errors.some(e => e.path === 'memory.startLimit' && /at least 1000/.test(e.message)), j(parsed.errors))
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({ memory: { pinnedLimit: 23000 } }))
  resetSettingsCache()
  check('the pinned limit and the start limit are two settings: a raised pinned limit leaves the start limit at its default', usage.pinnedTextLimit() === 23000 && usage.startTextLimit() === usage.START_TEXT_LIMIT_DEFAULT)
  writeFileSync(join(HOME, 'settings.json'), JSON.stringify({}))
  resetSettingsCache()
  const schema = JSON.parse(readFileSync(join(ROOT, 'scripts/settings/settings-schema.json'), 'utf8')) as { properties?: { memory?: { properties?: Record<string, { type?: string; minimum?: number; description?: string }> } } }
  const row = schema.properties?.memory?.properties?.startLimit
  check('the generated settings schema carries memory.startLimit as an integer of at least 1000 with the default named and the pins outside it', row?.type === 'integer' && row.minimum === 1000 && /default 4000/.test(row.description ?? '') && /beyond the pinned rules, which always ride whole/.test(row.description ?? ''), j(row))
  const config = readFileSync(join(ROOT, 'src/components/Settings/Config.tsx'), 'utf8')
  check('the /config row sits in the pinned limit\'s family, says it is beyond the pins and writes the user setting', config.includes("id: 'memory.startLimit'") && config.includes("label: 'Memory at start, beyond the pins'") && config.includes("writeSource('userSettings', { memory: { startLimit: next } })"))
}

const realNow = Date.now
let frozen = Date.UTC(2026, 3, 1, 12, 0, 0, 0)
Date.now = () => frozen
const DAY = 86_400_000
const SESSION_NOW = Date.UTC(2026, 9, 13, 9, 0, 0, 0)

const knapsack = await import('../../src/mneme/entryKnapsack.ts')
const evidence = await import('../../src/mneme/memoryEvidence.ts')
const allowanceFor = (configured: number, eligible: number): number => Math.min(configured, 600 * Math.ceil(Math.log2(1 + eligible)))
const { retainItems, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
const { listArchiveDocs, listTopicDocs } = await import('../../src/mneme/mnemeLibrary.ts')
const { pinFact, readPins } = await import('../../src/mneme/mnemeUsage.ts')
const { readPinnedStatus, readFrontPage } = await import('../../src/mneme/mnemeFrontPage.ts')
const ledger = await import('../../src/mneme/ledger.ts')
type ProjectState = import('../../src/mneme/entryState.ts').ProjectState
type StartCandidate = import('../../src/mneme/entryKnapsack.ts').StartCandidate

const seqOf = (dir: string, text: string): number => {
  for (const doc of [...listTopicDocs(dir), ...listArchiveDocs(dir)]) for (const s of doc.sections) for (const e of s.entries) if (e.text === text) return e.seq
  throw new Error(`no fact reads ${text}`)
}
const retainAt = (dir: string, at: number, content: string, topic: string): void => {
  frozen = at
  _resetMemoryVerbSessionStateForTesting()
  const [outcome] = retainItems([{ content, topic }], { session: 'knapsack-proof' }, dir)
  if (outcome?.status !== 'stored') throw new Error(`retain refused: ${j(outcome)} for ${content}`)
}

try {
  section('§2 the greedy composer: the pins whole whatever their size, the rest within its own allowance by relevance per character, to the character, deterministic')
  {
    const dir = join(HOME, 'lib-composer')
    mkdirSync(dir, { recursive: true })
    const T = SESSION_NOW
    retainAt(dir, T - 200 * DAY, 'the quartz certificates are rotated on the first Tuesday of the month', 'quartz')
    retainAt(dir, T - 120 * DAY, 'the amber archive is kept offline and never synced', 'amber')
    retainAt(dir, T - 30 * DAY, 'the quartz rotation script lives in scripts/ops/rotate-quartz.sh', 'quartz')
    retainAt(dir, T - 20 * DAY, 'quartz certificates rotate on Tuesdays', 'quartz')
    retainAt(dir, T - 10 * DAY, 'the owner signs commits as Whq02 and never pushes from a lane', 'owner')
    retainAt(dir, T - 9 * DAY, 'the quartz certificates must be rotated by the certificate holder, with the rotation logged in the rotation ledger that the certificate holders keep beside the quartz rotation script, and the rotation announced on the certificates channel the same day', 'quartz')
    retainAt(dir, T - 5 * DAY, 'the quartz lane runs on branch lane/quartz-rotation', 'quartz')
    frozen = T - 1 * DAY
    const landed = maybeConsolidate({ force: true, dir, now: new Date(frozen) })
    check('the fixture library landed seven facts through the real road', landed.consolidated && landed.entries === 7, landed.reason)
    const ownerSeq = seqOf(dir, 'the owner signs commits as Whq02 and never pushes from a lane')
    pinFact(ownerSeq, dir, new Date(frozen), { asked: true })
    maybeConsolidate({ force: true, dir, now: new Date(frozen) })
    const pinned = readPinnedStatus(dir)
    check('one rule is pinned and the published status counts its characters', pinned !== null && pinned.pinned === 1 && pinned.used > 0 && readPins(dir).length === 1, j(pinned))
    const archived = listArchiveDocs(dir).flatMap(d => d.sections.flatMap(s => s.entries.map(e => e.text)))
    check('the tidy-up archived the two facts older than ninety days (they stay candidates: the page may carry them, Recall finds them)', archived.length === 2 && archived.some(t => t.startsWith('the amber archive')) && archived.some(t => t.startsWith('the quartz certificates are rotated on the first Tuesday')), j(archived))
    const PK = 'knapsack-project'
    const session = (sid: string, at: number, files: string[], handoff?: string): void => {
      frozen = at
      ledger.openEntry(PK, { sessionId: sid, model: 'claude-fable-5-1' })
      for (const file of files) ledger.recordFile(PK, sid, file)
      frozen = at + 60_000
      ledger.closeEntry(PK, sid, { outcome: 'closed', ...(handoff !== undefined ? { handoff } : {}) })
    }
    session('k-1', T - 40 * DAY, ['/proj/scripts/ops/rotate-quartz.sh'], 'The work: the quartz rotation.\nDecided: rotate on Tuesdays.\nStill to do: the amber mirror.')
    session('k-2', T - 3 * DAY, ['/proj/docs/amber.md'], 'The work: the amber archive.\nDecided: keep it offline.')
    session('k-3', T - 2 * DAY, ['/proj/src/quartz/rotate.ts'], 'The work: the quartz lane.\nStill to do: the rotation script.')
    const previous = ledger.readLedger(PK)
    const state: ProjectState = { branch: 'lane/quartz-rotation', files: ['src/quartz/rotate.ts', '/proj/src/quartz/rotate.ts'], note: { text: previous[2]!.handoff!.text, session: 3, at: previous[2]!.handoff!.at }, at: new Date(T).toISOString() }
    const compose = (limit: number, extra: Partial<Parameters<typeof knapsack.composeStartPage>[0]> = {}): ReturnType<typeof knapsack.composeStartPage> => knapsack.composeStartPage({ dir, projectKey: PK, state, previous, limit, now: T, root: '/proj', ...extra })
    const roomy = compose(4000)
    const text = roomy.text ?? ''
    console.log(text.split('\n').map(l => `    │ ${l}`).join('\n'))
    check('the block opens with its heading and one line that says what rode and what Recall still holds', text.startsWith(`${knapsack.MEMORY_AT_START_HEADING}\nMemory at start: 1 pinned rule (${knapsack.withThousands(pinned!.used)} characters) and `) && / of 6 facts and \d of 2 earlier notes most relevant to branch lane\/quartz-rotation, the files touched lately and the last note; Recall finds the rest\.$/m.test(text), text.split('\n')[1])
    check('the pinned rule is never a candidate: it rides whole in the Pinned section and nowhere in this block', !text.includes('Whq02') && roomy.status.facts === 6 && (readFrontPage(dir) ?? '').includes(`<seq=${ownerSeq}, asked for by the user>`))
    const rodeIds = roomy.choice.rode.map(c => c.id)
    check('every fact that overlaps with the state rides when the room allows (five facts and one note); the amber fact (no overlap with branch, files or note) never rides', rodeIds.length === 6 && !rodeIds.includes(`seq:${seqOf(dir, 'the amber archive is kept offline and never synced')}`) && roomy.choice.left.every(c => c.score === 0 || c.kind === 'handoff'), j(rodeIds))
    check('the facts print by score, most relevant first; the branch fact leads', text.indexOf('lane/quartz-rotation <seq=') >= 0 && text.indexOf('rotate on Tuesdays <seq=') >= 0 && text.indexOf('lane/quartz-rotation <seq=') < text.indexOf('rotate on Tuesdays <seq=') && roomy.choice.rode[0]!.text.includes('lane/quartz-rotation'), j(roomy.choice.rode.map(c => [c.id, c.score.toFixed(3)])))
    const fresh = roomy.choice.rode.find(c => c.text === 'quartz certificates rotate on Tuesdays')!
    const old = roomy.choice.rode.find(c => c.text.startsWith('the quartz certificates are rotated on the first Tuesday'))!
    check('a fresh fact outscores an old one on the same words (the ninety-day recency of the search lane)', fresh.score > old.score, `${fresh.score.toFixed(3)} vs ${old.score.toFixed(3)}`)
    const noteRode = roomy.choice.rode.filter(c => c.kind === 'handoff')
    const gradedNote = ['The work: the quartz rotation.', 'Decided: rotate on Tuesdays.', 'Still to do: the amber mirror.'].map(line => `${evidence.HANDOFF_GRADE} ${line}`).join('\n')
    check('the earlier note that overlaps rides word for word under its own heading with its session and time, every line graded as a model-authored note; the last note never does (it rides on the lineage page as today)', noteRode.length === 1 && noteRode[0]!.session === 1 && text.includes(`${knapsack.EARLIER_NOTE_HEADING} (session 1, `) && text.includes(gradedNote) && !text.includes('The work: the quartz lane.'), j(noteRode.map(c => c.session)))
    check('the allowance is respected to the character: every block that rode fits in it, and the pinned characters are not counted against it', roomy.choice.used <= 4000 && roomy.choice.used === roomy.choice.rode.reduce((n, c) => n + c.chars, 0) && roomy.choice.pinnedChars === pinned!.used, `${pinned!.used} beside ${roomy.choice.used}`)
    const byDensity = [...roomy.choice.rode].sort((a, b) => b.density - a.density)
    const first = byDensity[0]!
    const exact = compose(first.chars)
    const short = compose(first.chars - 1)
    check('at the character: an allowance that fits the densest block exactly takes it; one character less leaves it out and a smaller block that fits rides instead', exact.choice.rode.length === 1 && exact.choice.rode[0]!.id === first.id && !short.choice.rode.some(c => c.id === first.id) && short.choice.rode.every(c => c.chars < first.chars) && short.choice.used <= first.chars - 1, j([exact.choice.rode.map(c => c.id), short.choice.rode.map(c => c.id)]))
    const long = roomy.choice.rode.find(c => c.text.startsWith('the quartz certificates must be rotated by the certificate holder'))!
    check('relevance per character: the long fact scores high but its density is below the short facts, so it is chosen after them', long.score >= fresh.score * 0.5 && long.density < fresh.density, `${long.density.toFixed(4)} vs ${fresh.density.toFixed(4)}`)
    const tight = compose(fresh.chars + 2)
    check('with room for one short block, a smaller block rides and the long one is left for Recall', tight.choice.rode.length >= 1 && tight.choice.rode.every(c => c.chars <= fresh.chars + 2) && tight.choice.left.some(c => c.id === long.id), j(tight.choice.rode.map(c => [c.id, c.chars])))
    const under = compose(pinned!.used - 1)
    check('the pins never starve the rest: an allowance smaller than the pinned characters still carries what fits in it, and the pins ride whole beside it', under.choice.rode.length >= 1 && under.choice.used <= pinned!.used - 1 && under.choice.pinnedChars === pinned!.used && (under.text ?? '').split('\n')[1]!.startsWith(`Memory at start: 1 pinned rule (${knapsack.withThousands(pinned!.used)} characters) and `), (under.text ?? '').split('\n')[1])
    const top = roomy.choice.rode[0]!
    const staleTop = compose(top.chars + 1, { stale: (c: StartCandidate) => c.id === top.id })
    check('a stale fact ranks below every fresh one: marked stale, the best-scoring fact yields its room to a fresh fact', staleTop.choice.rode.length >= 1 && !staleTop.choice.rode.some(c => c.id === top.id) && staleTop.choice.left.some(c => c.id === top.id && c.score > 0), j(staleTop.choice.rode.map(c => c.id)))
    const staleAll = compose(4000, { stale: () => true })
    check('stale facts still ride when nothing fresh wants the room (stale is an order, not a ban)', staleAll.choice.rode.length === roomy.choice.rode.length, j(staleAll.choice.rode.map(c => c.id)))
    check('the same inputs compose the same page twice', compose(4000).text === text && j(compose(4000).choice.rode.map(c => c.id)) === j(rodeIds))
    const blank = compose(4000, { state: { branch: null, files: [], note: null, at: state.at } })
    check('with no branch, no touched file and no note, nothing rides and the line says what the facts wait for', blank.choice.rode.length === 0 && (blank.text ?? '').split('\n')[1] === `Memory at start: 1 pinned rule (${knapsack.withThousands(pinned!.used)} characters); the 6 facts and 2 earlier notes wait for a branch, touched files or a note to match against; Recall finds them.`, (blank.text ?? '').split('\n')[1])
    const branchOnly = compose(4000, { state: { branch: 'lane/quartz-rotation', files: [], note: null, at: state.at } })
    check('the line names only the parts of the state that exist', /most relevant to branch lane\/quartz-rotation; Recall finds the rest\.$/m.test(branchOnly.text ?? ''), (branchOnly.text ?? '').split('\n')[1])
    const emptyDir = join(HOME, 'lib-empty')
    mkdirSync(emptyDir, { recursive: true })
    const nothing = knapsack.composeStartPage({ dir: emptyDir, projectKey: 'never', state, previous: [], limit: 4000, now: T, root: '/proj' })
    check('an empty library with no earlier note composes no block at all', nothing.text === null && nothing.status.facts === 0 && nothing.status.notes === 0 && nothing.status.pending === 0)
    check('the home row on an empty library says there is nothing on record yet', knapsack.memoryAtStartRowWords(nothing.status) === 'nothing on record yet', knapsack.memoryAtStartRowWords(nothing.status))
    const pendingDir = join(HOME, 'lib-pending')
    mkdirSync(pendingDir, { recursive: true })
    retainItems([{ content: 'this project tests with pytest', topic: 'testing' }, { content: 'the deploy goes to a Raspberry Pi every Friday', topic: 'deployment' }], { session: 'knapsack-proof' }, pendingDir)
    const pendingOnly = knapsack.composeStartPage({ dir: pendingDir, projectKey: 'never', state, previous: [], limit: 4000, now: T, root: '/proj' })
    check('two facts still pending: the line paints even though nothing rode, and names them', pendingOnly.text === `${knapsack.MEMORY_AT_START_HEADING}\nMemory at start: no pinned rule; nothing rode (2 facts pending); Recall finds them.` && pendingOnly.status.pending === 2, pendingOnly.text ?? 'null')
    check('the home row says the same in its own words', knapsack.memoryAtStartRowWords(pendingOnly.status) === 'nothing rode at start (2 facts pending); Recall finds them', knapsack.memoryAtStartRowWords(pendingOnly.status))
    check('the home row with pins and facts that rode says what rode and that Recall finds the rest', knapsack.memoryAtStartRowWords(roomy.status) === '1 pinned rule and 5 of 6 facts and 1 of 2 earlier notes rode at start; Recall finds the rest', knapsack.memoryAtStartRowWords(roomy.status))
    check('the home row with pins and nothing else on record says nothing else rode', knapsack.memoryAtStartRowWords({ ...nothing.status, pinnedCount: 2, pending: 1 }) === '2 pinned rules; nothing else rode at start (1 fact pending); Recall finds them')
    const status = roomy.status
    const eligible = roomy.choice.rode.length + roomy.choice.left.filter(c => c.score > 0).length
    check('the status the /config row reads carries the effective allowance (the configured 4,000 scaled down by the eligible records: 600 × ⌈log₂(1 + eligible)⌉), the pinned characters, what rode and the pool', status.limit === allowanceFor(4000, eligible) && status.limit === 1800 && status.pinnedChars === pinned!.used && status.rodeFacts === 5 && status.facts === 6 && status.rodeNotes === 1 && status.notes === 2 && status.used === roomy.choice.used, j({ status, eligible }))
  }

  section('§3 the wiring: one memoized section between the memory page and the lineage page, keyed on the session and the preview/request distinction alone so the first real request composes it once and the prefix then stands')
  {
    const prompts = readFileSync(join(ROOT, 'src/constants/prompts.ts'), 'utf8')
    const memoryAt = prompts.indexOf("systemPromptSection('memory', () => loadMemoryPrompt())")
    const startAt = prompts.indexOf("keyedSystemPromptSection('memory_at_start', () => memoryAtStartKey(memoryTask), () => memoryAtStartForSession(memoryTask))")
    const lineageAt = prompts.indexOf("'entry_page'")
    check('the memory-at-start section is a memoized section keyed on the session and the request/preview distinction only (never cache-breaking, never re-keyed per turn) between the memory section and the entry page', memoryAt >= 0 && startAt > memoryAt && lineageAt > startAt && !prompts.includes("DANGEROUS_uncachedSystemPromptSection('memory_at_start'") && !prompts.includes("DANGEROUS_uncachedSystemPromptSection(\n      'memory_at_start'"), j([memoryAt, startAt, lineageAt]))
    const contract = readFileSync(join(ROOT, 'src/prompt/behaviourContract.ts'), 'utf8')
    check('the section declares its owner beside the memory section', contract.includes("['dynamic:memory_at_start', 'src/mneme/entryKnapsack.ts']"))
    const doctrine = readFileSync(join(ROOT, 'src/constants/subagentDoctrine.ts'), 'utf8')
    check('crewmates and sub-agents keep the front page alone (their prompts are unchanged by this block)', !doctrine.includes('entryKnapsack') && !doctrine.includes('composeMemoryAtStart'))
  }

  section('§4 the block rides the real system prompt between the Pinned section and the lineage page, composed once; a file touched later never moves it')
  {
    const { spawnSync } = await import('node:child_process')
    const { realpathSync } = await import('node:fs')
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'entry-knapsack-repo-')))
    const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    const git = (...args: string[]): void => {
      const run = spawnSync('git', ['-c', 'user.name=proof', '-c', 'user.email=proof@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
      if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
    }
    git('init', '-q', '-b', 'lane/garnet-ledger')
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'ledgerView.ts'), 'export const view = 1\n')
    git('add', '.')
    git('commit', '-q', '-m', 'first')
    const state = await import('../../src/bootstrap/state.ts')
    process.chdir(repo)
    state.setOriginalCwd(repo)
    state.setCwdState(repo)
    state.setProjectRoot(repo)
    const { mnemeProjectKey } = await import('../../src/mneme/paths.ts')
    const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
    const dir = mnemeLibraryDir()
    mkdirSync(dir, { recursive: true })
    check('the library of the scratch project lives under the scratch home, never the owner\'s', dir.startsWith(HOME), dir)
    const T = SESSION_NOW
    retainAt(dir, T - 12 * DAY, 'the garnet ledger view is rendered by src/ledgerView.ts', 'garnet')
    retainAt(dir, T - 11 * DAY, 'the opal export runs nightly and is nobody\'s concern here', 'opal')
    retainAt(dir, T - 10 * DAY, 'every lane branch is cut from the fold tip', 'lanes')
    frozen = T - 1 * DAY
    const landed = maybeConsolidate({ force: true, dir, now: new Date(frozen) })
    check('three facts landed for the scratch project', landed.consolidated && landed.entries === 3, landed.reason)
    pinFact(seqOf(dir, 'every lane branch is cut from the fold tip'), dir, new Date(frozen), { asked: true })
    maybeConsolidate({ force: true, dir, now: new Date(frozen) })
    const PK = mnemeProjectKey()
    frozen = T - 2 * DAY
    ledger.openEntry(PK, { sessionId: 'g-1', model: 'claude-fable-5-1' })
    ledger.recordFile(PK, 'g-1', join(repo, 'src', 'ledgerView.ts'))
    ledger.closeEntry(PK, 'g-1', { outcome: 'closed', handoff: 'The work: the garnet ledger view.' })
    frozen = T
    const { getSystemPrompt } = await import('../../src/constants/prompts.ts')
    const { clearSystemPromptSections } = await import('../../src/constants/systemPromptSections.ts')
    const { markSessionNonInteractive, resetRuntimePostureForTest } = await import('../../src/utils/cockpit/runtimePosture.ts')
    const { resetHarnessMapForTest } = await import('../../src/utils/cockpit/harnessMap.ts')
    delete process.env.MERCURY_BARE
    delete process.env.MERCURY_PROMPT_LAYERS
    delete process.env.MERCURY_PROMPT_REPLACE_FILE
    resetRuntimePostureForTest()
    resetHarnessMapForTest()
    state.setAskChannel('none')
    markSessionNonInteractive('default')
    clearSystemPromptSections()
    const tools = ['Read', 'Edit', 'Bash', 'Retain', 'Recall'].map(name => ({ name })) as never
    const first = (await getSystemPrompt(tools, 'claude-fable-5-1', [])).join('\n\n')
    const at = (needle: string): number => first.indexOf(needle)
    check('the prompt carries the memory page, then the block, then the lineage page, then the environment, in that order', at('# Memory\n') >= 0 && at('## Pinned') > at('# Memory\n') && at(knapsack.MEMORY_AT_START_HEADING) > at('## Pinned') && at('# Lineage') > at(knapsack.MEMORY_AT_START_HEADING) && at('# Environment') > at('# Lineage'), j([at('# Memory\n'), at('## Pinned'), at(knapsack.MEMORY_AT_START_HEADING), at('# Lineage'), at('# Environment')]))
    const block = first.slice(at(knapsack.MEMORY_AT_START_HEADING), at('# Lineage'))
    console.log(block.trimEnd().split('\n').map(l => `    │ ${l}`).join('\n'))
    const factGrade = evidence.memoryGrade({ id: 'seq:1', dir })
    check('the block names the scratch branch and carries the fact that names the touched file behind its evidence grade; the opal fact (no overlap) stays a Recall away; the pinned rule rides in Pinned, not here', block.includes('most relevant to branch lane/garnet-ledger, the files touched lately and the last note') && block.includes(`- ${factGrade} the garnet ledger view is rendered by src/ledgerView.ts <seq=`) && factGrade.startsWith('[fact · ') && !block.includes('opal') && !block.includes('fold tip') && first.includes(' every lane branch is cut from the fold tip <seq='), block)
    check('the block appears once in the prompt', first.split(knapsack.MEMORY_AT_START_HEADING).length === 2)
    check('the lineage page still carries the last note as today (the block holds no earlier note: there is only the one)', first.includes('## The last note left (session 1, ') && first.includes('The work: the garnet ledger view.') && !block.includes(knapsack.EARLIER_NOTE_HEADING))
    const status = knapsack.memoryAtStartStatus()
    check('the status the /config row reads was set by the composition: one eligible record scales the default allowance to 600', status !== null && status.rodeFacts === 1 && status.facts === 2 && status.pinnedCount === 1 && status.limit === allowanceFor(usage.START_TEXT_LIMIT_DEFAULT, 1) && status.limit === 600, j(status))
    writeFileSync(join(repo, 'src', 'ledgerView.ts'), 'export const view = 2\n')
    writeFileSync(join(repo, 'src', 'opalExport.ts'), 'export const opal = 1\n')
    retainItems([{ content: 'the opal export writes to the garnet ledger too', topic: 'opal' }], { session: 'knapsack-proof' }, dir)
    maybeConsolidate({ force: true, dir, now: new Date(frozen) })
    const second = (await getSystemPrompt(tools, 'claude-fable-5-1', [])).join('\n\n')
    check('a file touched and a fact saved mid-session never move the sent prompt: the second composition is byte-identical (the section is memoized; the next session reads the new state)', second === first, `${first.length} vs ${second.length}`)
    clearSystemPromptSections()
    const next = (await getSystemPrompt(tools, 'claude-fable-5-1', [])).join('\n\n')
    check('at a lawful prefix boundary the block recomposes from the state as it stands then', next !== first && next.includes('opal export writes to the garnet ledger'), next.slice(next.indexOf(knapsack.MEMORY_AT_START_HEADING), next.indexOf('# Lineage')))
  }

  section('§5 twelve recorded session states (synthetic, from the fixture) replayed: what rides and what is left out, pinned as a table')
  {
    interface FixtureFact { topic: string; daysAgo: number; text: string; pin?: boolean; asked?: boolean }
    interface FixtureNote { daysAgo: number; text: string }
    interface FixtureState { id: number; name: string; branch: string | null; files: string[]; limit: number; stale?: string[]; facts: FixtureFact[]; notes: FixtureNote[]; expect: { rides: string[]; left: string[] } }
    interface Fixture { synthetic: boolean; now: string; states: FixtureState[] }
    const fixturePath = join(ROOT, 'scripts/memory-lifecycle/fixtures/entry-knapsack/states.json')
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture
    const T = Date.parse(fixture.now)
    check('the fixture is twelve states and says it is synthetic', fixture.synthetic === true && fixture.states.length === 12 && Number.isFinite(T))
    const { lastNoteOf } = await import('../../src/mneme/entryState.ts')
    const dirOf = (s: FixtureState): string => join(HOME, 'states', String(s.id))
    const retains: Array<{ at: number; state: FixtureState; fact: FixtureFact }> = []
    for (const s of fixture.states) {
      mkdirSync(dirOf(s), { recursive: true })
      for (const fact of s.facts) retains.push({ at: T - fact.daysAgo * DAY, state: s, fact })
    }
    retains.sort((a, b) => a.at - b.at || a.state.id - b.state.id)
    for (const row of retains) retainAt(dirOf(row.state), row.at, row.fact.text, row.fact.topic)
    const record = process.env.ENTRY_KNAPSACK_RECORD === '1'
    const expectations: Record<string, { rides: string[]; left: string[] }> = {}
    const table: string[] = ['| # | state | branch | pinned | limit | rode (characters) | left for Recall |', '| --- | --- | --- | --- | ---: | --- | --- |']
    for (const s of fixture.states) {
      const dir = dirOf(s)
      frozen = T - 3_600_000
      const landed = s.facts.length > 0 ? maybeConsolidate({ force: true, dir, now: new Date(frozen) }) : null
      check(`state ${s.id}: the library landed ${s.facts.length} facts through the real road`, s.facts.length === 0 || (landed !== null && landed.consolidated && landed.entries === s.facts.length), landed?.reason ?? '')
      for (const fact of s.facts) if (fact.pin) pinFact(seqOf(dir, fact.text), dir, new Date(frozen), { asked: fact.asked === true })
      if (s.facts.some(f => f.pin)) maybeConsolidate({ force: true, dir, now: new Date(frozen) })
      const PK = `knapsack-state-${s.id}`
      s.notes.forEach((note, i) => {
        frozen = T - note.daysAgo * DAY
        ledger.openEntry(PK, { sessionId: `${PK}-${i + 1}`, model: 'claude-fable-5-1' })
        frozen += 60_000
        ledger.closeEntry(PK, `${PK}-${i + 1}`, { outcome: 'closed', handoff: note.text })
      })
      frozen = T
      const previous = ledger.readLedger(PK)
      const state: ProjectState = { branch: s.branch, files: s.files, note: lastNoteOf(previous), at: fixture.now }
      const stale = s.stale !== undefined ? (c: StartCandidate): boolean => s.stale!.includes(c.text) : undefined
      const compose = (): ReturnType<typeof knapsack.composeStartPage> => knapsack.composeStartPage({ dir, projectKey: PK, state, previous, limit: s.limit, now: T, root: '/proj', stale })
      const page = compose()
      const again = compose()
      const pins = readPinnedStatus(dir)
      const pinnedChars = pins?.used ?? 0
      const rides = page.choice.rode.map(c => c.id)
      const left = page.choice.left.map(c => c.id)
      console.log(`\n  state ${s.id} — ${s.name}`)
      console.log((page.text ?? '(no block)').split('\n').map(l => `    │ ${l}`).join('\n'))
      check(`state ${s.id}: the pinned rules ride whole whatever the limit — the status counts every pin's characters as the Pinned section does`, page.status.pinnedCount === s.facts.filter(f => f.pin).length && page.status.pinnedChars === pinnedChars, j(page.status))
      check(`state ${s.id}: the allowance is respected to the character and the pins are not counted against it`, page.choice.used <= s.limit && page.choice.used === page.choice.rode.reduce((n, c) => n + c.chars, 0), `${page.choice.used} vs ${s.limit} (pins ${pinnedChars} beside)`)
      check(`state ${s.id}: nothing rides without a word in common with the state`, page.choice.rode.every(c => c.score > 0))
      check(`state ${s.id}: twice the same`, again.text === page.text && j(again.choice.rode.map(c => c.id)) === j(rides))
      if (page.text !== null) {
        check(`state ${s.id}: the line says what rode`, page.text.split('\n')[1]!.startsWith('Memory at start: ') && !page.text.includes('fill the'))
      }
      expectations[String(s.id)] = { rides, left }
      if (!record) check(`state ${s.id}: what rides and what is left out are the pinned table's`, j(rides) === j(s.expect.rides) && j(left) === j(s.expect.left), `rides ${j(rides)} left ${j(left)}`)
      table.push(`| ${s.id} | ${s.name} | ${s.branch ?? '—'} | ${page.status.pinnedCount} (${pinnedChars}) | ${s.limit} | ${rides.length === 0 ? '—' : `${rides.join(', ')} (${page.choice.used})`} | ${left.length === 0 ? '—' : left.join(', ')} |`)
    }
    console.log('\n' + table.join('\n'))
    if (record) console.log('\nENTRY_KNAPSACK_RECORD expectations:\n' + JSON.stringify(expectations, null, 1))
  }
} finally {
  Date.now = realNow
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(` ✅ ENTRY KNAPSACK GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ ENTRY KNAPSACK RED (${failures} of ${checks} checks failed)`)
process.exit(1)
