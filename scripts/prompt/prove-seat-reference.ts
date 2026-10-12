#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

delete process.env.NODE_ENV
delete process.env.CI
for (const ambient of ['MERCURY_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_SCRIPTED_STREAM', 'MERCURY_BARE', 'MERCURY_HOME', 'MERCURY_EFFORT_LEVEL', 'MERCURY_THINKING_BUDGET', 'MERCURY_THINKING_BINDING', 'MERCURY_WIRE_DUMP']) {
  delete process.env[ambient]
}
const home = mkdtempSync(join(tmpdir(), 'seat-reference-home-'))
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'seat-reference-cwd-')))
mkdirSync(join(home, '.mercury'), { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(home, '.mercury')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.ANTHROPIC_BASE_URL

import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'
import { answerOf, isOutcome } from '../lib/rows.ts'
import { hostRunner } from '../lib/runnerHost.ts'

let checks = 0
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (cond) console.log(`  ✓ ${label}`)
  else {
    failures++
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n── ${title}`)
}
const j = (v: unknown): string => JSON.stringify(v)

const FABLE = 'claude-fable-5-1'
const OPUS = 'claude-opus-5'
const ENGINE_LINE = 'the model you run through Mercury is'
const SID = 'c0ffee00-0000-4000-8000-00000000a1e5'

const textsOf = (content: unknown): string[] => {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const block of content as Array<{ type?: string; text?: unknown; content?: unknown }>) {
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    if (block.type === 'tool_result') out.push(...textsOf(block.content))
  }
  return out
}
const systemTextOf = (body: { system?: unknown }): string => {
  if (typeof body.system === 'string') return body.system
  if (!Array.isArray(body.system)) return ''
  return (body.system as Array<{ text?: string }>).map(block => block.text ?? '').join('\n')
}

section('§1 the environment section names no engine; the seat reference does')
{
  const prompts = await import('../../src/constants/prompts.ts')
  const main = await prompts.computeSimpleEnvInfo(FABLE)
  check('the main env block carries no engine line and no model id (RED on the base: "In this seat the model you run through Mercury is …")', !main.includes(ENGINE_LINE) && !main.includes(FABLE), main)
  check('the main env block still carries its labelled lines', main.includes('# Environment') && main.includes('Platform:') && main.includes('OS Version:'), main)
  const child = await prompts.computeEnvInfo(OPUS, 'agent-1')
  check('the subagent env block carries no engine line and no model id (RED on the base)', !child.includes(ENGINE_LINE) && !child.includes(OPUS), child)
  check('the subagent env block closes its <env> and keeps the cutoff and currency facts', /<\/env>\n\nKnowledge cutoff for this model: /.test(child) && child.includes('Model currency'), child.slice(child.indexOf('</env>') - 20, child.indexOf('</env>') + 80))

  const seat = (await import('../../src/services/resources/adapters/seat.ts').catch(() => null)) as typeof import('../../src/services/resources/adapters/seat.ts') | null
  check('the seat adapter module exists (RED on the base: absent)', seat !== null)
  const { resolveResource, resourceAdapterKinds } = await import('../../src/services/resources/registry.ts')
  const owner = (await import('../../src/services/run/resolveOwner.ts')).ownerFromToolUseContext({})
  const state = { effortValue: 'high', toolPermissionContext: { mode: 'default' } }
  const live = await resolveResource('mercury://seat', { owner, cwd, getAppState: () => state, engineModel: OPUS })
  check('mercury://seat resolves inside a turn with the model, the effort, the posture and the engines', live.state === 'ok' && live.resource.structured !== undefined && (live.resource.structured as { model: string }).model === OPUS, j(live))
  const text = live.state === 'ok' ? live.resource.text ?? '' : ''
  check('the reference text names the model this turn runs on with its marketing name, the effort and the posture', text.includes(`model this turn runs on: ${OPUS} (`) && text.includes('effort: high') && text.includes('posture: ') && text.includes('permission mode default'), text)
  check('with no ledger entry for this session the engines line says so instead of inventing one', text.includes('engines this session: no ledger entry for this session yet'), text)
  const outside = await resolveResource('mercury://seat', { owner, cwd })
  check('outside a turn (no model on hand) the reference is unavailable, never a guess', outside.state === 'unavailable' && outside.note.includes('inside a session turn'), j(outside))
  const wrong = await resolveResource('mercury://seat/other', { owner, cwd, engineModel: OPUS })
  check('mercury://seat has one form; an id under it is absent', wrong.state === 'absent', j(wrong))
  check('the seat kind is listed for the Inspect prompt', resourceAdapterKinds().some(kind => kind.kind === 'seat' && kind.describe.includes('mercury://seat')), j(resourceAdapterKinds().map(kind => kind.kind)))
  const { InspectTool } = await import('../../src/tools/InspectTool/InspectTool.ts')
  const prompt = await InspectTool.prompt({} as never)
  check('the Inspect tool tells the seat the reference exists and what it holds', prompt.includes('mercury://seat is this seat\'s own reference') && prompt.includes('the model this turn runs on') && prompt.includes('Asked which model runs you, read it and answer from it'), prompt.slice(-400))
  const words = seat === null ? '' : seat.seatPostureWords('implement')
  check('the posture words carry the permission mode', words.endsWith('; permission mode implement'), words)

  const { ledgerClock, openEntry, recordEngine } = await import('../../src/mneme/ledger.ts')
  const { mnemeProjectKeyFor } = await import('../../src/mneme/paths.ts')
  const key = mnemeProjectKeyFor(cwd)
  const realNow = Date.now
  Date.now = () => 1_760_000_000_000
  const opened = openEntry(key, { sessionId: SID, model: FABLE })
  Date.now = () => 1_760_000_060_000
  const switched = recordEngine(key, SID, OPUS)
  Date.now = realNow
  check('a ledger entry for the runner\'s session is seeded with two engines, each stamped by the clock at its write', opened.engines.length === 1 && switched !== null && switched.engines.length === 2 && switched.engines[0]!.at === new Date(1_760_000_000_000).toISOString() && switched.engines[1]!.at === new Date(1_760_000_060_000).toISOString(), j({ opened: opened.engines, switched: switched?.engines, clock: ledgerClock() }))
}

const DIST = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  check('dist/mercury.mjs present (build first; the pooled gate prebuilds it)', false, DIST)
} else {
  const nodeBin = Bun.which('node')
  if (!nodeBin) {
    check('a node binary on PATH', false)
  } else {
    section('§2 the session runner — the prompt on the wire names no engine; after a switch the seat reads mercury://seat and gets the live engine and the ledger\'s engines')
    const turns: ScriptedTurn[] = [
      { kind: 'text', text: 'SR-F1', model: FABLE },
      { kind: 'tool_use', name: 'Inspect', input: { ref: 'mercury://seat' }, id: 'toolu_seat_1', model: OPUS },
      { kind: 'text', text: 'SR-O1', model: OPUS },
    ]
    const fixture = await startFixtureApi(turns, { apiChecks: true })
    const env = {
      HOME: home,
      PATH: `/usr/bin:/bin:${dirname(nodeBin)}`,
      TERM: 'dumb',
      MERCURY_CONFIG_DIR: join(home, '.mercury'),
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ANTHROPIC_BASE_URL: fixture.url,
      ANTHROPIC_API_KEY: 'fixture-key-000',
      MERCURY_DAEMON_DIR: join(home, 'daemon'),
    }
    const host = hostRunner({ node: nodeBin, dist: DIST, argv: ['--model', FABLE, '--allowed-tools', 'Read', '--session-id', SID], cwd, env, home: env.MERCURY_CONFIG_DIR })
    const killer = setTimeout(() => host.child.kill('SIGKILL'), 120_000)
    let turnsSent = 0
    const turn = async (prompt: string, marker: string): Promise<void> => {
      const ordinal = ++turnsSent
      await host.prompt(prompt)
      await host.waitFor(`turn ${ordinal} ("${prompt}") settled on the fixture's ${marker}`, row => isOutcome(row) && row.turn === ordinal && answerOf(row).includes(marker), 60_000)
    }
    let seatError = ''
    try {
      await host.initialize({})
      await turn('first on fable', 'SR-F1')
      await host.request('session/set_model', { model: OPUS })
      await turn('which model are you running on?', 'SR-O1')
    } catch (error) {
      seatError = error instanceof Error ? error.message : String(error)
    }
    check('the two turns settled (the second through the Inspect call)', seatError === '', seatError || host.stderr().slice(-600))
    const requests = fixture.messageRequests().map(r => r.body as { model?: string; system?: unknown; messages?: Array<{ content?: unknown }> })
    const firstSystem = systemTextOf(requests[0] ?? {})
    check('the system prompt on the wire carries no engine line (RED on the base)', firstSystem.length > 0 && !firstSystem.includes(ENGINE_LINE), firstSystem.slice(0, 200))
    check('…and names the model id nowhere in its environment section', !(firstSystem.match(/# Environment[\s\S]*?(?=\n# |$)/)?.[0] ?? '').includes(FABLE), firstSystem.match(/# Environment[\s\S]*?(?=\n# |$)/)?.[0]?.slice(0, 400))
    const third = requests[2]
    const toolResultTexts = (third?.messages ?? []).flatMap(m => textsOf(m.content)).filter(text => text.includes('this seat'))
    const seatText = toolResultTexts.join('\n')
    check('the request after the Inspect call dispatches on the new model', third?.model === OPUS, j(third?.model))
    check('the seat reference the seat read names the LIVE engine after the switch, not the one it started on', seatText.includes(`model this turn runs on: ${OPUS}`) && !seatText.includes(`model this turn runs on: ${FABLE}`), seatText)
    const { stampLocal } = await import('../../src/mneme/entryPage.ts')
    check('…and the ledger\'s engines for this session, the start engine and the switch, each with its clock time in LOCAL time with the zone (the raw UTC string read as local in the field)', seatText.includes(`${stampLocal(new Date(1_760_000_000_000).toISOString())}  ${FABLE}`) && seatText.includes(`${stampLocal(new Date(1_760_000_060_000).toISOString())}  ${OPUS}`) && !seatText.includes(new Date(1_760_000_000_000).toISOString()), seatText)
    check('…and the posture of a hosted runner (a host holds the asks) with its permission mode', seatText.includes('a host holds the asks') && seatText.includes('permission mode'), seatText)
    clearTimeout(killer)
    await host.stop(5_000).catch(() => null)
    await fixture.close()
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'}: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
