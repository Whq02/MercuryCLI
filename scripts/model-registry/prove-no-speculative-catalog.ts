#!/usr/bin/env bun
let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('§1 the model rows live in the ratified owners')
{
  const { ALL_MODEL_CONFIGS } = await import('../../src/utils/model/configs.js')
  check(
    "configs carries sonnet5/opus5 hand rows ('claude-sonnet-5' / 'claude-opus-5')",
    ALL_MODEL_CONFIGS.sonnet5?.firstParty === 'claude-sonnet-5' &&
      ALL_MODEL_CONFIGS.opus5?.firstParty === 'claude-opus-5',
  )
  const { getDefaultOpusModel, getDefaultSonnetModel, getCanonicalName, getMarketingNameForModel } =
    await import('../../src/utils/model/model.js')
  for (const k of ['MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL']) delete process.env[k]
  check("getDefaultOpusModel() = 'claude-opus-5'", getDefaultOpusModel() === 'claude-opus-5', getDefaultOpusModel())
  check("getDefaultSonnetModel() = 'claude-sonnet-5'", getDefaultSonnetModel() === 'claude-sonnet-5', getDefaultSonnetModel())
  check(
    'the promoted ids are their own canonicals with owner display names',
    getCanonicalName('claude-sonnet-5') === 'claude-sonnet-5' &&
      getCanonicalName('claude-opus-5') === 'claude-opus-5' &&
      getMarketingNameForModel('claude-sonnet-5') === 'Sonnet 5' &&
      getMarketingNameForModel('claude-opus-5') === 'Opus 5',
  )
}

console.log('')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ no-speculative-catalog: all checks pass')
