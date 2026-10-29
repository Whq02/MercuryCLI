#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findOnPath } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { inputLine, isOutcome, parseFrame, promptRow } from '../lib/rows.ts'

const ROOT = join(import.meta.dir, '..', '..')
const DIST = join(ROOT, 'dist', 'mercury.mjs')
const scratchRoot = process.env.TMPDIR ?? tmpdir()
const inProcessHome = realpathSync(mkdtempSync(join(scratchRoot, 'rule-sovereign-src-')))
process.env.MERCURY_CONFIG_DIR = inProcessHome
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const j = (v: unknown): string => JSON.stringify(v)
const plain = (s: string): string => s.replace(/\u00a0/g, ' ')

const RULE_A = 'answer every question in British English'
const RULE_C = 'name the files you touched at the end of each reply'
const NEW_C = 'name the files and the tests you touched at the end of each reply'
const RULE_D = 'run the memory suite before every commit'
const NEW_D = 'run the memory suite and the identity suite before every commit'
const RULE_B = 'keep every reply under five lines'
const RULE_P = 'write commit subjects in the present tense'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
writeFileSync(join(inProcessHome, 'settings.json'), JSON.stringify({ memory: { journal: false } }))
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
resetSettingsCache()
const { retainItems, _resetMemoryVerbSessionStateForTesting, SOVEREIGN_SOURCE_MARK } = await import('../../src/mneme/memoryVerbs.ts')
const { maybeConsolidate, listTopicDocs } = await import('../../src/mneme/mnemeConsolidate.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')
const { readPins } = await import('../../src/mneme/mnemeUsage.ts')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { CorrectTool, RetainTool } = await import('../../src/tools/MemoryTools/MemoryTools.ts')
const { RULE_CARD_KEEP } = await import('../../src/tools/MemoryTools/ruleCard.ts')
const { sourceWords, topicPageLines } = await import('../../src/components/memory/MemoryCentreView.tsx')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

const dir = mnemeLibraryDir()
const ownerSaid = (text: string) => ({ messageId: `owner-${text.length}`, text })
const seeded = retainItems([RULE_A, RULE_B, RULE_C, RULE_D].map(content => ({ content, pin: true, topic: 'user-preferences' })), { session: 'rule-sovereign-seed', pinIntent: ownerSaid(`Remember these as standing rules:\n- ${RULE_A}\n- ${RULE_B}\n- ${RULE_C}\n- ${RULE_D}`) }, dir)
check('seed: four rules the user asked for are staged pinned and land on the shelf', seeded.every(o => o.status === 'stored') && maybeConsolidate({ force: true, dir }).consolidated === true, j(seeded))
_resetMemoryVerbSessionStateForTesting()
const draft = retainItems([{ content: RULE_P, pin: true, topic: 'user-preferences' }], { session: 'rule-sovereign-seed', pinIntent: ownerSaid(`Remember this as a standing rule: ${RULE_P}`) }, dir)
const draftId = draft[0]?.status === 'stored' ? draft[0].id : ''
const live = (): Array<{ seq: number; text: string; source: string }> => listTopicDocs(dir).flatMap(d => d.sections.flatMap(s => s.entries))
const history = (): Array<{ seq: number; text: string; source: string; supersededBy?: number }> => listTopicDocs(dir).flatMap(d => d.history)
const seqOf = (text: string): number => live().find(e => e.text === text)?.seq ?? -1
const askedPin = (seq: number): boolean => readPins(dir).some(p => p.seq === seq && p.asked === true)
const pageRows = (): string[] => listTopicDocs(dir).flatMap(doc => topicPageLines(doc, 400).map(line => plain(line.text)))

function contextOf(mode: 'default' | 'sovereign') {
  const permission = { ...getEmptyToolPermissionContext(), mode, isBypassPermissionsModeAvailable: mode === 'sovereign' }
  const state = { toolPermissionContext: permission, tasks: {}, sessionHooks: new Map() }
  return {
    options: { tools: [], commands: [], verbose: false, mcpClients: [], isNonInteractiveSession: false, agentDefinitions: { activeAgents: [], allAgents: [] } },
    abortController: new AbortController(),
    messages: [{ type: 'user', uuid: 'rule-sovereign-ask', timestamp: '2026-10-19T09:00:00.000Z', message: { role: 'user', content: `From now on, ${NEW_D} — that replaces the old rule.` } }],
    readFileState: new Map(),
    toolUseId: 'toolu_rule_sovereign',
    getAppState: () => state,
    setAppState: () => undefined,
  } as never
}
const assistant = { type: 'assistant', uuid: 'rule-sovereign', message: { id: 'msg_rule_sovereign', role: 'assistant', content: [] } } as never
let doorCalls = 0
const door = (async () => {
  doorCalls++
  return { behavior: 'allow', updatedInput: { [RULE_CARD_KEEP]: true } }
}) as never
const resultText = (tool: { mapToolResultToToolResultBlockParam: (o: never, id: string) => { content?: unknown } }, data: unknown): string => String(tool.mapToolResultToToolResultBlockParam(data as never, 'toolu_rule_sovereign').content ?? '')

section('§1 under sovereign a retract runs without the card; the receipt and /memory\'s history row both say it was unpinned and struck from the chat under sovereign')
{
  const seqA = seqOf(RULE_A)
  doorCalls = 0
  const call = await CorrectTool.call({ op: 'retract', id: `seq:${seqA}`, reason: 'the user said it is not a rule' }, contextOf('sovereign'), door, assistant)
  const data = (call as { data: { ok: boolean; via?: string; newSeq?: number } }).data
  check('no card was put: the door was never called', doorCalls === 0, j(doorCalls))
  check('the op ran, by sovereign', data.ok === true && data.via === 'sovereign', j(data))
  check('the rule is unpinned and struck; its wording is kept in history', !askedPin(seqA) && !live().some(e => e.text === RULE_A) && history().some(e => e.seq === seqA && e.text === RULE_A), j(readPins(dir)))
  const receipt = resultText(CorrectTool, data)
  check('the receipt says the rule was unpinned and struck from the chat under sovereign, with no card', receipt.includes("Under sovereign no card was asked: the rule the user asked Mercury to remember was unpinned and struck from the chat under sovereign, and /memory's history says so."), receipt)
  const tombstone = history().find(e => e.seq === data.newSeq)
  check('the history record carries the sovereign mark in its source', tombstone !== undefined && tombstone.source.endsWith(SOVEREIGN_SOURCE_MARK) && tombstone.text.startsWith('retired: '), j(tombstone))
  check("/memory's history row says the same: unpinned and struck from the chat under sovereign", pageRows().some(row => row.includes(`retired: the user said it is not a rule (was: ${RULE_A})`) && row.includes('unpinned and struck from the chat under sovereign')), pageRows().filter(r => r.includes('retired')).join(' | '))
}

section('§2 under sovereign a correction runs without the card; the new words land exactly; /memory\'s row says corrected from the chat under sovereign')
{
  const seqC = seqOf(RULE_C)
  doorCalls = 0
  const call = await CorrectTool.call({ op: 'supersede', id: `seq:${seqC}`, content: NEW_C, reason: 'the user asked for the tests too' }, contextOf('sovereign'), door, assistant)
  const data = (call as { data: { ok: boolean; via?: string; newSeq?: number } }).data
  const fresh = live().find(e => e.seq === data.newSeq)
  check('no card, the op ran by sovereign, the new words are exactly the content', doorCalls === 0 && data.ok === true && data.via === 'sovereign' && fresh?.text === NEW_C, j({ doorCalls, data, fresh }))
  check('the pin and its asked mark follow the new words; the old words are history', fresh !== undefined && askedPin(fresh.seq) && history().some(e => e.seq === seqC && e.text === RULE_C && e.supersededBy === fresh.seq))
  check("/memory's row for the new rule says corrected from the chat under sovereign", pageRows().some(row => row.includes(`• ${NEW_C} (seq`) && row.includes('corrected from the chat under sovereign')), pageRows().filter(r => r.includes(NEW_C)).join(' | '))
  check('the receipt says corrected from the chat under sovereign', resultText(CorrectTool, data).includes('was corrected from the chat under sovereign'), resultText(CorrectTool, data))
}

section('§3 under sovereign Retain with replaces runs without the card; /memory\'s row says replaced from the chat under sovereign')
{
  const seqD = seqOf(RULE_D)
  doorCalls = 0
  const call = await RetainTool.call({ items: [{ content: NEW_D, replaces: `seq:${seqD}` }] }, contextOf('sovereign'), door, assistant)
  const data = (call as { data: { outcomes: Array<{ status: string; id?: string; replaced?: { seq: number; via: string } }> } }).data
  const outcome = data.outcomes[0]
  check('no card, the rule was replaced by sovereign', doorCalls === 0 && outcome?.status === 'stored' && outcome.replaced?.seq === seqD && outcome.replaced.via === 'sovereign', j({ doorCalls, outcome }))
  check("/memory's row for the new rule says replaced from the chat under sovereign", pageRows().some(row => row.includes(`• ${NEW_D} (seq`) && row.includes('replaced from the chat under sovereign')), pageRows().filter(r => r.includes(NEW_D)).join(' | '))
  check('the receipt says replaced from the chat under sovereign', resultText(RetainTool, data).includes('was replaced from the chat under sovereign'), resultText(RetainTool, data))
}

section('§4 under sovereign a draft the user asked for is struck without the card; the receipt names sovereign and claims no history row (a draft leaves none)')
{
  doorCalls = 0
  const call = await CorrectTool.call({ op: 'retract', id: draftId, reason: 'withdrawn' }, contextOf('sovereign'), door, assistant)
  const data = (call as { data: { ok: boolean; via?: string } }).data
  const receipt = resultText(CorrectTool, data)
  check('no card, the draft is struck by sovereign', doorCalls === 0 && data.ok === true && data.via === 'sovereign' && !pendingRows(dir).some(r => r.text === RULE_P), j(data))
  check('the receipt names sovereign and says the draft leaves no history', receipt.includes('it leaves no history') && receipt.includes('unpinned and struck from the chat under sovereign.') && !receipt.includes("/memory's history says so"), receipt)
}

section('§5 outside sovereign the card road stands: the door is asked; the plain roads read as before')
{
  doorCalls = 0
  const seqB = seqOf(RULE_B)
  const call = await CorrectTool.call({ op: 'retract', id: `seq:${seqB}`, reason: 'probe' }, contextOf('default'), door, assistant)
  check('in the default mode the card is put (and its no keeps the rule)', doorCalls === 1 && (call as { data: { code?: string } }).data.code === 'user-kept-rule' && askedPin(seqB), j({ doorCalls, call }))
  check('the plain words are unchanged: from the chat · corrected from the chat · from /memory', sourceWords('tool:Retain s:83fe6475') === 'from the chat' && sourceWords('tool:Correct s:83fe6475') === 'corrected from the chat' && sourceWords('tool:Correct s:83fe6475', 'retired: x (was: y)') === 'corrected from the chat' && sourceWords('operator') === 'from /memory')
}

section('§6 the built product: a headless run with no host refuses and names /memory; a sovereign run unpins and strikes the rule and says so')
type Frame = Record<string, unknown>
type Body = Record<string, unknown>
type Run = { frames: Frame[]; stderr: string; exit: number | null; bodies: Body[] }
const nodeBin = findOnPath('node', process.env, process.platform)
if (!existsSync(DIST) || !nodeBin) {
  check('dist/mercury.mjs and node exist (build first — this section drives the artifact)', false)
} else {
  const home = realpathSync(mkdtempSync(join(scratchRoot, 'rule-sovereign-home-')))
  const cwd = realpathSync(mkdtempSync(join(scratchRoot, 'rule-sovereign-proj-')))
  writeFileSync(join(cwd, 'README.md'), '# Lantern\nA throwaway project for the memory proof.\n')
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ memory: { journal: false } }, null, 2) + '\n')
  const chat = async (prompt: string, turns: ScriptedTurn[], sovereign: boolean): Promise<Run> => {
    const fixture = await startFixtureApi(turns)
    const env: NodeJS.ProcessEnv = {
      HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', TERM: 'dumb', MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(home, 'daemon'),
      MERCURY_CREDENTIAL_STORE: 'file', ANTHROPIC_BASE_URL: fixture.url, ANTHROPIC_API_KEY: 'fixture-key-000', OPENAI_API_KEY: '',
      MERCURY_THINKING_BINDING: 'drop_block', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_TERMINAL_TITLE: '0', TMPDIR: scratchRoot, BROWSER: '/usr/bin/true',
    }
    try {
      return await new Promise<Run>(resolve => {
        const args = [DIST, 'run', '--input', 'rows', '--format', 'rows', ...(sovereign ? ['--mode', 'sovereign'] : []), '--model', 'claude-opus-5']
        const child = spawn(nodeBin, args, { cwd, env })
        const frames: Frame[] = []
        let stdout = ''
        let stderr = ''
        let consumed = 0
        let ended = false
        const finish = (exit: number | null): void => {
          if (ended) return
          ended = true
          clearTimeout(killer)
          resolve({ frames, stderr, exit, bodies: fixture.messageRequests().map(r => r.body as Body) })
        }
        const killer = setTimeout(() => child.kill('SIGKILL'), 180_000)
        child.stdout.on('data', d => {
          stdout += String(d)
          const parts = stdout.split('\n')
          for (; consumed < parts.length - 1; consumed++) {
            const frame = parseFrame(parts[consumed]!.trim())
            if (frame === null) continue
            frames.push(frame)
            if (isOutcome(frame)) child.stdin.end()
          }
        })
        child.stderr.on('data', d => (stderr += String(d)))
        child.on('close', exit => finish(exit))
        child.on('error', () => finish(null))
        child.stdin.write(inputLine(promptRow(prompt)))
      })
    } finally {
      await fixture.close()
    }
  }
  const toolResultsOf = (body: Body): string[] =>
    ((body.messages as Array<{ content?: unknown }> | undefined) ?? []).flatMap(message =>
      Array.isArray(message.content)
        ? (message.content as Array<{ type?: string; content?: unknown }>).filter(b => b.type === 'tool_result').map(b => (typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as Array<{ text?: string }>).map(x => x.text ?? '').join('\n') : ''))
        : [],
    )
  const libraryOf = (): string | null => {
    const walk = (at: string): string | null => {
      if (!existsSync(at)) return null
      for (const name of readdirSync(at)) {
        const p = join(at, name)
        if (name === 'library' && existsSync(join(p, 'pins.json'))) return p
        if (statSync(p).isDirectory()) {
          const hit = walk(p)
          if (hit) return hit
        }
      }
      return null
    }
    return walk(join(home, 'projects'))
  }
  const pinsOf = (lib: string): Array<{ seq: number; asked?: boolean }> => (JSON.parse(readFileSync(join(lib, 'pins.json'), 'utf8')) as { pins?: Array<{ seq: number; asked?: boolean }> }).pins ?? []
  const pagesOf = (lib: string): string => readdirSync(lib).filter(n => n.endsWith('.md')).map(n => readFileSync(join(lib, n), 'utf8')).join('\n')
  const RULE = 'end every reply with the word Fairwinds'
  try {
    const tell = await chat(`Please remember this as a standing rule: ${RULE}.`, [
      { kind: 'tool_use', name: 'Retain', input: { items: [{ content: RULE, pin: true }] }, whenBody: 'standing rule' },
      { kind: 'text', text: 'Saved. Fairwinds', whenBody: 'stored' },
    ], true)
    const lib = libraryOf()
    const asked = lib === null ? undefined : pinsOf(lib).find(p => p.asked === true)
    check('seed through the product: the chat ended and the rule is pinned, asked for by the user', tell.exit === 0 && asked !== undefined, `exit=${tell.exit} stderr=${tell.stderr.slice(-300)} lib=${lib}`)
    const seq = asked?.seq ?? -1
    const before = lib === null ? '' : `${readFileSync(join(lib, 'pins.json'), 'utf8')}\n${pagesOf(lib)}`
    const headless = await chat('That is not a rule, remove it.', [
      { kind: 'tool_use', name: 'Correct', input: { op: 'retract', id: `seq:${seq}`, reason: 'the user said it is not a rule' }, whenBody: 'not a rule, remove it' },
      { kind: 'text', text: 'It stays; change it in /memory.', whenBody: 'nothing changed' },
    ], false)
    const refusal = headless.bodies.flatMap(toolResultsOf).find(r => r.includes('Correct') || r.includes('refused')) ?? ''
    check('a headless run with no host: the Correct result refuses and names the /memory road', refusal.includes('refused (user-asked-rule)') && refusal.includes('so nothing changed') && refusal.includes('in /memory, under pinned rules'), refusal || headless.bodies.flatMap(toolResultsOf).join(' | ') || headless.stderr.slice(-300))
    check('a headless run with no host: nothing changed on disk', lib !== null && `${readFileSync(join(lib, 'pins.json'), 'utf8')}\n${pagesOf(lib)}` === before)
    const sovereignRun = await chat('That is not a rule, drop it.', [
      { kind: 'tool_use', name: 'Correct', input: { op: 'retract', id: `seq:${seq}`, reason: 'the user said it is not a rule' }, whenBody: 'not a rule, drop it' },
      { kind: 'text', text: 'Dropped.', whenBody: 'under sovereign' },
    ], true)
    const receipt = sovereignRun.bodies.flatMap(toolResultsOf).find(r => r.includes('retract')) ?? ''
    check('a sovereign run: the Correct result says the rule was unpinned and struck from the chat under sovereign, no card asked', receipt.includes('retract landed') && receipt.includes('Under sovereign no card was asked') && receipt.includes('unpinned and struck from the chat under sovereign'), receipt || sovereignRun.stderr.slice(-300))
    check('a sovereign run: the rule left the shelf and its words are kept in the page history with the sovereign mark', lib !== null && !pinsOf(lib).some(p => p.seq === seq) && pagesOf(lib).includes(RULE) && /retired: the user said it is not a rule[^\n]*source=tool:Correct s:[^,>]* sovereign[,>]/.test(pagesOf(lib)), lib === null ? 'no library' : pagesOf(lib).split('\n').filter(l => l.includes('retired')).join(' | '))
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
}

rmSync(inProcessHome, { recursive: true, force: true })
console.log(`\nmemory rule sovereign: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
