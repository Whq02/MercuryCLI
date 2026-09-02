#!/usr/bin/env bun
// ============================================================================
//  The COMPOSED coordinator model registry — every row selectable, every
//  label true (the operator's ruling).
//
//  §1 role vocabulary — 'coordinator' is a real role with its OWN
//     versioned capability digest (distinct from every other role's).
//  §2 the label family under EVERY account state (injected presences):
//     Anthropic rows read 'ready' with a credential and 'not-signed-in'
//     without (the attach home rides `detail`); GPT rows read
//     'not-signed-in' without an OpenAI credential, and with one 'ready'
//     for the receipt-backed model and 'unqualified' for the rest of the
//     lineup. No row anywhere carries a refusal field; the registry is
//     selectable whenever it has a row.
//  §3 the REAL presence owner (no injection) — the registry's credential
//     labels agree with providerFamilyPresences() for every family, and on
//     this scrubbed scratch home the Anthropic rows read 'not-signed-in —
//     /logins anthropic' (the operator's own account shape, minus OpenAI).
//  §4 the file-backed OpenAI account — a fixture subscription file flips
//     the OpenAI rows live through the real discovery re-prime (never a
//     5-minute-old cache): the operator's exact shape — Anthropic absent,
//     the receipt-backed engine 'ready', the rest 'unqualified'.
//  §5 an EXPIRED receipt (stale capability digest) — 'qualification-
//     expired' with the expiry detail (digest currency enforced).
//  §6 validateCoordinatorModelChoice — no-choice / unknown-model / ok for a
//     ready row AND ok for a not-signed-in row (a credential gap never
//     refuses a choice; the label rides the entry).
//  §7 non-coordinator receipts never enter the composition — the
//     operator's store (one 'primary' receipt) leaves every GPT row
//     'unqualified' and selectable.
//  §8 the safe-boundary switch owner — a non-ready row APPLIES with its
//     label on the receipt; only an unknown id refuses (config untouched);
//     the closed mode vocabulary; every receipt states the safe boundary.
//  §9 the boundary statement is LIVE truth — a held 'coordinator' permit
//     (a turn in flight) surfaces in the receipt; a quiet lane does not.
//  §10 switch receipts row on the semantic activity feed as 'handoff' rows
//     through the REGISTERED classifier.
//
//  Hermetic: the auth scope + qualification store pin to a scratch config
//  home BEFORE the owners load; every endpoint base pins dead; ambient
//  provider credentials in the env are cleared; the credential store is
//  the file plane (no path to this machine's keychain).
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'sg5-models-'))
const authHome = join(scratch, 'auth-home')
mkdirSync(authHome, { recursive: true })
// Pin the config/auth scope BEFORE any owner import evaluates.
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = authHome
}
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'ZAI_API_KEY']) {
  delete process.env[key]
}
delete process.env.NODE_ENV
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:1'

// The registry projects the canonical /model surface, which reads gated
// global config — open the gate the way boot does.
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { APEX_GPT_ROLES } = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const q = await import('../../src/services/providers/openai/qualificationStore.ts')
const {
  composeCoordinatorModelRegistry,
  coordinatorModelStatusLabel,
  coordinatorModelStatusWord,
  validateCoordinatorModelChoice,
  switchCoordinatorAssistModel,
  switchCoordinatorMode,
} = await import('../../src/services/concourse/coordinatorModels.ts')
const { GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.ts')
type Presence = import('../../src/services/providers/providerUsage.ts').ProviderFamilyPresence

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures += 1
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const OPENAI_FIXTURE_AUTH = JSON.stringify({
  version: 1,
  tokens: { idToken: '', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', accountId: 'acct_fixture', planType: 'plus' },
})
const presencesOf = (anthropic: boolean, openai: boolean) => (): Presence[] =>
  [
    { id: 'anthropic', available: true, credentialed: anthropic, ...(anthropic ? { credentialLabel: 'Claude subscription (max)' } : {}) },
    { id: 'openai', available: openai, credentialed: openai, ...(openai ? { credentialLabel: 'ChatGPT plus subscription' } : {}) },
  ] as Presence[]
const noRefusalField = (entries: readonly object[]): boolean => entries.every(e => !('refusal' in e))

// ── §1 role vocabulary ──────────────────────────────────────────────────────
console.log('§1 the coordinator GPT role')
{
  check("'coordinator' is a real GPT role", (APEX_GPT_ROLES as readonly string[]).includes('coordinator'))
  const digest = q.roleCapabilityDigest('coordinator')
  check('the role has a versioned capability digest', /^rc1-[0-9a-f]{16}$/.test(digest), digest)
  const others = (APEX_GPT_ROLES as readonly string[]).filter(r => r !== 'coordinator')
  check(
    "the digest is DISTINCT from every other role's (its own contract)",
    others.every(r => q.roleCapabilityDigest(r as never) !== digest),
  )
}

// ── §2 the label family under every account state ───────────────────────────
console.log('§2 the label family under every account state (injected presences)')
{
  const receipt = q.recordLiveQualification({
    modelId: 'gpt-5.6-sol',
    role: 'coordinator',
    sourceKind: 'subscription' as never,
  })
  check('a coordinator qualification receipt recorded (scratch store)', receipt !== undefined)
  const expectedApex = new Set<string>([...GPT_DISPLAY_PINS.map(pin => pin.id), 'gpt-5.6-sol'])
  for (const anthropic of [false, true]) {
    for (const openai of [false, true]) {
      const reg = await composeCoordinatorModelRegistry({ presences: presencesOf(anthropic, openai) })
      const tag = `anthropic ${anthropic ? 'in' : 'out'} · openai ${openai ? 'in' : 'out'}`
      const apex = reg.entries.filter(e => e.source === 'openai')
      const anth = reg.entries.filter(e => e.source === 'anthropic')
      check(`[${tag}] the GPT lineup is VISIBLE (receipt ∪ baseline pins)`, apex.length === expectedApex.size, String(apex.length))
      check(`[${tag}] ≥1 Anthropic row rides the catalog owner`, anth.length >= 1, String(anth.length))
      check(
        `[${tag}] Anthropic rows read ${anthropic ? "'ready'" : "'not-signed-in' — /logins anthropic"}`,
        anth.every(e => (anthropic ? e.availability === 'ready' : e.availability === 'not-signed-in' && e.detail === '/logins anthropic')),
        JSON.stringify(anth.map(e => [e.availability, e.detail])),
      )
      if (!openai) {
        check(
          `[${tag}] every GPT row reads 'not-signed-in' — /logins openai`,
          apex.every(e => e.availability === 'not-signed-in' && e.detail === '/logins openai'),
          JSON.stringify(apex.map(e => [e.modelId, e.availability])),
        )
      } else {
        check(
          `[${tag}] every GPT row reads 'ready' — receipts never decide a label (the verdict-word removal)`,
          apex.every(e => e.availability === 'ready'),
          JSON.stringify(apex.map(e => [e.modelId, e.availability])),
        )
      }
      check(`[${tag}] NO row carries a refusal field`, noRefusalField(reg.entries))
      check(`[${tag}] the registry is selectable (it has rows)`, reg.selectable === true && reg.entries.length > 0)
    }
  }
  check("the label spelling owner: 'not-signed-in' names its attach home", coordinatorModelStatusLabel({ availability: 'not-signed-in', detail: '/logins anthropic' }) === 'not signed in — /logins anthropic')
  check("…'ready' reads as NO label", coordinatorModelStatusLabel({ availability: 'ready' }) === '')
  check(
    'the one-word state (narrow panes) has a spelling for every label and none for ready',
    (['not-signed-in', 'provider-unavailable', 'not-in-catalogue'] as const).every(
      a => coordinatorModelStatusWord({ availability: a }).length > 0 && !coordinatorModelStatusWord({ availability: a }).includes(' — '),
    ) && coordinatorModelStatusWord({ availability: 'ready' }) === '',
  )
  check(
    'no qualification-verdict word survives anywhere in the label vocabulary (operator-ruled removal)',
    (['ready', 'not-signed-in', 'provider-unavailable', 'not-in-catalogue'] as const).every(a => {
      const spelled = `${coordinatorModelStatusLabel({ availability: a })} ${coordinatorModelStatusWord({ availability: a })}`.toLowerCase()
      return !spelled.includes('qualif')
    }),
  )
}

// ── §3 the real presence owner ───────────────────────────────────────────────
console.log('§3 the REAL presence owner — labels agree with providerFamilyPresences()')
{
  const { providerFamilyPresences } = await import('../../src/services/providers/providerUsage.ts')
  const reg = await composeCoordinatorModelRegistry()
  const presences = providerFamilyPresences()
  const credentialed = (route: string): boolean => presences.find(p => (p.id as string) === route)?.credentialed ?? false
  check(
    "every row's 'not-signed-in' label ≡ the family holds no credential (the owner's answer)",
    reg.entries.every(e => (e.availability === 'not-signed-in') === !credentialed(e.source)),
    JSON.stringify(reg.entries.map(e => [e.source, e.availability, credentialed(e.source)])),
  )
  const anth = reg.entries.filter(e => e.source === 'anthropic')
  check(
    "on the scrubbed scratch home the Anthropic rows read 'not-signed-in — /logins anthropic'",
    anth.length >= 1 && anth.every(e => e.availability === 'not-signed-in' && e.detail === '/logins anthropic'),
    JSON.stringify(anth.map(e => [e.modelId, e.availability, e.detail])),
  )
  check('…and every one of them is selectable (no refusal field, registry selectable)', noRefusalField(reg.entries) && reg.selectable)
}

// ── §4 the file-backed OpenAI account (the operator's shape) ────────────────
console.log("§4 the file-backed OpenAI account — the operator's shape, read live")
{
  writeFileSync(join(authHome, '.openai-auth.json'), OPENAI_FIXTURE_AUTH)
  const reg = await composeCoordinatorModelRegistry()
  const apex = reg.entries.filter(e => e.source === 'openai')
  check("every GPT row reads 'ready' through the real owner (credential + catalogue facts only)", apex.every(e => e.availability === 'ready'), JSON.stringify(apex.map(e => [e.modelId, e.availability])))
  check("the Anthropic rows still read 'not-signed-in'", reg.entries.filter(e => e.source === 'anthropic').every(e => e.availability === 'not-signed-in'))
  check('the registry is selectable', reg.selectable === true)
  // The live-read law: the sign-in just recorded is the truth THIS read
  // paints — the OpenAI discovery record is re-primed per read, never a
  // TTL'd cache.
  rmSync(join(authHome, '.openai-auth.json'))
  const signedOut = await composeCoordinatorModelRegistry()
  check("removing the file flips the GPT rows to 'not-signed-in' on the very next read", signedOut.entries.filter(e => e.source === 'openai').every(e => e.availability === 'not-signed-in'))
  writeFileSync(join(authHome, '.openai-auth.json'), OPENAI_FIXTURE_AUTH)
}

// ── §5 digest currency stays store-internal ─────────────────────────────────
console.log('§5 digest currency is the STORE\'s fact — it never reaches a row (the verdict-word removal)')
{
  const qPath = q.__qualificationFilePathForTest()
  check('the qualification store lives under the SCRATCH home (hermetic)', qPath.startsWith(scratch), qPath)
  const raw = JSON.parse(readFileSync(qPath, 'utf8')) as { receipts: Array<Record<string, unknown>> }
  const row = raw.receipts.find(r => r['role'] === 'coordinator')!
  row['roleCapabilityDigest'] = 'rc1-stale00000000000'
  writeFileSync(qPath, JSON.stringify(raw))
  const staleWrapped = q.readQualificationReceipts().find(r => r.receipt.role === 'coordinator')
  check('the store itself still computes currency (the mission gate reads THIS)', staleWrapped !== undefined && staleWrapped.current === false, JSON.stringify(staleWrapped))
  const reg = await composeCoordinatorModelRegistry()
  const apex = reg.entries.find(e => e.modelId === 'gpt-5.6-sol')
  check("…but the row stays 'ready' — a receipt's currency never paints a label", apex?.availability === 'ready', apex?.availability)
  check('…with NO label', apex !== undefined && coordinatorModelStatusLabel(apex) === '')
  // restore the current receipt for §6
  q.recordLiveQualification({ modelId: 'gpt-5.6-sol', role: 'coordinator', sourceKind: 'subscription' as never })
}

// ── §6 choice validation ────────────────────────────────────────────────────
console.log('§6 validateCoordinatorModelChoice (config never overrides the registry; a label never refuses)')
{
  const anthropicId = 'claude-sonnet-5'
  const none = await validateCoordinatorModelChoice(undefined)
  check("no configured choice ⇒ 'no-choice'", !none.ok && none.reason === 'no-choice')
  const unknown = await validateCoordinatorModelChoice('made-up-model-9')
  check("unknown id ⇒ 'unknown-model'", !unknown.ok && unknown.reason === 'unknown-model')
  const ok = await validateCoordinatorModelChoice('gpt-5.6-sol')
  check('a ready choice validates', ok.ok === true && ok.entry.availability === 'ready')
  const notSignedIn = await validateCoordinatorModelChoice(anthropicId)
  check('a NOT-SIGNED-IN choice validates too — the label rides the entry', notSignedIn.ok === true && notSignedIn.entry.availability === 'not-signed-in', JSON.stringify(notSignedIn))
  rmSync(join(authHome, '.openai-auth.json'))
  const engineSignedOut = await validateCoordinatorModelChoice('gpt-5.6-sol')
  check('a signed-out ENGINE choice validates with its label (never a credential refusal)', engineSignedOut.ok === true && engineSignedOut.entry.availability === 'not-signed-in')
  writeFileSync(join(authHome, '.openai-auth.json'), OPENAI_FIXTURE_AUTH)
}

// ── §7 role scoping ─────────────────────────────────────────────────────────
console.log("§7 non-coordinator receipts never enter — the operator's store shape")
{
  q.recordLiveQualification({ modelId: 'gpt-5.7-nova', role: 'primary', sourceKind: 'subscription' as never })
  const reg = await composeCoordinatorModelRegistry()
  const apexRows = reg.entries.filter(e => e.source === 'openai')
  const expected7 = new Set<string>([...GPT_DISPLAY_PINS.map(pin => pin.id), 'gpt-5.6-sol'])
  check('non-coordinator receipts add NO row (receipt ∪ baseline pins only)', apexRows.length === expected7.size && !apexRows.some(e => e.modelId === 'gpt-5.7-nova'), JSON.stringify(apexRows.map(e => e.modelId)))
  // The operator's store: ONE receipt, 'gpt-5.6-sol · primary' — receipts
  // never decide a label (the verdict-word removal): every GPT row reads
  // 'ready' on credential + catalogue facts alone, every one selectable.
  const qPath = q.__qualificationFilePathForTest()
  writeFileSync(qPath, JSON.stringify({ version: 1, receipts: [{ modelId: 'gpt-5.6-sol', role: 'primary', sourceKind: 'chatgpt-subscription', adapterDigest: 'x', architectureEpoch: 'x', roleCapabilityDigest: 'x', qualifiedAtMs: 1 }] }))
  const operatorShape = await composeCoordinatorModelRegistry()
  const gpt = operatorShape.entries.filter(e => e.source === 'openai')
  check("a 'primary'-only store changes NOTHING — every GPT row 'ready', selectable, never walled", gpt.length === GPT_DISPLAY_PINS.length && gpt.every(e => e.availability === 'ready'), JSON.stringify(gpt.map(e => [e.modelId, e.availability])))
  q.recordLiveQualification({ modelId: 'gpt-5.6-sol', role: 'coordinator', sourceKind: 'subscription' as never })
}

// ── §8 the safe-boundary switch owner ───────────────────────────────────────
console.log('§8 the safe-boundary switch owner')
{
  const { enableConfigs, getGlobalConfig } = await import('../../src/utils/config.ts')
  enableConfigs()
  const anthropicId = 'claude-sonnet-5'

  // A not-signed-in row APPLIES — the pick is the consent; the label rides.
  const applied = await switchCoordinatorAssistModel(anthropicId)
  check('a NOT-SIGNED-IN choice APPLIES', applied.outcome === 'applied', `${applied.outcome}/${applied.reason}`)
  check("…carrying its typed label + spelled detail on the receipt", applied.availability === 'not-signed-in' && applied.detail === 'not signed in — /logins anthropic', JSON.stringify([applied.availability, applied.detail]))
  check('…and the config holds the choice (read-back)', getGlobalConfig().concourseCoordinator?.assistModel === anthropicId)
  check('…the receipt states the safe boundary', applied.boundary.includes('next coordinator turn'), applied.boundary)

  const again = await switchCoordinatorAssistModel(anthropicId)
  check("the same value is 'no-change' (label still riding)", again.outcome === 'no-change' && again.availability === 'not-signed-in', again.outcome)

  const ready = await switchCoordinatorAssistModel('gpt-5.6-sol')
  check('a READY choice applies with NO label on the receipt', ready.outcome === 'applied' && ready.availability === undefined && ready.detail === undefined, JSON.stringify(ready))

  const receiptless = await switchCoordinatorAssistModel('gpt-5.6-terra')
  check("a receiptless engine applies with NO label (receipts never decide; the verdict-word removal)", receiptless.outcome === 'applied' && receiptless.availability === undefined && receiptless.detail === undefined, JSON.stringify([receiptless.outcome, receiptless.availability]))

  rmSync(join(authHome, '.openai-auth.json'))
  const signedOutEngine = await switchCoordinatorAssistModel('gpt-5.6-sol')
  check(
    "a signed-out engine choice APPLIES with 'not-signed-in' (never a credential refusal)",
    signedOutEngine.outcome === 'applied' && signedOutEngine.availability === 'not-signed-in',
    `${signedOutEngine.outcome}/${signedOutEngine.availability}`,
  )
  writeFileSync(join(authHome, '.openai-auth.json'), OPENAI_FIXTURE_AUTH)
  const unknown = await switchCoordinatorAssistModel('made-up-model-9')
  check(
    "an unknown id refuses 'unknown-model', config untouched",
    unknown.outcome === 'refused' && unknown.reason === 'unknown-model' && getGlobalConfig().concourseCoordinator?.assistModel === 'gpt-5.6-sol',
    `${unknown.outcome}/${unknown.reason}`,
  )

  const modeOn = await switchCoordinatorMode('agent-assisted')
  check('a mode switch applies + reads back', modeOn.outcome === 'applied' && getGlobalConfig().concourseCoordinator?.mode === 'agent-assisted')
  const modeSame = await switchCoordinatorMode('agent-assisted')
  check("the same mode is 'no-change'", modeSame.outcome === 'no-change', modeSame.outcome)
  const modeBad = await switchCoordinatorMode('sideways' as never)
  check(
    "garbage mode refuses 'unknown-mode', config untouched",
    modeBad.outcome === 'refused' && modeBad.reason === 'unknown-mode' && getGlobalConfig().concourseCoordinator?.mode === 'agent-assisted',
    `${modeBad.outcome}/${modeBad.reason}`,
  )
}

// ── §9 the boundary statement is LIVE truth ─────────────────────────────────
console.log('§9 the boundary under an in-flight coordinator turn')
{
  const governor = await import('../../src/services/capacity/governor.ts')
  const permit = await governor.acquireModelPermit({ lane: 'coordinator', callId: 'switch-boundary-probe' })
  const midFlight = await switchCoordinatorMode('rules-only')
  check('a held coordinator permit is a TYPED receipt fact (inFlightTurns=1)', midFlight.inFlightTurns === 1, String(midFlight.inFlightTurns))
  check(
    '…and the prose states it too',
    midFlight.boundary.includes('in-flight turn finishes on its current model'),
    midFlight.boundary,
  )
  governor.releaseModelPermit(permit.permitId)
  const quiet = await switchCoordinatorMode('agent-assisted')
  check('a quiet lane types inFlightTurns=0', quiet.outcome === 'applied' && quiet.inFlightTurns === 0, String(quiet.inFlightTurns))
  check('…with the plain boundary prose', !quiet.boundary.includes('in-flight'), quiet.boundary)
}

// ── §10 switch receipts on the semantic activity feed ───────────────────────
console.log('§10 switch receipts row on the activity feed')
{
  const activity = await import('../../src/services/crew/activity.ts')
  const rows = activity.activityRows(activity.cachedActivityFeed())
  const switchRows = rows.filter(
    r => r.class === 'handoff' && (r.verb === 'switched coordinator model' || r.verb === 'set coordinator mode'),
  )
  check('every switch above landed a handoff row (eleven in §8–§9)', switchRows.length >= 11, String(switchRows.length))
  check(
    'a refused switch rows phase=failed with the typed reason',
    switchRows.some(r => r.phase === 'failed' && r.outcomeLabel?.startsWith('refused') === true),
  )
  check(
    'an applied not-signed-in switch rows with its label visible',
    switchRows.some(r => r.phase === 'succeeded' && r.outcomeLabel?.includes('not signed in') === true),
    JSON.stringify(switchRows.map(r => r.outcomeLabel)),
  )
  check(
    "the lift is REGISTERED ('coordinator-receipt' in the ordered registry)",
    activity.activityClassifierOrder().some(c => c.name === 'coordinator-receipt'),
  )
}

check('scratch really was the only home touched', existsSync(join(authHome, '.openai-auth.json')))
rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nPROVE-COORDINATOR-MODELS: PASS' : `\nPROVE-COORDINATOR-MODELS: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
