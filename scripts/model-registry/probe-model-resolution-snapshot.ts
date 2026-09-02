// Model-resolution snapshot: every default/alias/canonical/display/cost/
// window/effort/frontier fact as one stable JSON document. Run under a scrubbed
// env with a scratch config home; diff before/after.
for (const k of [
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'MERCURY_DISABLE_1M_CONTEXT',
]) delete process.env[k]

const out: Record<string, unknown> = {}
const cfg = await import('../../src/utils/config/globalConfig.js')
cfg.enableConfigs()
const model = await import('../../src/utils/model/model.js')
const caps = await import('../../src/utils/model/capabilities.js')
const cost = await import('../../src/utils/modelCost.js')
const effort = await import('../../src/utils/effort.js')
const opts = await import('../../src/utils/model/modelOptions.js')
const policy = await import('../../src/utils/model/frontierPolicy.js')
const daedalus = await import('../../src/tools/WorkflowTool/bundled/daedalus.js')

out.defaults = {
  opus: model.getDefaultOpusModel(),
  sonnet: model.getDefaultSonnetModel(),
  haiku: model.getDefaultHaikuModel(),
  fable: model.getDefaultFableModel(),
  mainLoopSetting: model.getDefaultMainLoopModelSetting(),
  opusNatively1M: model.isDefaultOpusNatively1M(),
}
out.parse = Object.fromEntries(
  ['opus', 'sonnet', 'haiku', 'fable', 'mythos', 'opusplan', 'best', 'sonnet5', 'opus5', 'fable6',
   'claude-opus-4-1', 'sonnet5[1m]', 'claude-sonnet-5', 'claude-opus-5'].map(s => [s, model.parseUserSpecifiedModel(s)]),
)
out.canonical = Object.fromEntries(
  ['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-5[1m]', 'claude-opus-4-8', 'anthropic/claude-opus-5'].map(s => [s, model.getCanonicalName(s)]),
)
out.display = Object.fromEntries(
  ['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-5[1m]', 'claude-opus-5[1m]'].map(s => [s, [model.getPublicModelDisplayName(s), model.getMarketingNameForModel(s)]]),
)
const ids = ['claude-sonnet-5', 'claude-opus-5']
out.facts = Object.fromEntries(ids.map(id => [id, {
  costs: cost.getModelCosts(id),
  pricing: cost.getModelPricingString(id),
  window: caps.getContextWindowForModel(id),
  output: caps.getModelMaxOutputTokens(id),
  supports1M: caps.modelSupports1M(id),
  effort: [effort.modelSupportsEffort(id), effort.modelSupportsXHighEffort(id), effort.modelSupportsMaxEffort(id)],
  launchPinned: effort.isLaunchEffortPinned(id),
  launchDefault: effort.getLaunchDefaultEffort(id),
  adaptive: caps.modelSupportsAdaptiveThinking(id),
  structured: caps.modelSupportsStructuredOutputs(id),
  cutoff: caps.getModelKnowledgeCutoff(id),
  toggle1m: opts.focusedOptionSupports1m(id),
}]))
out.cutoffFable = caps.getModelKnowledgeCutoff('claude-fable-5')

const operatorFacts = {
  fableEnvPin: false,
  fableId: model.getDefaultFableModel(),
  allowlistPresent: false,
  allowlistNamesFable: false,
  allowlistPermits: () => true,
  claudeAiSubscriber: true,
  maxSubscriber: true,
  rateLimitTier: 'default_claude_max_20x',
  oneMDisabled: false,
  catalog: [] as never[],
  opusFallbackSetting: model.getDefaultOpusModel(),
}
out.frontier = {
  operatorShape: policy.evaluateFrontierDecision(operatorFacts as never).setting,
  operatorCode: policy.evaluateFrontierDecision(operatorFacts as never).code,
  noSubscriber: policy.evaluateFrontierDecision({ ...operatorFacts, claudeAiSubscriber: false, maxSubscriber: false, rateLimitTier: null } as never).setting,
  liveGather: policy.frontierOperatorDecision().setting,
  liveCode: policy.frontierOperatorDecision().code,
}
out.daedalus = {
  sonnet5: daedalus.daedalusResolveModels({ model: 'claude-sonnet-5' }),
  junk: daedalus.daedalusResolveModels({ model: 'no-such-model' }),
}
console.log(JSON.stringify(out, null, 1))
