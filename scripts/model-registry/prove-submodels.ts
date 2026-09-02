#!/usr/bin/env bun
// ============================================================================
//  scripts/model-registry/prove-submodels.ts — the two SUB-model containers
//  (Minerva · Console): the derivation, the routing, the persistence ladder,
//  and the refusal grammar, over injected reads (hermetic).
//
//    · DERIVATION — rows and families derive from the injected catalogue and
//      presence enumeration: family order = first appearance, labels = the
//      one provider naming owner, sentinels/actions excluded,
//      one model one row, and an unknown future family surfaces by itself
//      (never silent, no edit here).
//    · SIGNED-OUT ROUTING — a credential-less family's rows are the ROUTE to
//      its own attach home; a credentialed family's catalogue refusal rides
//      the rows verbatim.
//    · SERVE LAW — Console serves on every wire; Minerva's schema-forced
//      plans refuse wires without structured output, per model on the home
//      lane and per adapter declaration elsewhere.
//    · PERSISTENCE — env pin > saved pick > the per-container tier default
//      (minerva light · console heavyweight); the
//      writer stores only selectable picks (canonicalized) and a refused
//      write leaves the config untouched; the env pin refuses writes naming
//      itself.
//    · ONE CREDENTIAL TRUTH (§7, real owners, no injection) — the presence
//      enumeration behind the registry follows the OWNING account resolvers
//      LIVE: a credential written or removed mid-session (the /logins
//      journey) is seen by the very next read, per family; a discovery
//      record primed before a sign-in never outlives it (the operator's
//      repro: /submodels answered "no GPT credential" over a
//      signed-in home for the rest of the session).
//
//  Run:  ~/.bun/bin/bun run scripts/model-registry/prove-submodels.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'submodels-proof-'))
delete process.env.MERCURY_MINERVA_MODEL
delete process.env.MERCURY_CONSOLE_MODEL
// The credential-gate checks read the home's REAL presence: the hosted gate
// injects a proof ANTHROPIC_API_KEY for every job, so the ambient env must be
// cleared here or 'no credential on this home' is false on the runner.
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_OAUTH_TOKEN_FILE_DESCRIPTOR']) {
  delete process.env[key]
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const {
  canonicalSubModelId,
  composeSubModelRegistry,
  consoleModelOverride,
  resolveSubModel,
  setSubModel,
  subModelConnectHome,
  subModelIdentityLine,
} = await import('../../src/utils/model/subModelSlots.ts')
const { providerDisplayName } = await import('../../src/services/providers/routeLaw.ts')
const { getGlobalConfig } = await import('../../src/utils/config.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

// ── the injected world ──────────────────────────────────────────────────────
// A catalogue in the /model option shape, presences in the /accounts shape,
// and adapter descriptions carrying the capability vocabulary — nothing here
// re-spells production ids into the module under proof.
// SYNTHETIC catalog SHAPE for this prover — the ids are deliberately NOT
// current (gpt-5.2, deepseek-chat-4, …): the derivation under proof needs
// stable, distinguishable rows in the /model option shape, never the live
// lineup (gptPins.ts and the live catalogue feeds own that). Do not
// version-bump these to chase the product.
// Model rows carry EMPTY descriptions (the neutrality ruling) —
// the Default row states its resolution, sentinel/action rows keep their
// own copy; the derivation under proof reads none of them editorially.
const options = () => [
  { value: null, label: 'Recommended', description: 'Default (Fable 5)' },
  { value: 'fable', label: 'Fable 5', description: '' },
  { value: 'claude-fable-5', label: 'Fable 5', description: '' },
  { value: 'opus', label: 'Opus 4.8', description: '' },
  { value: '__scribe_router__', label: 'Scribe', description: 'mode sentinel' },
  { value: '__mercury_connect__:moonshot', label: 'Moonshot — attach a key', description: 'action row' },
  { value: 'gpt-5.2', label: 'GPT-5.2 Sol', description: '' },
  { value: 'kimi-k3', label: 'Kimi K3', description: '', unavailable: 'no API key attached' },
  { value: 'deepseek-chat-4', label: 'DeepSeek Chat', description: '', unavailable: 'live catalogue unavailable (offline)' },
]
const presences = () => [
  { id: 'anthropic', available: true, credentialed: true, credentialLabel: 'Claude subscription (max)' },
  { id: 'openai', available: true, credentialed: false },
  { id: 'moonshot', available: true, credentialed: false },
  { id: 'deepseek', available: true, credentialed: true, credentialLabel: 'DeepSeek API key' },
  { id: 'gemini', available: true, credentialed: false },
  { id: 'openai-compat', available: true, credentialed: false },
  { id: 'lumen', available: true, credentialed: false },
]
const providers = () =>
  [
    { id: 'anthropic', description: { capabilities: ['streaming', 'tool-calls', 'structured-output'] } },
    { id: 'openai', description: { capabilities: ['streaming', 'tool-calls', 'structured-output'] } },
    { id: 'moonshot', description: { capabilities: ['streaming', 'tool-calls'] } },
    { id: 'deepseek', description: { capabilities: ['streaming', 'tool-calls'] } },
  ] as never
const reads = { options, presences, providers } as never

section('1 · derivation — rows and families from the registry, nothing re-spelled')
{
  const registry = composeSubModelRegistry(reads)
  const ids = registry.entries.map(entry => entry.modelId)
  check('the Default row never becomes an entry', !ids.includes('default'))
  check('mode sentinels excluded', !ids.some(id => id.startsWith('__')))
  check(
    'connect ACTION rows excluded from the model walk',
    !registry.entries.some(entry => entry.kind === 'model' && entry.modelId.includes('connect')),
  )
  check(
    'one model one row (alias + canonical fold)',
    ids.filter(id => id === 'claude-fable-5').length === 1,
  )
  const familyOrder = registry.families.map(family => family.source)
  check(
    'family order = first appearance over the entries',
    familyOrder.indexOf('anthropic') === 0 &&
      familyOrder.indexOf('openai') !== -1 && familyOrder.indexOf('openai') < familyOrder.indexOf('moonshot'),
    familyOrder.join(','),
  )
  check(
    'family labels come from the one naming owner',
    registry.families.every(family => family.label === providerDisplayName(family.source)),
  )
  check(
    'sign-in facts ride the family (the /accounts words)',
    registry.families.find(family => family.source === 'anthropic')?.credentialLabel ===
      'Claude subscription (max)',
  )
  const unknown = registry.entries.find(entry => entry.source === ('lumen' as never))
  check(
    'an unknown future family surfaces by itself (connect row, its own name)',
    unknown !== undefined && unknown.kind === 'connect' && unknown.state === 'signed-out',
  )
  const gemini = registry.entries.find(entry => entry.source === 'gemini')
  check(
    'a live-only catalogue family signed out still shows (connect row)',
    gemini !== undefined && gemini.kind === 'connect' && gemini.state === 'signed-out',
  )
}

section('2 · signed-out routing — the row IS the route to the attach home')
{
  const registry = composeSubModelRegistry(reads)
  const gpt = registry.entries.find(entry => entry.modelId === 'gpt-5.2')
  check(
    'credential-less family ⇒ signed-out rows',
    gpt?.state === 'signed-out',
    JSON.stringify(gpt),
  )
  check('the openai attach home is /logins with the family named', gpt?.connect?.command === '/logins openai')
  const kimi = registry.entries.find(entry => entry.modelId === 'kimi-k3')
  check(
    "a key lane's attach home is its /logins row (the family pre-focused)",
    kimi?.state === 'signed-out' && kimi.connect?.command === '/logins moonshot',
  )
  const deepseek = registry.entries.find(entry => entry.modelId === 'deepseek-chat-4')
  check(
    "a credentialed family's catalogue refusal rides the row VERBATIM",
    deepseek?.state === 'refused' && deepseek.reason === 'live catalogue unavailable (offline)',
  )
  check(
    'the compat home is configuration, not a surface (no command)',
    subModelConnectHome('openai-compat').command === undefined,
  )
  check('an unknown family routes to generic /logins', subModelConnectHome('lumen').command === '/logins')
  check(
    'huggingface routes with the family PRE-FOCUSED (the /logins menu carries its row)',
    subModelConnectHome('huggingface').command === '/logins huggingface',
  )
  check(
    'local names the no-sign-in truth (no command — a discovered server IS the credential)',
    subModelConnectHome('local').command === undefined &&
      subModelConnectHome('local').note.includes('no sign-in'),
  )
}

section('3 · ONE catalogue for both containers — no serve law, no tier (ruled)')
{
  // The derivation takes no container: the same row set, the same states,
  // whoever asks. A wire without a schema-forced output format is NOT a
  // refusal — Minerva is prompted for its JSON there and decodes tolerantly.
  const registry = composeSubModelRegistry(reads)
  check(
    'no row is refused for a serve reason (the container decides nothing)',
    registry.entries.every(
      entry =>
        !String(entry.reason ?? '').includes('structured output') &&
        !String(entry.reason ?? '').includes("Minerva's plans"),
    ),
    JSON.stringify(registry.entries.map(e => [e.modelId, e.state, e.reason])),
  )
  const kimi = registry.entries.find(entry => entry.modelId === 'kimi-k3')
  check(
    'a wire without structured output keeps its sign-in state (never serve-refused)',
    kimi?.state === 'signed-out' && kimi.connect?.command === '/logins moonshot',
    JSON.stringify(kimi),
  )
  const gpt = registry.entries.find(entry => entry.modelId === 'gpt-5.2')
  check('a declaring wire keeps its sign-in state too', gpt?.state === 'signed-out')
  const slotsSrc = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'utils', 'model', 'subModelSlots.ts'),
    'utf-8',
  )
  check(
    'the derivation takes no container (one row set, structurally)',
    /export function composeSubModelRegistry\(reads/.test(slotsSrc),
  )
  check(
    'no serve check survives in the owner',
    !slotsSrc.includes('subModelServeCheck') && !slotsSrc.includes('modelSupportsStructuredOutputs'),
  )
  check(
    'no tier owner is imported (providerFrontier · 1M access · opus default · subModelDefault)',
    !slotsSrc.includes('providerFrontier') &&
      !slotsSrc.includes('checkOpus1mAccess') &&
      !slotsSrc.includes('getDefaultOpusModel') &&
      !slotsSrc.includes('subModelDefault'),
  )
}

section("3b · THE UNSET DEFAULT (the operator's word) — the choice is the operator's")
{
  const { SUB_MODEL_UNSET_HINT } = await import('../../src/utils/model/subModelSlots.ts')
  check(
    "the hint is the ruling's words, verbatim",
    SUB_MODEL_UNSET_HINT === 'use /submodels to pin one of the available model catalogues',
  )
  // Whatever the main model's family — anthropic, openai, gemini, an
  // OpenRouter carrier (the operator's own saved main) — an unpinned
  // container resolves UNSET with the hint. No family default derives.
  const priorModel = process.env.ANTHROPIC_MODEL
  for (const main of [
    'claude-fable-5',
    'gpt-5.6-sol',
    'gemini-2.5-pro',
    'openrouter/nvidia/nemotron-3.5-lightning:free',
  ]) {
    process.env.ANTHROPIC_MODEL = main
    for (const container of ['minerva', 'console'] as const) {
      const resolution = resolveSubModel(container)
      check(
        `main ${main}: ${container} resolves UNSET with the hint`,
        resolution.origin === 'unset' && resolution.hint === SUB_MODEL_UNSET_HINT,
        JSON.stringify(resolution),
      )
    }
  }
  if (priorModel === undefined) delete process.env.ANTHROPIC_MODEL
  else process.env.ANTHROPIC_MODEL = priorModel
}

section('4 · persistence — env pin > saved pick > UNSET')
{
  const initial = resolveSubModel('console')
  check('nothing saved ⇒ UNSET origin', initial.origin === 'unset', JSON.stringify(initial))
  const written = setSubModel('console', 'fable[1m]', reads)
  check('a selectable pick lands with a receipt', written.ok, JSON.stringify(written))
  check(
    'the stored pick is CANONICAL (alias resolved, [1m] folded)',
    getGlobalConfig().subModels?.console === canonicalSubModelId('fable[1m]'),
    String(getGlobalConfig().subModels?.console),
  )
  const saved = resolveSubModel('console')
  check('saved origin resolves', saved.origin === 'saved' && saved.model === canonicalSubModelId('fable'))

  const refused = setSubModel('console', 'gpt-5.2', reads)
  check('a signed-out pick is refused typed', !refused.ok)
  check(
    'a refused write leaves the config untouched',
    getGlobalConfig().subModels?.console === canonicalSubModelId('fable'),
  )
  const unknown = setSubModel('console', 'no-such-model-9', reads)
  check('an unknown id is refused', !unknown.ok && String((unknown as { reason: string }).reason).includes('not in the live catalogue'))

  process.env.MERCURY_CONSOLE_MODEL = 'kimi-k3'
  const pinned = resolveSubModel('console')
  check(
    'the env pin outranks the saved pick and NAMES itself',
    pinned.origin === 'env' && pinned.model === 'kimi-k3' && pinned.envVar === 'MERCURY_CONSOLE_MODEL',
  )
  const lockedWrite = setSubModel('console', 'fable', reads)
  check(
    'a pinned container refuses writes naming the var',
    !lockedWrite.ok && String((lockedWrite as { reason: string }).reason).includes('MERCURY_CONSOLE_MODEL'),
  )
  delete process.env.MERCURY_CONSOLE_MODEL

  const cleared = setSubModel('console', null, reads)
  check('null clears back to UNSET', cleared.ok && resolveSubModel('console').origin === 'unset')
  check(
    'the clearing receipt carries the hint (the operator reads what an ask will answer)',
    cleared.ok && cleared.receipt.includes('use /submodels to pin one of the available model catalogues'),
    JSON.stringify(cleared),
  )
  check(
    'clearing the last saved pick leaves NO residue key',
    getGlobalConfig().subModels === undefined,
    JSON.stringify(getGlobalConfig().subModels),
  )

  check(
    'the two containers persist independently',
    (() => {
      const wrote = setSubModel('minerva', 'opus', reads)
      const minerva = resolveSubModel('minerva')
      const consoleRes = resolveSubModel('console')
      return wrote.ok && minerva.origin === 'saved' && consoleRes.origin === 'unset'
    })(),
  )

  // A SIMULATED RESTART: a fresh process on the same config home (the
  // saved-pick path is the persistence — nothing in memory carries over)
  // resolves the minerva pick written above. The child is a real process
  // boundary, not a cache reset.
  {
    const { spawnSync } = await import('node:child_process')
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        [
          `globalThis.MACRO = { VERSION: '1.0.0' }`,
          `const { enableConfigs } = await import(${JSON.stringify(join(import.meta.dir, '..', '..', 'src', 'utils', 'config.ts'))})`,
          `enableConfigs()`,
          `const { resolveSubModel } = await import(${JSON.stringify(join(import.meta.dir, '..', '..', 'src', 'utils', 'model', 'subModelSlots.ts'))})`,
          `console.log(JSON.stringify({ minerva: resolveSubModel('minerva'), console: resolveSubModel('console') }))`,
        ].join('\n'),
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, MERCURY_CONFIG_DIR: process.env.MERCURY_CONFIG_DIR as string },
        timeout: 60_000,
      },
    )
    const line = (child.stdout ?? '').trim().split('\n').at(-1) ?? ''
    let restarted: { minerva?: { origin?: string; model?: string }; console?: { origin?: string } } = {}
    try {
      restarted = JSON.parse(line) as typeof restarted
    } catch {
      restarted = {}
    }
    check(
      'a fresh process resolves the persisted minerva pick (survives a restart)',
      child.status === 0 &&
        restarted.minerva?.origin === 'saved' &&
        restarted.minerva?.model === canonicalSubModelId('opus'),
      `status=${String(child.status)} stdout=${line.slice(0, 200)} stderr=${(child.stderr ?? '').slice(0, 200)}`,
    )
    check(
      '…and the never-pinned console is still UNSET there',
      restarted.console?.origin === 'unset',
      JSON.stringify(restarted.console),
    )
  }
  setSubModel('minerva', null, reads)
}

section('5 · the console dispatch read — override only on a real difference, nothing when unset')
{
  check(
    'an UNSET console overrides nothing (it never dispatches)',
    resolveSubModel('console').origin === 'unset' && consoleModelOverride('gpt-5.2') === undefined,
  )
  const wrote = setSubModel('console', 'opus', reads)
  check('seed pick landed', wrote.ok)
  const pinned = resolveSubModel('console')
  const resolved = pinned.origin === 'unset' ? '' : pinned.model
  check('the pick resolves as a saved pin', pinned.origin === 'saved' && resolved !== '')
  check(
    'an identical session model ⇒ NO override (the cache-hit prefix survives)',
    consoleModelOverride(resolved) === undefined && consoleModelOverride(`${resolved}[1m]`) === undefined,
  )
  check(
    'a different session model ⇒ the resolved pick overrides',
    consoleModelOverride('gpt-5.2') === resolved,
  )
  setSubModel('console', null, reads)
}

section('6 · the frontier row — an ordinary tier row of the SHARED catalog (ruled)')
{
  // The REAL shared list (this proof's hermetic home elects no frontier
  // lane and holds no Anthropic credential): exactly one fable row — the
  // frontier ALIAS resolving to the real id, the marketing owner's name, in
  // the Anthropic (group-less) section, pushed by the tier builders like
  // opus/sonnet/haiku and gated by the family's credential like every
  // Anthropic row. No synthesized literal rides after the allowlist.
  const { getModelOptions, anthropicNotSignedInReason } = await import('../../src/utils/model/modelOptions.ts')
  const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
  const real = getModelOptions()
  const fables = real.filter(o => typeof o.value === 'string' && /fable/i.test(o.value))
  // Two rows since Claude Fable 5.1 joined: the frontier ALIAS row (the
  // family default, still exactly one) and the 5.1 LITERAL row — its own
  // model, the same neutral grammar (no description), the owner's name.
  const aliasRows = fables.filter(o => o.value === 'fable')
  const fable51Rows = fables.filter(o => o.value === 'claude-fable-5-1')
  check(
    'the shared catalog carries exactly ONE frontier alias row and ONE Fable 5.1 literal row',
    aliasRows.length === 1 &&
      fable51Rows.length === 1 &&
      fables.length === 2 &&
      fable51Rows[0]?.label === 'Fable 5.1' &&
      fable51Rows[0]?.description === '',
    fables.map(f => `${String(f.value)}·${f.label}·${f.description}`).join(','),
  )
  const fableRow = aliasRows[0]
  check(
    'the row is the frontier alias resolving to the real id, with the marketing name',
    typeof fableRow?.value === 'string' && parseUserSpecifiedModel(fableRow.value) === 'claude-fable-5' && fableRow?.label === 'Fable 5',
    `${String(fableRow?.value)} · ${String(fableRow?.label)}`,
  )
  check('the row sits in the Anthropic section (group-less rank)', fableRow?.group === undefined)
  check(
    "the row is gated by the family's credential like every Anthropic row (no credential on this home)",
    fableRow?.unavailable === anthropicNotSignedInReason(),
    String(fableRow?.unavailable),
  )
  const withCredential = getModelOptions({ anthropicCredentialed: () => true })
  const freeFable = withCredential.find(o => typeof o.value === 'string' && /fable/i.test(o.value))
  check('…and selectable once the family is credentialed', freeFable !== undefined && freeFable.unavailable === undefined)
  const optionsSrc = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'utils', 'model', 'modelOptions.ts'),
    'utf-8',
  )
  check(
    'no synthesized frontier literal rides after the allowlist (step 9b retired)',
    !optionsSrc.includes("value: 'claude-fable-5'") && !optionsSrc.includes('frontier literal row'),
  )
  check(
    'the tier builders push the row unconditionally (never behind the frontier decision)',
    (optionsSrc.match(/rows\.push\(getFableOption\(\)\)/g) ?? []).length === 2 &&
      !/if \(isFableAvailable\(\)\) \{\s*rows\.push\(getFableOption\(\)\)/.test(optionsSrc),
  )

  // The submodel registry composed over the REAL catalog lists the row in
  // the anthropic family — the picker's frontier line and its rows agree.
  const registry = composeSubModelRegistry({
    options: getModelOptions,
    presences,
    providers,
  } as never)
  const entry = registry.entries.find(e => e.modelId === 'claude-fable-5')
  check('the submodel registry lists Fable 5 under anthropic', entry !== undefined && entry.source === 'anthropic')

  // /model reads the shared row — the local synthesis is retired.
  const mercuryModel = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'commands', 'model', 'mercuryModel.tsx'),
    'utf-8',
  )
  check('the /model builder carries NO local fable synthesis', !mercuryModel.includes('fableRow'))
  check(
    '/model names the shared owner it reads (an ordinary tier row, never a 9b splice)',
    mercuryModel.includes('The Fable row is the SHARED catalog') && !mercuryModel.includes('9b'),
  )
}

section('7 · the ONE credential truth — the REAL owner chain across sign-in/out (no injection)')
{
  // The operator's live repro: an OpenAI account signed in
  // through /logins mid-session, and /submodels kept answering as if no GPT
  // credential existed — a discovery record primed at boot outlived the
  // sign-in. The law under proof: every surface's presence read follows the
  // OWNING account resolvers live; a cached record never decides a
  // credential gate. Hermetic: the mkdtemp scratch home above, the file
  // credential plane, every provider base a dead loopback, ambient
  // credentials cleared — nothing can reach a live host or the keychain.
  process.env.MERCURY_CREDENTIAL_STORE = 'file'
  process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'MERCURY_OAUTH_TOKEN',
    'ZAI_API_KEY',
    'OPENROUTER_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'MOONSHOT_API_KEY',
    'DEEPSEEK_API_KEY',
    'HF_TOKEN',
    'MERCURY_COMPAT_BASE_URL',
    'MERCURY_LOCAL_BASE_URL',
  ]) {
    delete process.env[key]
  }
  const dead = 'http://127.0.0.1:1'
  for (const base of [
    'ANTHROPIC_BASE_URL',
    'MERCURY_OPENAI_API_BASE',
    'MERCURY_OPENAI_CHATGPT_BASE',
    'MERCURY_OPENAI_AUTH_BASE',
    'MERCURY_OPENROUTER_API_BASE',
    'MERCURY_GEMINI_API_BASE',
    'MERCURY_MOONSHOT_API_BASE',
    'MERCURY_MOONSHOT_CODING_BASE',
    'MERCURY_DEEPSEEK_API_BASE',
    'MERCURY_HUGGINGFACE_HUB_BASE',
    'MERCURY_ZAI_API_BASE',
  ]) {
    process.env[base] = dead
  }

  const { writeFileSync, rmSync } = await import('node:fs')
  const home = process.env.MERCURY_CONFIG_DIR as string
  const authFile = join(home, '.openai-auth.json')
  const discovery = await import('../../src/utils/router/providerDiscovery.ts')
  const { providerFamilyPresences, anthropicCredentialPresence } = await import(
    '../../src/services/providers/providerUsage.ts'
  )
  const { buildRouterModelSnapshot } = await import('../../src/utils/router/modelRegistry.ts')
  const { resolveOpenaiAccount } = await import(
    '../../src/services/providers/openai/openaiAccounts.ts'
  )

  const presenceOf = (id: string) =>
    providerFamilyPresences().find(p => (p.id as string) === id)
  const openaiRows = () =>
    composeSubModelRegistry().entries.filter(e => e.source === 'openai')
  const ownerEquation = (step: string): void => {
    const presence = presenceOf('openai')
    check(
      `${step}: presence ≡ the owning resolver (one truth)`,
      presence?.credentialed === (resolveOpenaiAccount() !== undefined),
      `presence=${String(presence?.credentialed)} owner=${String(resolveOpenaiAccount() !== undefined)}`,
    )
  }

  // — the boot-time record on a signed-out home: the poison the repro rode —
  discovery.__resetProviderDiscoveryForTest()
  discovery.primeOpenaiDiscovery()
  check('signed out: the owner resolves no account', resolveOpenaiAccount() === undefined)
  check('signed out: the openai presence is uncredentialed', presenceOf('openai')?.credentialed === false)
  ownerEquation('signed out')
  {
    const rows = openaiRows()
    check('signed out: GPT rows exist (the family is never hidden)', rows.length > 0)
    check(
      'signed out: every GPT row is signed-out and ROUTES to /logins openai',
      rows.every(r => r.state === 'signed-out' && r.connect?.command === '/logins openai'),
      JSON.stringify(rows.map(r => ({ id: r.modelId, state: r.state, connect: r.connect?.command }))),
    )
    check(
      'signed out: the family row is uncredentialed',
      composeSubModelRegistry().families.find(f => f.source === 'openai')?.credentialed === false,
    )
    const provider = buildRouterModelSnapshot().providers.find(p => p.id === 'openai')
    check(
      'signed out: the dispatch gate reads the same truth (no-account:openai)',
      provider?.available === false && provider?.reason === 'no-account:openai',
      JSON.stringify(provider && { available: provider.available, reason: provider.reason }),
    )
  }

  // — the /logins journey, in-process: the login estate writes its file and
  //   NOTHING re-primes — the next read must see it anyway —
  writeFileSync(
    authFile,
    JSON.stringify({
      version: 1,
      tokens: {
        idToken: '',
        accessToken: 'fixture-access',
        refreshToken: 'fixture-refresh',
        accountId: 'acct_fixture',
        planType: 'plus',
      },
    }),
  )
  check('signed in: the owner resolves the subscription', resolveOpenaiAccount()?.kind === 'chatgpt-subscription')
  {
    const presence = presenceOf('openai')
    check(
      'signed in mid-session: the presence sees it WITHOUT any re-prime (the repro pin)',
      presence?.credentialed === true,
      JSON.stringify(presence),
    )
    check(
      'signed in: the presence wears the owning resolver’s label',
      presence?.credentialLabel === 'ChatGPT plus subscription',
      String(presence?.credentialLabel),
    )
  }
  ownerEquation('signed in')
  {
    const rows = openaiRows()
    check('signed in: GPT rows still listed', rows.length > 0)
    check(
      'signed in: NO GPT row claims signed-out (honest asymmetry: a dark catalogue says WHY, typed)',
      rows.every(
        r =>
          r.state !== 'signed-out' &&
          (r.state === 'selectable' || (typeof r.reason === 'string' && r.reason.length > 0)),
      ),
      JSON.stringify(rows.map(r => ({ id: r.modelId, state: r.state, reason: r.reason }))),
    )
    const family = composeSubModelRegistry().families.find(f => f.source === 'openai')
    check(
      'signed in: the family row is credentialed with the label',
      family?.credentialed === true && family?.credentialLabel === 'ChatGPT plus subscription',
      JSON.stringify(family),
    )
    const provider = buildRouterModelSnapshot().providers.find(p => p.id === 'openai')
    check('signed in: the dispatch gate opens on the same read', provider?.available === true)
  }

  // — sign-out mid-session: the reverse transition is seen the same way —
  rmSync(authFile)
  check('signed out again: the owner resolves no account', resolveOpenaiAccount() === undefined)
  check(
    'signed out again: the presence follows WITHOUT any re-prime',
    presenceOf('openai')?.credentialed === false,
  )
  ownerEquation('signed out again')
  check(
    'signed out again: the GPT rows route to the attach home once more',
    openaiRows().every(r => r.state === 'signed-out' && r.connect?.command === '/logins openai'),
  )

  // — the same law per env-seam family: a key set or removed AFTER a record
  //   is cached is seen by the very next presence read —
  const envFamilies: Array<{ id: string; env: string; value: string }> = [
    { id: 'zai', env: 'ZAI_API_KEY', value: 'zk-fixture' },
    { id: 'moonshot', env: 'MOONSHOT_API_KEY', value: 'mk-fixture' },
    { id: 'deepseek', env: 'DEEPSEEK_API_KEY', value: 'dk-fixture' },
    { id: 'openrouter', env: 'OPENROUTER_API_KEY', value: 'or-fixture' },
    { id: 'gemini', env: 'GEMINI_API_KEY', value: 'gk-fixture' },
    { id: 'huggingface', env: 'HF_TOKEN', value: 'hf-fixture' },
  ]
  for (const family of envFamilies) {
    providerFamilyPresences() // cache a record with the credential ABSENT
    process.env[family.env] = family.value
    check(
      `${family.id}: a credential set after the record is cached is SEEN`,
      presenceOf(family.id)?.credentialed === true,
      JSON.stringify(presenceOf(family.id)),
    )
    delete process.env[family.env]
    check(
      `${family.id}: removing it is seen by the very next read`,
      presenceOf(family.id)?.credentialed === false,
    )
  }

  // — anthropic: the row derives THROUGH the one owner function —
  check(
    'anthropic: the presence row equals anthropicCredentialPresence (one owner)',
    presenceOf('anthropic')?.credentialed === anthropicCredentialPresence().credentialed,
  )
  check(
    'anthropic: injected owner reads flow through to the row',
    providerFamilyPresences(undefined as never, { claudeSubscriber: () => true, subscriptionType: () => 'max' }).find(
      p => (p.id as string) === 'anthropic',
    )?.credentialed === true,
  )

  // — the regression shape, pinned structurally: the openai account read is
  //   self-primed per read; no cache-first account read survives in the
  //   adapter or the catalogue module —
  const adapterSrc = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'utils', 'router', 'providers', 'openai.ts'),
    'utf-8',
  )
  const catalogueSrc = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'services', 'providers', 'openai', 'openaiCatalogue.ts'),
    'utf-8',
  )
  check(
    'the openai adapter self-primes per read (no cache-first account read)',
    !adapterSrc.includes('getCachedProviderDiscovery') && adapterSrc.includes('primeOpenaiDiscovery()'),
  )
  check(
    'the openai catalogue module reads the same self-primed owner',
    !catalogueSrc.includes('getCachedProviderDiscovery') && catalogueSrc.includes('primeOpenaiDiscovery()'),
  )
}

section("8 · CATALOGUE EQUALITY — both containers list exactly the main picker's rows, carriers included")
{
  // The main /model picker's grammar (mercuryModel.tsx): a string-valued row
  // that is neither a mode sentinel nor an action row; selectable iff the
  // owning catalogue set no `unavailable`. The registry must list exactly
  // those ids — as ONE row set for both containers — and mark selectable
  // exactly the selectable ones. Proven over the REAL catalogue with a real
  // OpenRouter snapshot primed through the catalogue owner's own refresh
  // (fetchImpl injected — no network), the anthropic family credentialed
  // through the same presence read the picker threads into the catalogue.
  const { getModelOptions, isProviderActionRow } = await import(
    '../../src/utils/model/modelOptions.ts'
  )
  const {
    __resetOpenrouterCatalogueForTest,
    refreshOpenrouterCatalogue,
    getOpenrouterModelOptions,
  } = await import('../../src/services/providers/openrouter/openrouterCatalogue.ts')
  const { resolveOpenrouterRequestAuth } = await import(
    '../../src/services/providers/openrouter/openrouterAccounts.ts'
  )
  process.env.OPENROUTER_API_KEY = 'sk-or-fixture-equality'
  process.env.MERCURY_OPENROUTER_API_BASE = 'http://127.0.0.1:1/api/v1'
  __resetOpenrouterCatalogueForTest()
  const auth = resolveOpenrouterRequestAuth(process.env)
  check('the fixture OpenRouter key resolves an account', auth !== undefined)
  const catalogue = {
    data: [
      { id: 'fixture-vendor/ox-alpha', name: 'Ox Alpha (fixture)', context_length: 128_000 },
      { id: 'fixture-vendor/hummingbird:free', name: 'Hummingbird (free)', context_length: 32_000 },
    ],
  }
  const fetchImpl = (async () =>
    new Response(JSON.stringify(catalogue), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
  const snapshot = auth
    ? await refreshOpenrouterCatalogue(auth.account.keySource, { force: true, fetchImpl })
    : null
  check(
    'the OpenRouter snapshot primed through the owner (2 live rows, no error)',
    snapshot !== null && snapshot.models.length === 2 && snapshot.lastError === undefined,
    JSON.stringify(snapshot),
  )
  const openrouterRows = getOpenrouterModelOptions()
  check(
    'the main catalogue now carries the carrier rows as selectable model rows',
    openrouterRows.some(r => r.value === 'openrouter/fixture-vendor/ox-alpha' && r.unavailable === undefined),
    JSON.stringify(openrouterRows.map(r => [r.value, r.unavailable])),
  )

  const presencesWithCarrier = () => [
    { id: 'anthropic', available: true, credentialed: true, credentialLabel: 'Claude subscription (max)' },
    { id: 'openrouter', available: true, credentialed: true, credentialLabel: 'OpenRouter API key' },
    { id: 'openai', available: true, credentialed: false },
    { id: 'gemini', available: true, credentialed: false },
  ]
  const mainRows = getModelOptions(false, { anthropicCredentialed: () => true }).filter(
    (o): o is typeof o & { value: string } =>
      typeof o.value === 'string' && !o.value.startsWith('__') && !isProviderActionRow(o.value),
  )
  const mainIds = new Set(mainRows.map(o => canonicalSubModelId(o.value)))
  const mainSelectable = new Set(
    mainRows.filter(o => o.unavailable === undefined).map(o => canonicalSubModelId(o.value)),
  )
  check('the main picker offers carrier rows (the equality is not vacuous)', [...mainSelectable].some(id => id.startsWith('openrouter/')))
  const registry = composeSubModelRegistry({
    options: () => getModelOptions(false, { anthropicCredentialed: () => true }),
    presences: presencesWithCarrier,
    providers,
  } as never)
  const registryIds = new Set(registry.entries.filter(e => e.kind === 'model').map(e => e.modelId))
  const registrySelectable = new Set(
    registry.entries.filter(e => e.kind === 'model' && e.state === 'selectable').map(e => e.modelId),
  )
  const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(x => b.has(x))
  check(
    'the registry lists EXACTLY the main picker\'s model rows (ids, carriers included)',
    same(mainIds, registryIds),
    `main-only=${[...mainIds].filter(x => !registryIds.has(x)).join(',')} registry-only=${[...registryIds].filter(x => !mainIds.has(x)).join(',')}`,
  )
  check(
    'the registry marks selectable EXACTLY the main picker\'s selectable rows',
    same(mainSelectable, registrySelectable),
    `main-only=${[...mainSelectable].filter(x => !registrySelectable.has(x)).join(',')} registry-only=${[...registrySelectable].filter(x => !mainSelectable.has(x)).join(',')}`,
  )
  check(
    'the OpenRouter rows are selectable in the registry (the operator can pick a carrier)',
    registrySelectable.has('openrouter/fixture-vendor/ox-alpha') &&
      registrySelectable.has('openrouter/fixture-vendor/hummingbird:free'),
  )
  // ONE row set: the derivation has no container argument — the same call
  // serves /submodels' MINERVA and CONSOLE tabs, so the two cannot differ.
  const again = composeSubModelRegistry({
    options: () => getModelOptions(false, { anthropicCredentialed: () => true }),
    presences: presencesWithCarrier,
    providers,
  } as never)
  check(
    'a second derivation (the other tab) is identical row for row',
    JSON.stringify(again.entries) === JSON.stringify(registry.entries),
  )
  // …and the pick lands for BOTH containers through the validated writer.
  const carrierReads = {
    options: () => getModelOptions(false, { anthropicCredentialed: () => true }),
    presences: presencesWithCarrier,
    providers,
  } as never
  const minervaPick = setSubModel('minerva', 'openrouter/fixture-vendor/ox-alpha', carrierReads)
  const consolePick = setSubModel('console', 'openrouter/fixture-vendor/hummingbird:free', carrierReads)
  check(
    'an OpenRouter row persists for Minerva AND for the Console',
    minervaPick.ok &&
      consolePick.ok &&
      getGlobalConfig().subModels?.minerva === 'openrouter/fixture-vendor/ox-alpha' &&
      getGlobalConfig().subModels?.console === 'openrouter/fixture-vendor/hummingbird:free',
    JSON.stringify([minervaPick, consolePick, getGlobalConfig().subModels]),
  )
  const minervaResolved = resolveSubModel('minerva')
  check(
    'the Minerva carrier pick resolves on the openrouter route',
    minervaResolved.origin === 'saved' && minervaResolved.route === 'openrouter',
    JSON.stringify(minervaResolved),
  )
  setSubModel('minerva', null, carrierReads)
  setSubModel('console', null, carrierReads)
  delete process.env.OPENROUTER_API_KEY
  __resetOpenrouterCatalogueForTest()
}

section('9 · THE IDENTITY STAMP — the fact line names the resolved slot, one writer for both prompts')
{
  const wrote = setSubModel('console', 'opus', reads)
  const pin = resolveSubModel('console')
  check('a pick resolves as a pin', wrote.ok && pin.origin === 'saved', JSON.stringify(pin))
  if (pin.origin !== 'unset') {
    const line = subModelIdentityLine('console', pin)
    check('the line carries the resolved model id verbatim, quoted', line.includes(`model id "${pin.model}"`), line)
    check('…and the wire by the routing law\'s display name', line.includes(`via the ${providerDisplayName(pin.route)} wire`), line)
    check(
      '…as a harness-stamped fact the model answers with',
      line.includes('stamped by the Mercury harness') && line.includes('answer with exactly that id and wire'),
    )
    const minervaLine = subModelIdentityLine('minerva', pin)
    check(
      'the Minerva line names Minerva; the console line names the Console',
      minervaLine.includes('you are Minerva, the notepad curator') && line.includes('you are the Console'),
    )
    process.env.MERCURY_CONSOLE_MODEL = 'kimi-k3'
    const envPin = resolveSubModel('console')
    check(
      'an env pin stamps ITS id (the line follows the resolver, never the saved pick)',
      envPin.origin === 'env' && subModelIdentityLine('console', envPin).includes('model id "kimi-k3"'),
    )
    delete process.env.MERCURY_CONSOLE_MODEL
  }
  setSubModel('console', null, reads)
}

console.log('')
if (failures > 0) {
  console.error(`prove-submodels: ${failures} failure(s)`)
  process.exit(1)
}
console.log('prove-submodels: all green')
