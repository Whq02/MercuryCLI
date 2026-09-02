#!/usr/bin/env bun
// ============================================================================
//  scripts/harness-profiles/prove-ch2-application.ts — the CH-2 application proofs:
//  §A the off-flag certificate (CH-41): unset ⇒ NO resolution work at all;
//  §B armed resolution from OWNER facts + the O(1) steady state (CH-28) +
//     the bounded receipt ring;
//  §C the env session pin with NAMED fallthrough (the campaign instrument);
//  §D facts come from the owning resolvers, never display labels (CH-09),
//     with the CH-14 conservative default live through the application;
//  §E THE BYTE-EQUIVALENCE CERTIFICATE (CH-15), baseline-first per provider
//     family: encode bytes with the flag OFF, arm the flag + resolve, encode
//     again — byte-identical digests on the anthropic, openai, and zai
//     encode paths;
//  §F no prompt fork (CH-17): the prompt owners import nothing of the
//     harness system;
//  §G the flag family is REGISTERED with the inventory regenerated (CH-41).
//
//  Env hygiene: this prover pins its environment explicitly (fixture config
//  home outside the repo, fixture API key, explicit flag values per leg) and
//  never reads ambient operator state.
// ============================================================================
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// Pin the environment BEFORE the provider stack loads (the encode-loss
// inventory preamble): fixture config home, fixture key, flag explicitly
// absent for the baseline legs.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'harness-ch2-config-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'
// The config boot gate (the CH-3 persisted pin reads the config owner):
// provers run in test mode — in-memory config, no operator file reads.
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HARNESS_PROFILE
delete process.env.MERCURY_HARNESS_PROFILE_PIN

const ROOT = join(import.meta.dir, '..', '..')

const { _harnessResolveComputeCount } = await import('../../src/services/mission/harnessProfiles.ts')
const {
  buildHarnessModelFacts,
  harnessBoundaryReceipts,
  harnessProfileArmed,
  noteHarnessBoundary,
  resolveActiveHarnessProfile,
} = await import('../../src/services/mission/harnessApplication.ts')
const { toBridgeMessages } = await import('../../src/services/providers/openai/openaiCallModel.ts')
const { mapMessagesToOpenaiInput } = await import('../../src/services/providers/openai/responsesBridge.ts')
const { mapMessagesToZai } = await import('../../src/services/providers/zai/zaiCodec.ts')
const { normalizeMessagesForAPI } = await import('../../src/utils/messages/apiView.ts')
const { userMessageToMessageParam, assistantMessageToMessageParam } = await import(
  '../../src/services/providers/anthropic/messageParams.ts'
)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
const digest = (v: unknown): string => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)

// ── the shared message fixture (internal transcript shape) ──────────────────
const at = '2026-08-06T00:00:00.000Z'
const fixtureMessages = [
  {
    type: 'user',
    uuid: '00000000-0000-4000-9000-00000000c201',
    timestamp: at,
    message: { role: 'user', content: 'read the file and summarize it' },
  },
  {
    type: 'assistant',
    uuid: '00000000-0000-4000-9000-00000000c202',
    timestamp: at,
    message: {
      id: 'msg_c202',
      type: 'message',
      role: 'assistant',
      model: 'claude-fable-5',
      content: [
        { type: 'text', text: 'reading it now' },
        { type: 'tool_use', id: 'toolu_c2', name: 'Read', input: { file_path: '/tmp/x' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 10 },
    },
  },
  {
    type: 'user',
    uuid: '00000000-0000-4000-9000-00000000c203',
    timestamp: at,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_c2', content: 'file bytes here' }] },
  },
  {
    type: 'assistant',
    uuid: '00000000-0000-4000-9000-00000000c204',
    timestamp: at,
    message: {
      id: 'msg_c204',
      type: 'message',
      role: 'assistant',
      model: 'claude-fable-5',
      content: [{ type: 'text', text: 'summary: a small file' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 12, output_tokens: 8 },
    },
  },
] as never[]

const zaiParamFixture = [
  { role: 'user' as const, content: 'hello' },
  { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'hi' }] },
  { role: 'user' as const, content: [{ type: 'text' as const, text: 'continue' }] },
]

function encodeAllFamilies(): { anthropic: string; openai: string; zai: string } {
  const normalized = normalizeMessagesForAPI(fixtureMessages as never)
  const anthropicParams = normalized.map(m =>
    (m as { type: string }).type === 'user'
      ? userMessageToMessageParam(m as never, false, false, undefined)
      : assistantMessageToMessageParam(m as never, false, false, undefined),
  )
  const bridge = toBridgeMessages(fixtureMessages as never, undefined as never, 'gpt-5.2')
  const openaiItems = mapMessagesToOpenaiInput(bridge.rows, { imagesSupported: true } as never)
  const zaiMessages = mapMessagesToZai('system prompt bytes', zaiParamFixture as never)
  return { anthropic: digest(anthropicParams), openai: digest(openaiItems), zai: digest(zaiMessages) }
}

console.log('§A the off-flag certificate (CH-41): unset ⇒ no resolution work at all')
check('§A flag reads OFF (explicitly unset for the baseline)', !harnessProfileArmed())
const computeBefore = _harnessResolveComputeCount()
check('§A resolveActiveHarnessProfile → null', resolveActiveHarnessProfile({ model: 'claude-fable-5' }) === null)
check('§A noteHarnessBoundary → null (both boundaries)', noteHarnessBoundary('main-loop', 'claude-fable-5') === null && noteHarnessBoundary('subagent-spawn', 'claude-opus-5') === null)
check('§A ZERO resolver computes while off', _harnessResolveComputeCount() === computeBefore, String(_harnessResolveComputeCount() - computeBefore))
check('§A no receipts minted while off', harnessBoundaryReceipts().length === 0)

// ── the byte baseline FIRST ────
const baseline = encodeAllFamilies()

console.log('§B armed resolution + O(1) steady state (CH-28)')
process.env.MERCURY_HARNESS_PROFILE = 'on'
check('§B flag reads ARMED live', harnessProfileArmed())
const r = resolveActiveHarnessProfile({ model: 'claude-fable-5' })
check('§B anthropic model → the anthropic accepted default', r !== null && r.profileId === 'anthropic-default' && r.origin === 'accepted-default')
const armedComputeAfterFirst = _harnessResolveComputeCount()
for (let i = 0; i < 1000; i++) resolveActiveHarnessProfile({ model: 'claude-fable-5' })
check('§B 1000 repeated resolutions compute ZERO more times (cache)', _harnessResolveComputeCount() === armedComputeAfterFirst, String(_harnessResolveComputeCount() - armedComputeAfterFirst))
const mainRes = noteHarnessBoundary('main-loop', 'claude-fable-5')
noteHarnessBoundary('main-loop', 'claude-fable-5')
noteHarnessBoundary('main-loop', 'claude-fable-5')
check('§B main-loop receipts append only when the resolution MOVES', mainRes !== null && harnessBoundaryReceipts().filter(x => x.boundary === 'main-loop').length === 1)
for (let i = 0; i < 40; i++) noteHarnessBoundary('subagent-spawn', 'claude-opus-5')
check('§B the receipt ring is bounded (≤32)', harnessBoundaryReceipts().length <= 32, String(harnessBoundaryReceipts().length))
const spawnReceipt = harnessBoundaryReceipts().find(x => x.boundary === 'subagent-spawn')
check('§B a spawn receipt carries id/digest/origin/reason/factsDigest/epoch', spawnReceipt !== undefined && spawnReceipt.profileId === 'anthropic-default' && spawnReceipt.profileDigest.startsWith('hpr1-') && spawnReceipt.factsDigest.startsWith('hf1-') && spawnReceipt.evidenceEpoch.startsWith('he1-'))

console.log('§C the env session pin (the campaign instrument)')
process.env.MERCURY_HARNESS_PROFILE_PIN = 'zai-default'
const pinnedWrongFamily = resolveActiveHarnessProfile({ model: 'claude-fable-5' })
check(
  '§C a family-incompatible pin falls through NAMED to the accepted default',
  pinnedWrongFamily !== null &&
    pinnedWrongFamily.profileId === 'anthropic-default' &&
    pinnedWrongFamily.declined.some(d => d.profileId === 'zai-default' && d.reason === 'pin-incompatible-fallthrough'),
)
process.env.MERCURY_HARNESS_PROFILE_PIN = 'anthropic-default'
const pinnedRight = resolveActiveHarnessProfile({ model: 'claude-fable-5' })
check('§C a valid pin wins as origin session-pin', pinnedRight !== null && pinnedRight.origin === 'session-pin' && pinnedRight.reasonCodes[0] === 'session-pin-wins')
delete process.env.MERCURY_HARNESS_PROFILE_PIN

console.log('§D facts from the owning resolvers (CH-09) + CH-14 live')
const fableFacts = buildHarnessModelFacts('fable')
check("§D the 'fable' alias resolves through the model owner to a KNOWN anthropic fable id", fableFacts.providerFamily === 'anthropic' && fableFacts.modelFamily === 'fable' && fableFacts.modelKnown && fableFacts.modelId.startsWith('claude-fable-'))
const opusFacts = buildHarnessModelFacts('claude-opus-5')
check('§D opus-5 → anthropic/opus, known', opusFacts.providerFamily === 'anthropic' && opusFacts.modelFamily === 'opus' && opusFacts.modelKnown)
const glmFacts = buildHarnessModelFacts('glm-5')
check('§D glm-5 → zai/glm (the router prefix law is the lane catalogue)', glmFacts.providerFamily === 'zai' && glmFacts.modelFamily === 'glm' && glmFacts.modelKnown)
const gptFacts = buildHarnessModelFacts('gpt-5.6-sol')
check('§D gpt-5.6-sol → openai/gpt; a COLD catalogue cache reads unknown (conservative, never a guess)', gptFacts.providerFamily === 'openai' && gptFacts.modelFamily === 'gpt' && gptFacts.modelKnown === false)
const gptRes = resolveActiveHarnessProfile({ model: 'gpt-5.6-sol' })
check('§D the unknown-gpt resolution is the openai family default with the NAMED conservative reason', gptRes !== null && gptRes.profileId === 'openai-default' && gptRes.reasonCodes[0] === 'unknown-model-conservative-default')
const bogusFacts = buildHarnessModelFacts('claude-zzz-99')
check('§D an unrecognized claude id is UNKNOWN (owner catalogues, not name shape)', bogusFacts.providerFamily === 'anthropic' && bogusFacts.modelKnown === false)
const nullModel = buildHarnessModelFacts(null)
check("§D a null model takes the owner's own default answer (known)", nullModel.modelKnown && nullModel.providerFamily === 'anthropic')

console.log('§E THE BYTE-EQUIVALENCE CERTIFICATE (CH-15) — armed vs baseline, per family')
check('§E armed while encoding (the certificate condition)', harnessProfileArmed())
resolveActiveHarnessProfile({ model: 'claude-fable-5' })
const armed = encodeAllFamilies()
check('§E anthropic encode bytes identical', armed.anthropic === baseline.anthropic, `${baseline.anthropic} vs ${armed.anthropic}`)
check('§E openai encode bytes identical', armed.openai === baseline.openai, `${baseline.openai} vs ${armed.openai}`)
check('§E zai encode bytes identical', armed.zai === baseline.zai, `${baseline.zai} vs ${armed.zai}`)
delete process.env.MERCURY_HARNESS_PROFILE

console.log('§F no prompt fork (CH-17): the prompt owners never import the harness system')
const promptGrep = (() => {
  try {
    return execFileSync('git', ['grep', '-l', '-E', 'harnessProfiles|harnessApplication', '--', 'src/prompt/', 'src/constants/prompts.ts', 'src/constants/system.ts'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
  } catch {
    return [] as string[]
  }
})()
check('§F zero harness imports in the prompt owners', promptGrep.length === 0, promptGrep.join(','))

console.log('§G the flag family is registered (CH-41)')
const registry = readFileSync(join(ROOT, 'src/substrate/flagRegistry.ts'), 'utf8')
check('§G MERCURY_HARNESS_PROFILE registered with its consumer', /MERCURY_HARNESS_PROFILE'[^\n]*harnessApplication/.test(registry))
check('§G MERCURY_HARNESS_PROFILE_PIN registered with its consumer', /MERCURY_HARNESS_PROFILE_PIN'[^\n]*harnessApplication/.test(registry))
check('§G the registry carries both rows', registry.includes("env: 'MERCURY_HARNESS_PROFILE'") && registry.includes("env: 'MERCURY_HARNESS_PROFILE_PIN'"))

console.log('§H the fold: MercurySessionProfile gains the harness component ADDITIVELY')
const { resolveMercurySessionProfile, MERCURY_BEHAVIOR_PROFILE } = await import('../../src/utils/profile/mercuryProfile.ts')
const appearanceStub = { changedAt: 7 } as never
const oneArg = resolveMercurySessionProfile(appearanceStub)
check('§H one-argument composition = the bare profile (no harness field)', !('harness' in oneArg) && oneArg.identity === MERCURY_BEHAVIOR_PROFILE && oneArg.changedAt === 7)
process.env.MERCURY_HARNESS_PROFILE = 'on'
const liveRes = resolveActiveHarnessProfile({ model: 'claude-fable-5' })
const twoArg = resolveMercurySessionProfile(appearanceStub, liveRes)
check('§H the harness snapshot is the additive component', twoArg.harness !== undefined && twoArg.harness.profileId === 'anthropic-default' && Object.isFrozen(twoArg))
check('§H the identity floor is untouched by the harness component', twoArg.identity === MERCURY_BEHAVIOR_PROFILE)
const nullFold = resolveMercurySessionProfile(appearanceStub, null)
check('§H a null harness (flag off) composes the bare profile', !('harness' in nullFold))
delete process.env.MERCURY_HARNESS_PROFILE

console.log(failures === 0 ? '\nprove-ch2-application: green' : `\nprove-ch2-application: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
