#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const name of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY']) delete process.env[name]
const HOME = mkdtempSync(join(tmpdir(), 'prove-identity-hidden-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const REPO = join(import.meta.dir, '..', '..')

console.log('============================================================')
console.log(' ACCOUNTS — identity hidden hides every sign-in the same way; no identity reaches a crewmate prompt')
console.log('============================================================')

const pockets = await import('../../src/utils/accounts/signInPockets.ts')
const secrets = await import('../../src/utils/router/providerSecrets.ts')
const { setSessionSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { getInitialSettings } = await import('../../src/utils/settings/settings.ts')
const { signInChoiceVerb, withLandingWords } = await import('../../src/commands/login/login.tsx')
const { otherSignInsLine } = await import('../../src/services/providers/providerIdentityLine.ts')
const { familySignInRoster } = await import('../../src/services/providers/signInRoster.ts')

secrets.writeStoredDeepseekApiKey('sk-deepseek-first-00000000aaaa')
secrets.writeStoredDeepseekApiKey('sk-deepseek-second-0000000bbbb')
const landing = pockets.takeLastLanding()

console.log('§1 — shown: the list, the landing receipt and the usage line name the tails')
{
  const listed = signInChoiceVerb('list', []).words
  check('the list names both tails with the one in use', /…aaaa · default/.test(listed) && /…bbbb · in use/.test(listed), listed)
  const receipt = landing === undefined ? '' : pockets.landingWords(landing, 'DeepSeek', true)
  check('the landing words name the added tail and the default', /…bbbb added beside …aaaa/.test(receipt), receipt)
}

console.log('§2 — hidden: the same surfaces carry no tail and no address, and still say what happened')
{
  setSessionSettingsCache({ settings: { ...getInitialSettings(), view: { ...(getInitialSettings().view ?? {}), accountIdentity: false } }, errors: [] })
  const listed = signInChoiceVerb('list', []).words
  check('the list hides every tail and keeps the default and in-use marks', !listed.includes('…aaaa') && !listed.includes('…bbbb') && /default/.test(listed) && /in use/.test(listed), listed)
  check('hidden list rows carry an ordinal where the identity was, never a blank', /DeepSeek: sign-in 1 · default/.test(listed) && /DeepSeek: sign-in 2 · in use/.test(listed) && !/DeepSeek:  ·/.test(listed), listed)
  const leak = (text: string): boolean => /…aaaa|…bbbb|…zzzz|…nope|aaaa|bbbb|zzzz/.test(text)
  const used = signInChoiceVerb('use', ['…aaaa'])
  check('use under hidden says which sign-in spends by its ordinal, not by the typed tail', used.changed && /DeepSeek: this session now spends sign-in 1 \(the default\)/.test(used.words) && !leak(used.words), used.words)
  const refusedUnknown = signInChoiceVerb('use', ['…nope'])
  check('the unknown-identity refusal lists ordinals, never the tails', !refusedUnknown.changed && /no sign-in named that/.test(refusedUnknown.words) && /the sign-ins are DeepSeek sign-in 1, DeepSeek sign-in 2/.test(refusedUnknown.words) && !leak(refusedUnknown.words), refusedUnknown.words)
  const refusedFamily = signInChoiceVerb('use', ['deepseek', '…zzzz'])
  check('the wrong-family refusal lists ordinals, never the tails', !refusedFamily.changed && /for DeepSeek/.test(refusedFamily.words) && /the sign-ins are sign-in 1, sign-in 2/.test(refusedFamily.words) && !leak(refusedFamily.words), refusedFamily.words)
  const { applyProjectSignInChoices } = await import('../../src/services/providers/signInRoster.ts')
  applyProjectSignInChoices({ deepseek: '…gone' }, HOME)
  const listedRefusal = signInChoiceVerb('list', []).words
  check('the project-refusal line on the list names no identity under hidden', /settings\.local\.json names a sign-in for DeepSeek that does not exist/.test(listedRefusal) && /the sign-ins are sign-in 1, sign-in 2/.test(listedRefusal) && !leak(listedRefusal), listedRefusal)
  signInChoiceVerb('use', ['…bbbb'])
  const forgotten = signInChoiceVerb('forget', ['…bbbb'])
  check('the forget words name ordinals: the forgotten one and the one that spends now', forgotten.changed && /DeepSeek: sign-in 2 forgotten — this session now spends sign-in 1/.test(forgotten.words) && !leak(forgotten.words), forgotten.words)
  secrets.writeStoredDeepseekApiKey('sk-deepseek-second-0000000bbbb')
  pockets.takeLastLanding()
  pockets.clearSignInChoices()
  const words = landing === undefined ? '' : pockets.landingWords(landing, 'DeepSeek', false)
  check('the landing words hide the tails and say a second sign-in was added', !words.includes('…') && /added beside the first/.test(words), words)
  const usage = otherSignInsLine('deepseek', false)
  check('the usage line hides the tail', usage !== undefined && !usage.includes('…') && /another sign-in of this family is stored/.test(usage), usage)
  secrets.writeStoredDeepseekApiKey('sk-deepseek-second-0000000bbbb')
  const hiddenReceipt = withLandingWords('DeepSeek API key stored')
  check('the transcript receipt after a landing hides the tails', !hiddenReceipt.includes('…aaaa') && !hiddenReceipt.includes('…bbbb'), hiddenReceipt)
  check('the roster itself still knows the identities (the Logins screen and /accounts name them)', familySignInRoster('deepseek', HOME).map(row => row.identity).join(',') === '…aaaa,…bbbb')
}

console.log('§3 — no identity reaches a crewmate prompt or a prompt contract: the prompt modules read no sign-in identity')
{
  const dirs = ['src/prompt', 'src/tools/AgentTool', 'src/constants', 'src/utils/forkedAgent.ts', 'src/services/concourse/coordinatorCall.ts']
  let hits = ''
  try {
    hits = execFileSync('grep', ['-rln', '-E', 'signInRoster|signInPockets|getOauthAccountInfo|anthropicSignInEmail|presenceIdentityWords|providerIdentityLine', ...dirs], { cwd: REPO, encoding: 'utf8' }).trim()
  } catch (error) {
    hits = (error as { status?: number }).status === 1 ? '' : String(error)
  }
  check('no prompt or crewmate module reads a sign-in identity', hits === '', hits)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ IDENTITY HIDDEN GREEN' : `\n❌ IDENTITY HIDDEN RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
