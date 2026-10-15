#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const name of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'ZAI_API_KEY']) delete process.env[name]
const HOME = mkdtempSync(join(tmpdir(), 'prove-sign-in-pockets-'))
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
const bytes = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '<absent>')
const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

const REPO = join(import.meta.dir, '..', '..')
const BASE = '260725425c862d82f25da217e7e66f39fbb4be05'

console.log('============================================================')
console.log(' ACCOUNTS — sign-in pockets: a second sign-in per family')
console.log('============================================================')

const pockets = await import('../../src/utils/accounts/signInPockets.ts')
const ledger = await import('../../src/utils/accounts/signInLedger.ts')
const secrets = await import('../../src/utils/router/providerSecrets.ts')
const env = await import('../../src/utils/envUtils.ts')

section('§1 the seam at rest: every family reads the home; the pocket path shape; the slug rules')
{
  for (const family of ['anthropic', 'openai', 'gemini', 'deepseek', 'huggingface', 'nous']) {
    check(`${family}: signInHome === the auth home with no choice`, pockets.signInHome(family) === env.getAuthConfigHomeDir())
  }
  check('a pocket lives under <home>/sign-ins/<family>/<slug>', pockets.pocketDir('openai', 'bob@work.example', HOME) === join(HOME, 'sign-ins', 'openai', 'bob@work.example'))
  check('an address slugs to itself, lowercased', pockets.pocketSlug('Bob@Work.Example') === 'bob@work.example')
  check('a key tail slugs to key-<tail>', pockets.pocketSlug('…k3f9') === 'key-k3f9')
  check('a key identity is told by its mark', pockets.isKeyIdentity('…k3f9') && !pockets.isKeyIdentity('bob@work.example'))
  check('a path-shaped identity cannot climb out of the pockets root', !pockets.pocketSlug('../../etc').includes('/') && !pockets.pocketSlug('..').startsWith('..'))
  check('a nonsense family word is no pocket', pockets.listPocketSlugs('Not A Family').length === 0 && pockets.signInHome('Not A Family') === env.getAuthConfigHomeDir())
}

const k1 = 'sk-deepseek-first-00000000aaaa'
const k2 = 'sk-deepseek-second-0000000bbbb'
const k2b = 'sk-deepseek-second-again-0bbbb'
const homeSecrets = join(HOME, '.provider-secrets.json')
const pocketB = join(HOME, 'sign-ins', 'deepseek', 'key-bbbb')

section('§2 the landing rule on the key road: first → the home · a new tail → a pocket · the same tail → replaced')
{
  secrets.writeStoredDeepseekApiKey(k1)
  const first = pockets.takeLastLanding()
  check('the first key lands in the home (today\'s file, today\'s field)', json(homeSecrets).deepseekApiKey === k1)
  check('the receipt says first', first?.landed === 'first' && first.identity === '…aaaa' && first.dir === null, JSON.stringify(first))
  check('no pocket exists after the first sign-in', !existsSync(join(HOME, 'sign-ins')))
  const entries1 = ledger.readSignInEntries('deepseek', { home: HOME })
  check('the ledger carries the home row under entries, with no pocket', entries1['…aaaa']?.kind === 'api-key' && entries1['…aaaa']?.pocket === undefined, JSON.stringify(entries1))
  const homeBefore = bytes(homeSecrets)

  secrets.writeStoredDeepseekApiKey(k2)
  const second = pockets.takeLastLanding()
  check('the second key (another tail) is ADDED as a pocket', second?.landed === 'added' && second.identity === '…bbbb' && second.dir === pocketB, JSON.stringify(second))
  check('the pocket holds its own .provider-secrets.json with the new key', existsSync(join(pocketB, '.provider-secrets.json')) && json(join(pocketB, '.provider-secrets.json')).deepseekApiKey === k2)
  check('the pocket file holds only that family\'s key', Object.keys(json(join(pocketB, '.provider-secrets.json'))).sort().join(',') === 'deepseekApiKey,version')
  check('the home\'s file is unchanged byte for byte', bytes(homeSecrets) === homeBefore)
  check('the session now spends the new sign-in', pockets.chosenSignIn('deepseek')?.identity === '…bbbb' && pockets.signInHome('deepseek') === pocketB)
  check('the family reader answers through the seam: the pocket\'s key', secrets.readStoredDeepseekApiKey() === k2)
  check('under the home bracket the reader answers the home\'s key', pockets.withSignInHome('deepseek', null, () => secrets.readStoredDeepseekApiKey()) === k1)
  const entries2 = ledger.readSignInEntries('deepseek', { home: HOME })
  check('the ledger holds two entries, the pocket row naming its slug', Object.keys(entries2).sort().join(',') === '…aaaa,…bbbb' && entries2['…bbbb']?.pocket === 'key-bbbb', JSON.stringify(entries2))
  check('pocketEntries lists the one pocket', pockets.pocketEntries('deepseek', HOME).map(e => `${e.identity}:${e.slug}`).join(',') === '…bbbb:key-bbbb')

  secrets.writeStoredDeepseekApiKey(k2b)
  const third = pockets.takeLastLanding()
  check('a key with the same tail REPLACES inside its pocket (no new pocket)', third?.landed === 'replaced' && third.dir === pocketB && readdirSync(join(HOME, 'sign-ins', 'deepseek')).length === 1, JSON.stringify(third))
  check('the pocket now holds the re-pasted key', json(join(pocketB, '.provider-secrets.json')).deepseekApiKey === k2b)
  check('the home still holds the first key', json(homeSecrets).deepseekApiKey === k1)

  secrets.writeStoredDeepseekApiKey(k1)
  const fourth = pockets.takeLastLanding()
  check('re-pasting the home\'s own key REPLACES in the home and the session spends the home again', fourth?.landed === 'replaced' && fourth.dir === null && pockets.signInHome('deepseek') === env.getAuthConfigHomeDir(), JSON.stringify(fourth))
  check('the landing words name both identities on an add', /added beside …aaaa/.test(pockets.landingWords(second!, 'DeepSeek')) && /\/logins use …aaaa/.test(pockets.landingWords(second!, 'DeepSeek')))
}

section('§3 families never cross: another family\'s first key lands in the home while deepseek spends a pocket')
{
  pockets.setSessionSignIn('deepseek', { identity: '…bbbb', dir: pocketB, kind: 'api-key' })
  const pocketBefore = bytes(join(pocketB, '.provider-secrets.json'))
  secrets.writeStoredOpenrouterApiKey('sk-or-first-000000000000cccc')
  check('the openrouter key lands in the home\'s file', json(homeSecrets).openrouterApiKey === 'sk-or-first-000000000000cccc')
  check('the deepseek pocket is untouched', bytes(join(pocketB, '.provider-secrets.json')) === pocketBefore)
  check('the home keeps deepseek\'s first key beside it', json(homeSecrets).deepseekApiKey === k1)
  pockets.takeLastLanding()
}

section('§4 the choice resolves session → project → default, and a vanished pocket falls back to the home')
{
  pockets.clearSignInChoices()
  pockets.setProjectSignIn('deepseek', { identity: '…bbbb', dir: pocketB, kind: 'api-key' })
  check('a project choice alone picks the pocket', pockets.signInHome('deepseek') === pocketB && pockets.chosenSignIn('deepseek')?.identity === '…bbbb')
  pockets.setSessionSignIn('deepseek', { identity: '…aaaa', dir: null, kind: 'api-key' })
  check('a session choice of the default outranks the project\'s pocket', pockets.signInHome('deepseek') === env.getAuthConfigHomeDir())
  pockets.setSessionSignIn('deepseek', null)
  check('clearing the session choice returns to the project\'s pocket', pockets.signInHome('deepseek') === pocketB)
  const ghost = join(HOME, 'sign-ins', 'deepseek', 'key-gone')
  pockets.setProjectSignIn('deepseek', { identity: '…gone', dir: ghost, kind: 'api-key' })
  check('a choice naming a pocket that does not exist reads the home, and says the choice does not stand', pockets.signInHome('deepseek') === env.getAuthConfigHomeDir() && !pockets.chosenSignInStands('deepseek'))
  pockets.clearSignInChoices()
  let heard = 0
  const off = pockets.subscribeSignInChoice(() => {
    heard++
  })
  pockets.setSessionSignIn('deepseek', { identity: '…bbbb', dir: pocketB, kind: 'api-key' })
  off()
  pockets.setSessionSignIn('deepseek', null)
  check('a subscriber hears a choice move once and not after unsubscribing', heard === 1, String(heard))
}

section('§5 forget: the pocket\'s credential is cleared through its own road, the pocket and its row go, the home and the other family stay, the choice falls back')
{
  pockets.setSessionSignIn('deepseek', { identity: '…bbbb', dir: pocketB, kind: 'api-key' })
  const entry = pockets.pocketEntries('deepseek', HOME)[0]!
  const homeBefore = bytes(homeSecrets)
  const outcome = pockets.forgetPocket('deepseek', entry, () => secrets.writeStoredDeepseekApiKey(null), HOME)
  check('forget answers removed + the choice fell', outcome.removed && outcome.choiceFell, JSON.stringify(outcome))
  check('the pocket directory is gone', !existsSync(pocketB))
  check('the ledger row is gone, the home row stays', Object.keys(ledger.readSignInEntries('deepseek', { home: HOME })).join(',') === '…aaaa')
  check('the home\'s file is unchanged', bytes(homeSecrets) === homeBefore && json(homeSecrets).deepseekApiKey === k1 && json(homeSecrets).openrouterApiKey === 'sk-or-first-000000000000cccc')
  check('the family spends the home again', pockets.signInHome('deepseek') === env.getAuthConfigHomeDir() && secrets.readStoredDeepseekApiKey() === k1)
  check('the ledger\'s latest-sign-in row for the family still stands (a forget is not a sign-in)', ledger.readSignInRecord('deepseek', { home: HOME })?.kind === 'api-key')
}

section('§6 the anthropic token pocket: the home\'s blob (MCP, device token) is never touched by a pocket write; the auth scope is restored')
{
  const homeCreds = join(HOME, '.credentials.json')
  const anthropicPocket = join(HOME, 'sign-ins', 'anthropic', 'bob@work.example')
  mkdirSync(anthropicPocket, { recursive: true })
  writeFileSync(homeCreds, JSON.stringify({ claudeAiOauth: { accessToken: 'home-access', refreshToken: 'home-refresh', expiresAt: 1, scopes: ['user:inference'], subscriptionType: 'max', rateLimitTier: null }, mcpOAuth: { srv: { accessToken: 'mcp-token' } }, trustedDeviceToken: 'device-1' }, null, 2))
  const homeBefore = bytes(homeCreds)
  const storage = await import('../../src/utils/secureStorage/index.ts')
  pockets.setSessionSignIn('anthropic', { identity: 'bob@work.example', dir: anthropicPocket, kind: 'subscription' })
  check('with a pocket chosen, the family storage is pocket-bound', storage.getSecureStorage('anthropic').name.includes('sign-in pocket'))
  check('the family-less storage stays the home\'s', !storage.getSecureStorage().name.includes('sign-in pocket'))
  const wrote = storage.getSecureStorage('anthropic').update({ claudeAiOauth: { accessToken: 'pocket-access', refreshToken: 'pocket-refresh', expiresAt: 2, scopes: ['user:inference'], subscriptionType: null, rateLimitTier: null } })
  check('the pocket write succeeds', wrote.success)
  check('the pocket holds its own .credentials.json', existsSync(join(anthropicPocket, '.credentials.json')) && (json(join(anthropicPocket, '.credentials.json')).claudeAiOauth as { accessToken: string }).accessToken === 'pocket-access')
  check('the home\'s blob is byte-identical: MCP tokens and the device token untouched', bytes(homeCreds) === homeBefore)
  check('the family read answers the pocket\'s tokens', storage.getSecureStorage('anthropic').read()?.claudeAiOauth?.accessToken === 'pocket-access')
  check('the home read still answers the home\'s tokens and MCP state', storage.getSecureStorage().read()?.claudeAiOauth?.accessToken === 'home-access' && (storage.getSecureStorage().read()?.mcpOAuth as Record<string, { accessToken: string }>).srv.accessToken === 'mcp-token')
  check('the process auth scope is clear after every bracket', env.getAuthScope() === undefined && env.getAuthConfigHomeDir() === HOME)
  pockets.setSessionSignIn('anthropic', null)
  check('with the choice cleared the family storage is the home\'s again', storage.getSecureStorage('anthropic').read()?.claudeAiOauth?.accessToken === 'home-access')
}

section('§7 the file on disk stays readable by 1.0.0-beta.36: the base\'s own ledger reader on the two-entry file; no base reader of the pocket paths')
{
  const two = join(HOME, '.sign-ins.json')
  const fileNow = json(two)
  check('the ledger file carries both signIns (the .36 rows) and entries (the .37 addition)', typeof fileNow.signIns === 'object' && typeof fileNow.entries === 'object', Object.keys(fileNow).join(','))
  const scratch = mkdtempSync(join(tmpdir(), 'base-ledger-reader-'))
  mkdirSync(join(scratch, 'src', 'utils', 'accounts'), { recursive: true })
  symlinkSync(join(REPO, 'src', 'substrate'), join(scratch, 'src', 'substrate'), 'dir')
  mkdirSync(join(scratch, 'src', 'utils', 'router'), { recursive: true })
  const baseLedger = execFileSync('git', ['-C', REPO, 'show', `${BASE}:src/utils/accounts/signInLedger.ts`], { encoding: 'utf8' })
  writeFileSync(join(scratch, 'src', 'utils', 'accounts', 'signInLedger.ts'), baseLedger)
  check('the base reader has no entries section (the addition is unknown to it)', !/entries\?:/.test(baseLedger) && !/readSignInEntries/.test(baseLedger))
  const base = (await import(join(scratch, 'src', 'utils', 'accounts', 'signInLedger.ts'))) as typeof ledger
  const baseRead = base.readSignInLedger({ home: HOME })
  const nowRead = ledger.readSignInLedger({ home: HOME })
  check('the base reader reads the two-entry file as the one-sign-in ledger it knows', JSON.stringify(baseRead) === JSON.stringify(nowRead) && baseRead.deepseek?.kind === 'api-key', JSON.stringify(baseRead))
  const baseWrote = base.recordSignIn('openrouter', 'api-key', { home: HOME, now: () => 1_700_000_000_000 })
  check('a base rewrite keeps the entries section whole (the versioned-shape law)', baseWrote && typeof json(two).entries === 'object' && Object.keys(ledger.readSignInEntries('deepseek', { home: HOME })).join(',') === '…aaaa')
  let baseGrep = ''
  try {
    baseGrep = execFileSync('git', ['-C', REPO, 'grep', '-l', '-E', '-e', `['"]sign-ins['"]|sign-ins/`, BASE, '--', 'src/'], { encoding: 'utf8' }).trim()
  } catch (error) {
    baseGrep = (error as { status?: number }).status === 1 ? '' : String(error)
  }
  check('nothing at the base reads the sign-ins directory', baseGrep === '', baseGrep)
  rmSync(scratch, { recursive: true, force: true })
}

section('§8 the /accounts board: a second sign-in is a slot of its family, marked, active only when chosen; its ⌫ removes the pocket alone')
{
  pockets.clearSignInChoices()
  secrets.writeStoredDeepseekApiKey(k2)
  pockets.takeLastLanding()
  pockets.clearSignInChoices()
  const { deriveFamilySlotGroups, executeSlotRemoval } = await import('../../src/services/providers/accountSlots.ts')
  const slotsOf = () => deriveFamilySlotGroups().find(group => group.family.id === 'deepseek')?.slots ?? []
  let slots = slotsOf()
  check('the family shows two slots: the home key and the pocket key', slots.length === 2 && slots[1]?.signInIdentity === '…bbbb' && slots[1]?.id.endsWith('@key-bbbb'), JSON.stringify(slots.map(s => [s.id, s.active, s.signInIdentity])))
  check('with no choice the home slot is the active one', slots[0]?.active === true && slots[1]?.active === false)
  check('the pocket slot says it is a second sign-in', /second sign-in · …bbbb/.test(slots[1]?.stateNote ?? ''), slots[1]?.stateNote)
  pockets.setSessionSignIn('deepseek', { identity: '…bbbb', dir: pocketB, kind: 'api-key' })
  slots = slotsOf()
  check('with the pocket chosen the pocket slot is active and the home slot is not', slots[0]?.active === false && slots[1]?.active === true)
  const homeBefore = bytes(homeSecrets)
  const removed = executeSlotRemoval(slots[1]!)
  check('⌫ on the pocket slot removes the pocket and says so', removed.mutated && !existsSync(pocketB) && /second sign-in …bbbb is forgotten/.test(removed.note), JSON.stringify({ mutated: removed.mutated, gone: !existsSync(pocketB), note: removed.note }))
  check('the home key is untouched by the pocket removal', bytes(homeSecrets) === homeBefore && secrets.readStoredDeepseekApiKey() === k1)
  check('the choice fell back to the home', pockets.signInHome('deepseek') === env.getAuthConfigHomeDir() && slotsOf().length === 1)
  secrets.writeStoredDeepseekApiKey(k2)
  pockets.takeLastLanding()
  slots = slotsOf()
  const homeRemoval = executeSlotRemoval(slots[0]!)
  check('⌫ on the home slot clears the home key and leaves the pocket', homeRemoval.mutated && secrets.readStoredDeepseekApiKey() === k2 && pockets.withSignInHome('deepseek', null, () => secrets.readStoredDeepseekApiKey()) === undefined && existsSync(pocketB), homeRemoval.note)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\n✅ SIGN-IN POCKETS GREEN' : `\n❌ SIGN-IN POCKETS RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
