#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const name of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'OPENAI_API_KEY']) delete process.env[name]
const HOME = mkdtempSync(join(tmpdir(), 'prove-sign-in-choice-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n── ${title}`)
}
const REPO = join(import.meta.dir, '..', '..')

console.log('============================================================')
console.log(' SETTINGS — which sign-in a project or a session spends')
console.log('============================================================')

const pockets = await import('../../src/utils/accounts/signInPockets.ts')
const secrets = await import('../../src/utils/router/providerSecrets.ts')
const roster = await import('../../src/services/providers/signInRoster.ts')
const env = await import('../../src/utils/envUtils.ts')
const { SettingsSchema } = await import('../../src/utils/settings/types.ts')
const { signInChoiceVerb } = await import('../../src/commands/login/login.tsx')

const k1 = 'sk-deepseek-first-00000000aaaa'
const k2 = 'sk-deepseek-second-0000000bbbb'
const z1 = 'zai-key-one-0000000000000zzzz'
const pocketB = join(HOME, 'sign-ins', 'deepseek', 'key-bbbb')

section('§1 the settings key: credentials.signIns is a family → identity map, described, in the generated schema')
{
  const ok = SettingsSchema().safeParse({ credentials: { signIns: { deepseek: '…bbbb', openai: 'bob@work.example' } } })
  check('a family → identity map parses', ok.success, JSON.stringify(ok.success ? {} : ok.error.issues))
  const bad = SettingsSchema().safeParse({ credentials: { signIns: { deepseek: 7 } } })
  check('a non-string identity is refused by the schema', !bad.success)
  const schema = JSON.parse(readFileSync(join(REPO, 'scripts', 'settings', 'settings-schema.json'), 'utf8')) as { properties: { credentials: { properties: { signIns?: { description?: string; additionalProperties?: { type?: string } } } } } }
  const node = schema.properties.credentials.properties.signIns
  check('the generated schema carries the key with its description and string values', node !== undefined && /logins use/.test(node.description ?? '') && node.additionalProperties?.type === 'string', JSON.stringify(node))
}

section('§2 two sign-ins of one family: the roster lists both, the default first, the one in use marked')
{
  secrets.writeStoredDeepseekApiKey(k1)
  secrets.writeStoredDeepseekApiKey(k2)
  secrets.writeStoredZaiApiKey(z1)
  pockets.takeLastLanding()
  pockets.clearSignInChoices()
  const rows = roster.familySignInRoster('deepseek', HOME)
  check('the roster lists the home key and the pocket key', rows.map(row => `${row.identity}${row.isDefault ? '*' : ''}`).join(',') === '…aaaa*,…bbbb', JSON.stringify(rows))
  check('with no choice the default is in use', rows.find(row => row.inUse)?.identity === '…aaaa')
  check('the whole-estate roster carries both families', roster.everySignInRoster(HOME).map(row => row.family).sort().join(',') === 'deepseek,deepseek,zai')
}

section('§3 the project choice: the settings map picks the pocket; a missing identity is refused with the names that exist')
{
  const refused = roster.applyProjectSignInChoices({ deepseek: '…bbbb', zai: '…nope', openai: 'nobody@example' }, HOME)
  check('the pocket named by the project is chosen', pockets.signInHome('deepseek') === pocketB && secrets.readStoredDeepseekApiKey() === k2)
  check('the roster marks the project choice in use', roster.familySignInRoster('deepseek', HOME).find(row => row.inUse)?.identity === '…bbbb')
  check('the two unknown identities are refused with the known names', refused.length === 2 && refused[0]?.family === 'zai' && refused[0]?.known.join(',') === '…zzzz' && refused[1]?.family === 'openai' && refused[1]?.known.length === 0, JSON.stringify(refused))
  const words = refused.map(roster.projectSignInRefusalWords)
  check('the refusal words name the file, the identity and the sign-ins that exist', /settings\.local\.json names …nope for Z\.AI/.test(words[0] ?? '') && /the sign-ins are …zzzz/.test(words[0] ?? '') && /nothing is signed in for it/.test(words[1] ?? ''), words.join(' | '))
  check('a refused family keeps spending its default', pockets.signInHome('zai') === env.getAuthConfigHomeDir() && secrets.readStoredZaiApiKey() === z1)
  check('the refusals are kept for the screens', roster.projectSignInRefusals().length === 2)
}

section('§4 the session choice outranks the project; the default word returns to the project; identities resolve across families')
{
  const use = roster.useSignIn('…aaaa', undefined, 'session', HOME)
  check('/logins use <identity> picks the home key for this session', use.ok && pockets.signInHome('deepseek') === env.getAuthConfigHomeDir() && secrets.readStoredDeepseekApiKey() === k1, use.words)
  check('the words say what this session spends', /DeepSeek: this session now spends …aaaa \(the default\)/.test(use.words), use.words)
  check('the project choice still stands underneath', pockets.chosenSignIn('deepseek')?.identity === '…aaaa' && roster.familySignInRoster('deepseek', HOME).find(row => row.inUse)?.identity === '…aaaa')
  const back = roster.useDefaultSignIn('deepseek')
  check('/logins use default <family> drops the session choice and the project pocket spends again', /spends the project's choice or the default again/.test(back) && pockets.signInHome('deepseek') === pocketB)
  const unknown = roster.useSignIn('…zzzz', 'deepseek', 'session', HOME)
  check('an identity of another family is refused for the named family, naming its sign-ins', !unknown.ok && /no sign-in named …zzzz for DeepSeek/.test(unknown.words) && /…aaaa, …bbbb/.test(unknown.words), unknown.words)
  const whole = roster.useSignIn('…zzzz', undefined, 'session', HOME)
  check('the same identity resolves without a family when it is unique', whole.ok && whole.row.family === 'zai')
  pockets.setSessionSignIn('zai', null)
}

section('§5 the /logins verbs: list · use · forget (the default refused, a pocket forgotten with the fallback said)')
{
  const listed = signInChoiceVerb('list', [])
  check('/logins list names every sign-in with the default and the one in use', /DeepSeek: …aaaa · default/.test(listed.words) && /DeepSeek: …bbbb · in use/.test(listed.words) && /Z\.AI: …zzzz · default · in use/.test(listed.words), listed.words)
  check('the list carries the project refusals', /settings\.local\.json names …nope/.test(listed.words))
  const used = signInChoiceVerb('use', ['deepseek', '…aaaa'])
  check('/logins use <family> <identity> moves the session', used.changed && pockets.signInHome('deepseek') === env.getAuthConfigHomeDir(), used.words)
  const refusedDefault = signInChoiceVerb('forget', ['…aaaa'])
  check('forgetting the default is refused and points at /accounts', !refusedDefault.changed && /default sign-in/.test(refusedDefault.words) && /\/accounts/.test(refusedDefault.words), refusedDefault.words)
  signInChoiceVerb('use', ['…bbbb'])
  const forgotten = signInChoiceVerb('forget', ['…bbbb'])
  check('forgetting the pocket in use removes it and says what spends now', forgotten.changed && !existsSync(pocketB) && /…bbbb forgotten — this session now spends …aaaa/.test(forgotten.words), forgotten.words)
  check('the home key is untouched and spends', secrets.readStoredDeepseekApiKey() === k1 && roster.familySignInRoster('deepseek', HOME).map(row => row.identity).join(',') === '…aaaa')
  const gone = signInChoiceVerb('use', ['…bbbb'])
  check('a forgotten identity is unknown afterwards', !gone.changed && /no sign-in named …bbbb/.test(gone.words), gone.words)
}

section('§6 the boot binding: the project choices load lazily from the settings on the first credential read, once')
{
  secrets.writeStoredDeepseekApiKey(k2)
  pockets.takeLastLanding()
  pockets.clearSignInChoices()
  let reads = 0
  roster.bindProjectSignInChoicesToSettings(() => {
    reads++
    return { credentials: { signIns: { deepseek: '…bbbb' } } }
  })
  check('nothing is read before a credential is resolved', reads === 0)
  check('the first credential read applies the project choice', secrets.readStoredDeepseekApiKey() === k2 && pockets.signInHome('deepseek') === pocketB)
  secrets.readStoredDeepseekApiKey()
  pockets.signInHome('zai')
  check('the settings were read once', reads === 1, String(reads))
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ SIGN-IN CHOICE GREEN' : `\n❌ SIGN-IN CHOICE RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
