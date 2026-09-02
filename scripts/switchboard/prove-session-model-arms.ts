#!/usr/bin/env bun
// ============================================================================
//  prove-session-model-arms — the worker registry's TWO dispatch arms.
//
//  The incident this closes: a boot chat whose saved default was a GPT id
//  could not start at all — the admission validated every session against
//  the bounded-crew vocabulary, so a sovereign (non-Anthropic) session was
//  refused 'not-integrated:worker-engine' at its own front door. The law
//  (operator-ratified): the SESSION arm is PURE PRODUCT CAPABILITY — every
//  credentialed family dispatches, the economy tier included; the CREW arm
//  keeps its narrower vocabulary (frontier-only, engines not integrated).
//  Refusals are typed with the ONE action riding the error.
//
//    §1 THE SESSION ARM — capability: frontier, engine AND haiku ids all
//       validate ok when credentialed; a keyless family refuses
//       'no-credential:<family>' with the /logins action; an engine
//       namespace id outside the picker still dispatches (the wire
//       adjudicates); an unknown Anthropic-space id refuses
//       'unknown-model'.
//    §2 THE CREW ARM — the bounded vocabulary: engines typed-refused even
//       credentialed; haiku refused by the standing law (THE pin that
//       separates the arms); frontier ok.
//    §3 DISPLAY ≡ DISPATCH per arm — an arm's painted availability and its
//       validation verdict can never disagree, row by row.
//    §4 THE SEED NAMES ITS ARM — an engine operator-default seeds the
//       session arm and never the crew arm (visible fallback, no silent
//       substitute).
//    §5 THE PREFLIGHT DOOR speaks the session arm — haiku preflights
//       clean; a keyless family's refusal carries the class AND the
//       action.
//
//  POISON CONTROL: this file run in a worktree whose registry types every
//  engine row 'not-integrated:worker-engine' for every dispatch (the
//  pre-split registry) FAILS the §1/§3/§5 pins — that run is the recorded
//  poison for these pins.
//
//  Run: ~/.bun/bin/bun run scripts/switchboard/prove-session-model-arms.ts
// ============================================================================
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures = 1
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

// ── env hygiene BEFORE any src import ───────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'sovereign-session-models-'))
const home = join(scratch, 'home')
const work = join(scratch, 'work')
mkdirSync(home, { recursive: true })
mkdirSync(work, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = home
}
for (const key of [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_MODEL',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'DEEPSEEK_API_KEY',
]) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_EVOLUTION_LEDGER = '0'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_CREW_DIR = join(scratch, 'crew')
process.env.MERCURY_DAEMON_DIR = join(scratch, 'daemon')
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_AUTH_TOKEN = 'fixture-token'
// The Anthropic + Z.AI families hold credentials; Moonshot and OpenRouter
// stay keyless so their refusal class + action are pinned.
process.env.ANTHROPIC_API_KEY = 'sk-ant-fixture000'
process.env.ZAI_API_KEY = 'fixture-zai-key'
delete process.env.MOONSHOT_API_KEY
delete process.env.KIMI_API_KEY
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

console.log('============================================================')
console.log(' sovereign session models — one registry, two dispatch arms')
console.log('============================================================')

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const wm = await import('../../src/services/concourse/workerModels.ts')

type Entry = import('../../src/services/concourse/workerModels.ts').WorkerModelEntryV1
const registry = await wm.composeWorkerModelRegistry()
const row = (id: string): Entry | undefined => registry.entries.find(e => e.modelId === id)
const text = (v: unknown): string => JSON.stringify(v) ?? ''

//
section('§1 — the session arm: pure product capability')
//
{
  const fable = await wm.validateWorkerModelChoice('claude-fable-5', 'session')
  check('an Anthropic frontier id validates ok for a session', fable.ok, text(fable))

  // THE FIX: an engine id with its credential attached IS dispatchable as a
  // session — the session runner is the whole product.
  const glm = await wm.validateWorkerModelChoice('glm-5.3', 'session')
  check('a credentialed Z.AI engine id validates ok for a session', glm.ok, text(glm))
  check('…and its registry row paints session-available (display ≡ dispatch)',
    row('glm-5.3')?.session.availability === 'available', text(row('glm-5.3')))

  // THE AMENDMENT: haiku is a session model like any other the account runs
  // — the never-Haiku law binds the AUTONOMOUS crew, not the operator.
  const haiku = await wm.validateWorkerModelChoice('claude-haiku-4-5-20251001', 'session')
  check('haiku validates ok for a SESSION (capability, not policy)', haiku.ok, text(haiku))
  check('…and its row paints session-available',
    row('claude-haiku-4-5-20251001')?.session.availability === 'available', text(row('claude-haiku-4-5-20251001')))

  // A keyless family refuses with its TRUE class and the ONE action.
  const kimi = await wm.validateWorkerModelChoice('kimi-k3', 'session')
  check('a keyless engine row refuses typed no-credential:<family>',
    !kimi.ok && kimi.reason === 'no-credential:moonshot', text(kimi))
  check('…with the /logins action riding the refusal',
    !kimi.ok && String(kimi.action ?? '').includes('/logins moonshot'), text(kimi))

  // An ENGINE-namespace id the picker has not listed: capability rules —
  // keyless here, so the refusal is the credential truth with the fix.
  const nemotron = await wm.validateWorkerModelChoice('openrouter/nvidia/nemotron-nano-9b-v2:free', 'session')
  check('a keyless OpenRouter namespace id refuses no-credential:openrouter',
    !nemotron.ok && nemotron.reason === 'no-credential:openrouter', text(nemotron))
  check('…with the /logins action', !nemotron.ok && String(nemotron.action ?? '').includes('/logins'), text(nemotron))

  // Garbage in the Anthropic id space refuses unknown-model, honestly.
  const junk = await wm.validateWorkerModelChoice('claude-zzz-not-a-model-9', 'session')
  check('an unknown Anthropic-space id refuses unknown-model',
    !junk.ok && junk.reason === 'unknown-model', text(junk))
  check('…with an actionable line', !junk.ok && typeof junk.action === 'string' && junk.action.length > 0, text(junk))
}

//
section('§2 — the crew arm: the bounded vocabulary (THE arm separator)')
//
{
  const fable = await wm.validateWorkerModelChoice('claude-fable-5', 'crew')
  check('an Anthropic frontier id validates ok for a crew seat', fable.ok, text(fable))

  const glm = await wm.validateWorkerModelChoice('glm-5.3', 'crew')
  check('the SAME credentialed engine id refuses on the crew arm, typed',
    !glm.ok && glm.reason === 'not-integrated:worker-engine', text(glm))

  const haiku = await wm.validateWorkerModelChoice('claude-haiku-4-5-20251001', 'crew')
  check('haiku refuses on the CREW arm — the never-Haiku law binds autonomous crew',
    !haiku.ok && haiku.reason === 'worker-policy:frontier-only', text(haiku))
  check('…with the crew action named', !haiku.ok && String(haiku.action ?? '').length > 0, text(haiku))
}

//
section('§3 — display ≡ dispatch, row by row, per arm')
//
{
  let mismatches = 0
  for (const e of registry.entries) {
    for (const arm of ['session', 'crew'] as const) {
      const v = await wm.validateWorkerModelChoice(e.modelId, arm)
      if (v.ok !== (e[arm].availability === 'available')) {
        mismatches++
        console.log(`    mismatch: ${e.modelId} ${arm} painted=${e[arm].availability} validated=${text(v)}`)
      }
    }
  }
  check('every row’s painted availability matches its validation verdict on both arms',
    mismatches === 0, `${mismatches} mismatch(es) over ${registry.entries.length} rows`)
}

//
section('§4 — the seed names its arm')
//
{
  const reg = (entries: Entry[]) => ({ schema: 1 as const, entries })
  const sessionOnly = {
    session: { availability: 'available' },
    crew: { availability: 'refused', refusal: 'not-integrated:worker-engine' },
  } as const
  const bothArms = { session: { availability: 'available' }, crew: { availability: 'available' } } as const
  const engineDefault: Entry = { modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', ...sessionOnly, effort: 'high', isOperatorDefault: true }
  const fable: Entry = { modelId: 'claude-fable-5', displayName: 'Fable 5', ...bothArms, effort: 'high' }

  check('an engine operator-default seeds the SESSION arm',
    wm.defaultWorkerModelId(reg([engineDefault, fable]), 'session') === 'gpt-5.6-sol')
  check('…and the CREW arm falls to its own first available row — never the engine',
    wm.defaultWorkerModelId(reg([engineDefault, fable]), 'crew') === 'claude-fable-5')
}

//
section('§5 — the preflight door speaks the session arm')
//
{
  const { preflightConcourseDispatch } = await import('../../src/daemon/concourseDispatch.ts')
  const glm = await preflightConcourseDispatch({ workspaceDir: work, modelKey: 'glm-5.3' })
  check('a credentialed engine session preflights CLEAN', glm.ok === true, text(glm))
  const haiku = await preflightConcourseDispatch({ workspaceDir: work, modelKey: 'claude-haiku-4-5-20251001' })
  check('a haiku session preflights CLEAN (the amendment)', haiku.ok === true, text(haiku))
  const keyless = await preflightConcourseDispatch({ workspaceDir: work, modelKey: 'openrouter/nvidia/nemotron-nano-9b-v2:free' })
  check('a keyless family preflight refusal carries the class AND the action',
    keyless.ok === false &&
      keyless.refusals.some(r => r.code === 'invalid-model' && r.reason.includes('no-credential:openrouter') && r.reason.includes('/logins')),
    text(keyless))
}

//
section('§6 — a record-less resume retains the transcript’s model (the vNext store)')
//
{
  // The transcript store is the Mercury record format — the retained-model
  // walk must read it through the ONE codec. POISON: a hand parse of the
  // envelope reads ZERO models and every record-less resume silently fell
  // to the default.
  const { writeFileSync, mkdirSync: mkd } = await import('node:fs')
  const { join: j } = await import('node:path')
  const supervisor = await import('../../src/daemon/concourseSupervisor.ts')
  const paths = await import('../../src/utils/sessionStorage/paths.ts')
  const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
  const SID = '00000000-aaaa-bbbb-cccc-00000000f6f6'
  const workspaceId = supervisor.canonicalWorkspaceId(work)
  const projDir = paths.getProjectDir(workspaceId)
  mkd(projDir, { recursive: true })
  const transcript = j(projDir, `${SID}.jsonl`)
  const rows: Array<Record<string, unknown>> = [
    {
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      cwd: work,
      sessionId: SID,
      version: '1.0.0-beta.1',
      gitBranch: '',
      parentUuid: null,
      type: 'user',
      message: { role: 'user', content: 'the retained chat begins' },
      uuid: '00000000-0000-4000-8000-00000000f601',
      timestamp: '2026-08-27T08:00:01.000Z',
    },
    {
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      cwd: work,
      sessionId: SID,
      version: '1.0.0-beta.1',
      gitBranch: '',
      parentUuid: '00000000-0000-4000-8000-00000000f601',
      type: 'assistant',
      message: { role: 'assistant', model: 'kimi-k3', content: [{ type: 'text', text: 'the retained chat answered.' }] },
      uuid: '00000000-0000-4000-8000-00000000f602',
      timestamp: '2026-08-27T08:00:05.000Z',
    },
  ]
  let encoded = ''
  for (const r of rows) {
    encoded += (encodeTranscriptLine as (p: string, e: Record<string, unknown>) => { line: string })(transcript, r).line
  }
  writeFileSync(transcript, encoded)
  const retained = supervisor.resumeModelKeyOf(SID, work)
  check('the record-less resume walk reads the model THROUGH the codec', retained === 'kimi-k3', String(retained))
}

//
section('§6b — the retained walk runs the ONE provenance law (FN-013 MODEL-01)')
//
{
  // Sessions that end on an interrupt, an API error, a switch breadcrumb or
  // a resume sentinel write an assistant row stamped with the factories'
  // SYNTHETIC_MODEL. The law (the shared predicate's, sessionRestore):
  // locally-fabricated rows are SKIPPED — the walk falls through to the
  // last REAL served row, and a transcript with no real row retains
  // NOTHING (the registry default, never a refusal on the sentinel
  // spelling). POISON: the pre-law walk returned '<synthetic>' itself,
  // which the admission validator then refused — exactly the sessions most
  // likely to be resumed (they ended on an interrupt) could not come back.
  const { writeFileSync, mkdirSync: mkd } = await import('node:fs')
  const { join: j } = await import('node:path')
  const supervisor = await import('../../src/daemon/concourseSupervisor.ts')
  const paths = await import('../../src/utils/sessionStorage/paths.ts')
  const { encodeTranscriptLine } = await import('../../src/utils/sessionStorage/vnext.ts')
  const { restoreConversationModelFromMessages } = await import('../../src/utils/sessionRestore.ts')
  const { getDefaultMainLoopModelSetting, parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
  const workspaceId = supervisor.canonicalWorkspaceId(work)
  const projDir = paths.getProjectDir(workspaceId)
  mkd(projDir, { recursive: true })
  const writeFixture = (sid: string, models: string[]): void => {
    const transcript = j(projDir, `${sid}.jsonl`)
    let parent: string | null = null
    let seq = 0
    let encoded = ''
    const push = (row: Record<string, unknown>): void => {
      encoded += (encodeTranscriptLine as (p: string, e: Record<string, unknown>) => { line: string })(transcript, row).line
    }
    const meta = (uuid: string) => ({
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      cwd: work,
      sessionId: sid,
      version: '1.0.0-beta.1',
      gitBranch: '',
      parentUuid: parent,
      uuid,
      timestamp: `2026-08-27T09:00:0${seq}.000Z`,
    })
    const uuidOf = (n: number): string => `00000000-0000-4000-8000-0000${sid.slice(-4)}${String(n).padStart(4, '0')}`
    const first = uuidOf(seq)
    push({ ...meta(first), type: 'user', message: { role: 'user', content: 'the provenance chat begins' } })
    parent = first
    for (const model of models) {
      seq++
      const uuid = uuidOf(seq)
      push({
        ...meta(uuid),
        type: 'assistant',
        message: { role: 'assistant', model, content: [{ type: 'text', text: `served by ${model}.` }] },
      })
      parent = uuid
    }
    writeFileSync(transcript, encoded)
  }
  const asst = (model: string): unknown => ({ type: 'assistant', message: { role: 'assistant', model } })
  const user = (): unknown => ({ type: 'user', message: { role: 'user', content: 'x' } })
  type Msg = Parameters<typeof restoreConversationModelFromMessages>[0]

  const SID_TAIL = '00000000-aaaa-bbbb-cccc-00000000a601'
  writeFixture(SID_TAIL, ['glm-5.3', '<synthetic>'])
  const tail = supervisor.resumeModelKeyOf(SID_TAIL, work)
  check('a synthetic tail row is SKIPPED — the last real served model retains', tail === 'glm-5.3', String(tail))

  const SID_ONLY = '00000000-aaaa-bbbb-cccc-00000000a602'
  writeFixture(SID_ONLY, ['<synthetic>'])
  const only = supervisor.resumeModelKeyOf(SID_ONLY, work)
  check('a synthetic-only transcript retains NOTHING (the registry default, never the sentinel)', only === undefined, String(only))

  const SID_CARRIER = '00000000-aaaa-bbbb-cccc-00000000a603'
  writeFixture(SID_CARRIER, ['openrouter/stealth/ox-alpha', '<synthetic>'])
  const carrier = supervisor.resumeModelKeyOf(SID_CARRIER, work)
  check('a carrier-served session ending on an interrupt retains the carrier id verbatim', carrier === 'openrouter/stealth/ox-alpha', String(carrier))

  // Agreement law: the supervisor's walk and the shared predicate answer
  // identically over the same rows (the frontier-policy corpus shapes,
  // carrier ids included; absent normalizes to null for the comparison).
  const agree = (label: string, sid: string, rows: unknown[]): void => {
    const fromWalk = supervisor.resumeModelKeyOf(sid, work) ?? null
    const fromPredicate = restoreConversationModelFromMessages(rows as Msg)
    check(`agreement — ${label}`, fromWalk === fromPredicate, `walk=${String(fromWalk)} predicate=${String(fromPredicate)}`)
  }
  agree('synthetic tail', SID_TAIL, [user(), asst('glm-5.3'), asst('<synthetic>')])
  agree('synthetic only', SID_ONLY, [user(), asst('<synthetic>')])
  agree('carrier id', SID_CARRIER, [user(), asst('openrouter/stealth/ox-alpha'), asst('<synthetic>')])

  // The billing-safe form: a transcript that served the CURRENT default's
  // base id retains the default SETTING form on BOTH readers.
  const defaultResolved = parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
  const defaultBase = defaultResolved.replace(/\[1m\]$/i, '')
  const SID_DEFAULT = '00000000-aaaa-bbbb-cccc-00000000a604'
  writeFixture(SID_DEFAULT, [defaultBase])
  const asDefault = supervisor.resumeModelKeyOf(SID_DEFAULT, work)
  check('the walk restores the default SETTING form for the default base id', asDefault === defaultResolved, `walk=${String(asDefault)} expected=${defaultResolved}`)
  agree('default base form', SID_DEFAULT, [user(), asst(defaultBase)])
}

//
section("§7 — spoken names resolve on the LAUNCH path (the coordinator's words)")
//
{
  // The operator's word: the coordinator relayed the
  // operator's spoken model names and the launch refused unknown-model with
  // a did-you-mean before the resolver landed. The law: a spoken name
  // matching EXACTLY ONE catalogue row launches on it — through the same
  // validateWorkerModelChoice the dispatch admission calls, so the
  // coordinator's launch_session and the board's own launch read one truth.
  const sonnet = await wm.validateWorkerModelChoice('sonnet 5', 'session')
  check("'sonnet 5' (the coordinator's exact relay) resolves to claude-sonnet-5", sonnet.ok && sonnet.entry.modelId === 'claude-sonnet-5', text(sonnet))
  const opus = await wm.validateWorkerModelChoice('opus 5', 'session')
  check("'opus 5' resolves to claude-opus-5", opus.ok && opus.entry.modelId === 'claude-opus-5', text(opus))
  const dashed = await wm.validateWorkerModelChoice('Opus-5', 'session')
  check("'Opus-5' (case + dash spelling) resolves the same", dashed.ok && dashed.entry.modelId === 'claude-opus-5', text(dashed))
  const glued = await wm.validateWorkerModelChoice('sonnet5', 'session')
  check("'sonnet5' (glued) resolves the same", glued.ok && glued.entry.modelId === 'claude-sonnet-5', text(glued))
  // The route-honesty re-class: a FAMILY-LESS stranger refuses with the
  // honest class ('no family declares this id'), never a borrowed lane's
  // unknown-model — that class stays for home-shaped strangers (§ above).
  const stranger = await wm.validateWorkerModelChoice('zephyr 9000', 'session')
  // Operator-ruled vocabulary: a name NO
  // provider family declares refuses 'not-runnable:unrecognised' naming the
  // fact — 'unknown-model' stays the Anthropic-space answer (§3 above).
  check(
    'a genuine stranger refuses not-runnable:unrecognised (typed, naming the fact, the action names the picker)',
    !stranger.ok &&
      stranger.reason === 'not-runnable:unrecognised' &&
      /no provider family declares/.test(stranger.detail ?? '') &&
      /model picker/.test((stranger as { action?: string }).action ?? ''),
    text(stranger),
  )
}

//
section("§8 — the refusal's action names the family's OWN /logins word")
//
{
  // /logins pre-focuses eight family words (login.tsx parseFamilyFocus);
  // the action line used to say a bare "/logins" for openrouter · gemini ·
  // huggingface · openai although the product takes the word — the one
  // action that fixes it should name it. The two families with no sign-in
  // leg name their connect home instead.
  for (const family of ['anthropic', 'openai', 'openrouter', 'gemini', 'huggingface', 'moonshot', 'zai', 'deepseek']) {
    check(`${family}: the action names /logins ${family}`, wm.loginsActionFor(family) === `ask the operator to run /logins ${family}`, wm.loginsActionFor(family))
  }
  check('compat names its connect home, never a /logins leg it lacks', wm.loginsActionFor('openai-compat').includes('MERCURY_COMPAT_BASE_URL') && !wm.loginsActionFor('openai-compat').includes('/logins'))
  check('local names its connect home, never a /logins leg it lacks', wm.loginsActionFor('local').includes('MERCURY_LOCAL_BASE_URL') && !wm.loginsActionFor('local').includes('/logins'))
  // Live: the keyless OpenRouter namespace id (the operator's nemotron) and
  // a keyless Gemini id carry their family word on the door's refusal.
  const nemotron = await wm.validateWorkerModelChoice('openrouter/nvidia/nemotron-nano-9b-v2:free', 'session')
  check('a keyless OpenRouter id refuses with "/logins openrouter"', !nemotron.ok && String(nemotron.action ?? '').includes('/logins openrouter'), text(nemotron))
  const gemini = await wm.validateWorkerModelChoice('gemini-3-pro', 'session')
  check('a keyless Gemini id refuses with "/logins gemini"', !gemini.ok && gemini.reason === 'no-credential:gemini' && String(gemini.action ?? '').includes('/logins gemini'), text(gemini))

  // THE DRIFT NOTE (pure): an unnamed launch whose recorded default provider
  // lost its credential fell to the frontier lane — the refusal names the
  // family the operator chose and its own fix, not only the lane it fell to.
  const drifted = wm.defaultProviderDriftNote('no-credential:anthropic', 'openrouter', () => false)
  check('a dead default provider is named on the unnamed launch\'s refusal', drifted !== undefined && drifted.detail.includes('OpenRouter') && drifted.detail.includes('anthropic family'), text(drifted))
  check('…with the recorded family\'s own fix and the /defaultprovider door', drifted !== undefined && drifted.action.includes('/logins openrouter') && drifted.action.includes('/defaultprovider'), text(drifted))
  check('a credentialed default provider drifts nothing (the launch never fell through it)', wm.defaultProviderDriftNote('no-credential:anthropic', 'openrouter', f => f === 'openrouter') === undefined)
  check('no recorded default provider drifts nothing', wm.defaultProviderDriftNote('no-credential:anthropic', undefined, () => false) === undefined)
  check('the same family drifts nothing (the fall-through is the truth already)', wm.defaultProviderDriftNote('no-credential:openrouter', 'openrouter', () => false) === undefined)
  check('a non-credential refusal drifts nothing', wm.defaultProviderDriftNote('worker-policy:frontier-only', 'openrouter', () => false) === undefined)
}

try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* scratch */
}
console.log(
  failures === 0
    ? '\n✅ prove-session-model-arms — all checks pass'
    : '\n❌ prove-session-model-arms — check(s) failed',
)
process.exit(failures)
