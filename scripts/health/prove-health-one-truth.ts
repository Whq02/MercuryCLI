#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'health-one-truth-'))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_ANTHROPIC_OAUTH_BASE = 'http://127.0.0.1:1'
process.env.OPENAI_API_KEY = 'fixture-openai-key'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9/v1'
process.env.XAI_API_KEY = 'fixture-xai-key'
process.env.MERCURY_XAI_API_BASE = 'http://127.0.0.1:9'
process.env.MOONSHOT_API_KEY = 'fixture-moonshot-key'
process.env.MERCURY_MOONSHOT_API_BASE = 'http://127.0.0.1:9'
for (const k of ['MERCURY_HOME', 'CI', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'HUGGINGFACE_API_KEY', 'DEEPSEEK_API_KEY', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_API_KEY', 'MERCURY_LOCAL_BASE_URL']) delete process.env[k]
writeFileSync(join(daemonDir, 'control.key'), 'k'.repeat(64))
process.chdir(work)

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8')

section('§1 THE SIGN-IN VIEW — a family whose live catalogue is not fetched yet reads unfetched, so a cockpit that has fetched it and a daemon that has not still agree')
{
  const { composeSignInView, compareSignInViews } = await import('../../src/daemon/signInView.ts')
  const view = composeSignInView({ refresh: true })
  const openai = view.families.find(f => f.family === 'openai')
  check('the OpenAI credential is present and offers no usable row yet (the catalogue base is a closed port: nothing fetched)', openai?.credentialed === true && openai.usable === false, j(openai))
  check(`the reason is the catalogue's own pending word: ${openai?.why ?? ''}`, /live catalogue not fetched yet/.test(openai?.why ?? ''), j(openai))
  check('RED ON THE BASE: the family is marked unfetched (the Air read "GPT-6 Astra: live catalogue not fetched yet — retry shortly" with no such mark)', openai?.unfetched === true, j(openai))
  const cockpit = { ...view, families: view.families.map(f => (f.family === 'openai' ? { family: 'openai', credentialed: true, usable: true, row: 'GPT-6 Astra', why: 'the newest row this sign-in can use' } : f)) } as never
  const gaps = compareSignInViews(cockpit, view)
  check('RED ON THE BASE: a cockpit that has fetched the catalogue and a daemon that has not disagree on nothing (the Air read FAULT: daemon ≠ client — openai)', gaps.length === 0, j(gaps))
  const options = (await import('../../src/utils/model/modelOptions.ts')).getModelOptions()
  const gptRows = options.filter(o => o.group !== undefined && /gpt|openai/i.test(o.group) && !String(o.value).startsWith('__'))
  check('every pending GPT lineup row carries the typed pending mark beside its words', gptRows.length > 0 && gptRows.every(o => o.unavailable !== undefined && o.cataloguePending === true), j(gptRows.map(o => [o.value, o.unavailable, o.cataloguePending])))
  const computed = read('src/utils/model/computedDefault.ts')
  check('the verdict reads the typed mark, never the reason\'s words', computed.includes("familyRows.every(option => option.cataloguePending === true) ? { unfetched: true } : {}"))

  section('§1b THE KEY LANES — a key lane whose account list no process has read yet (xAI, Moonshot: a fresh `mercury health` never kicks the read) is the same timing gap, never a FAULT against a daemon that has read it')
  for (const [family, row] of [['xai', 'Grok 4.7'], ['moonshot', 'K3']] as const) {
    const mine = view.families.find(f => f.family === family)
    check(`${family}: the key is present and the list is not read yet (${mine?.why ?? ''})`, mine?.credentialed === true && mine.usable === false && /model list has not been read$/.test(mine.why ?? ''), j(mine))
    check(`RED ON THE BASE: ${family} is marked unfetched (the lead's live check read \`mercury health\` FAULT: daemon ≠ client — ${family}: client "the account's model list has not been read" vs daemon "usable (${row})")`, mine?.unfetched === true, j(mine))
    const daemon = { ...view, families: view.families.map(f => (f.family === family ? { family, credentialed: true, usable: true, row, why: 'the newest row this sign-in can use (the live catalogue)' } : f)) } as never
    check(`RED ON THE BASE: a daemon that has read the ${family} list and a client that has not disagree on nothing`, compareSignInViews(view, daemon).length === 0, j(compareSignInViews(view, daemon)))
  }
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  const refused = composeSignInView({ refresh: true }).families.find(f => f.family === 'xai')
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  check(`teeth: a list the gate refuses to read is not a timing gap — the mark is absent (${refused?.why ?? ''})`, refused?.credentialed === true && refused.usable === false && refused.unfetched !== true, j(refused))
  const daemonRead = { ...view, families: view.families.map(f => (f.family === 'xai' ? { family: 'xai', credentialed: true, usable: true, row: 'Grok 4.7', why: 'the newest row this sign-in can use (the live catalogue)' } : f)) } as never
  check('teeth: that refused read still reads as a difference against a daemon with the list', compareSignInViews({ ...view, families: view.families.map(f => (f.family === 'xai' ? refused! : f)) } as never, daemonRead).length === 1)
}

section('§2 EDIT OUTCOMES — the cockpit\'s /health counts the SESSION\'s edits (the runner\'s ledger through the session facts), not its own process\'s')
{
  const { DaemonSessionConnector } = await import('../../src/services/engine-connector/daemonConnector.ts')
  const { publishSessionFacts, readSessionFacts } = await import('../../src/services/engine-connector/seatProjections.ts')
  const { setFocusedSessionConnector, releaseFocusedSessionConnector } = await import('../../src/services/engine-connector/focusedConnector.ts')
  const { runHealthReport } = await import('../../src/utils/healthReport.ts')
  const SESSION = '550e8400-e29b-41d4-a716-4466554401e6'
  const record = { sessionId: SESSION, runnerId: 'concourse-w1', title: 'tally', projectLabel: 'project', workspaceId: work, home }
  const base = { schema: 1 as const, sessionId: SESSION, atMs: Date.now(), model: { effective: 'claude-sonnet-5-5', setting: null }, usage: { totalCostUSD: 0, totalAPIDurationMs: 0, totalDurationMs: 0, totalLinesAdded: 0, totalLinesRemoved: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadInputTokens: 0, totalCacheCreationInputTokens: 0, hasUnknownModelCost: false }, identity: { firstPartyApi: false, consoleBilling: false, claudeAiBilling: false, accountEmail: null }, skills: [], mcp: [], permissionMode: 'default' as const, workspace: { cwd: work, originalCwd: work, projectRoot: work, instructionRoots: [] }, queue: [], pendingModel: null, busy: false }
  const untilPublished = async (want: (facts: Record<string, unknown> | null) => boolean): Promise<void> => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      if (want(readSessionFacts(SESSION, daemonDir) as Record<string, unknown> | null)) return
      await new Promise(r => setTimeout(r, 10))
    }
  }
  const rowOf = async (): Promise<{ status: string; evidence?: unknown } | undefined> => {
    const cert = await runHealthReport({ depth: 'fast' })
    const all = [...((cert as { checks?: Array<{ id: string; status: string; evidence?: unknown }> }).checks ?? []), ...((cert as { sections?: Array<{ checks: Array<{ id: string; status: string; evidence?: unknown }> }> }).sections ?? []).flatMap(s => s.checks)]
    return all.find(c => c.id === 'edit-outcomes')
  }
  publishSessionFacts({ ...base, editOutcomes: [{ model: 'claude-sonnet-5-5', surface: 'edit', outcome: 'applied', count: 7 }, { model: 'claude-sonnet-5-5', surface: 'edit', outcome: 'anchor-stale', count: 1 }, { model: 'claude-opus-5-5', surface: 'edit', outcome: 'applied', count: 2 }] } as never, daemonDir)
  await untilPublished(facts => Array.isArray(facts?.editOutcomes))
  const seat = new DaemonSessionConnector(record)
  check('the connector carries the session\'s edit rows from the facts', (seat.editOutcomes?.() ?? []).length === 3, j(seat.editOutcomes?.()))
  setFocusedSessionConnector(seat)
  const focused = await rowOf()
  check('RED ON THE BASE: with a daemon-hosted chat focused, the Edit outcomes row counts the session\'s nine edits (the Air read "no edit attempts this session")', focused?.status === 'info' && /claude-sonnet-5-5: 8 attempt\(s\), 7 applied, top failure anchor-stale ×1/.test(String(focused?.evidence)) && /claude-opus-5-5: 2 attempt\(s\), 2 applied/.test(String(focused?.evidence)), j(focused))
  publishSessionFacts(base as never, daemonDir)
  await untilPublished(facts => facts !== null && !Array.isArray(facts.editOutcomes))
  const older = new DaemonSessionConnector(record)
  setFocusedSessionConnector(older)
  const olderRow = await rowOf()
  check('a runner that answers no ledger (an older runner) reads off and says so — never a false zero', olderRow?.status === 'off' && /no edit ledger/.test(String(olderRow?.evidence)), j(olderRow))
  releaseFocusedSessionConnector()
  const plain = await rowOf()
  check('with no chat focused the row reads this process\'s own ledger (no attempts here)', plain?.status === 'ok' && String(plain?.evidence) === 'no edit attempts this session', j(plain))
  const run = read('src/cli/run.ts')
  check('the runner answers its edit ledger in the session facts', run.includes('editOutcomes: editOutcomeRows(processMainOwner())'))
  const wire = read('src/services/engine-connector/seatWire.ts')
  check('the wire carries the rows as edit_outcomes', wire.includes("editOutcomes: 'edit_outcomes'"))
}

console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ prove-health-one-truth: ${failures} failure(s) — scratch kept at ${SCRATCH}`)
  process.exit(1)
}
console.log('✅ prove-health-one-truth: the sign-in row reads a pending catalogue as agreement and the Edit outcomes row counts the session\'s own edits')
process.exit(0)
