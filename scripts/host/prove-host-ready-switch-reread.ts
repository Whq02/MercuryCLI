import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

assert.ok(process.env.MERCURY_CONFIG_DIR, 'a scratch MERCURY_CONFIG_DIR is required')
delete process.env.MERCURY_HOME
const home = process.env.MERCURY_CONFIG_DIR
mkdirSync(home, { recursive: true })
const settingsPath = join(home, 'settings.json')
writeFileSync(settingsPath, JSON.stringify({ compatProvider: { before: { baseUrl: 'http://127.0.0.1:9/before/v1' } } }, null, 2) + '\n')

const { resolveHeadlessModel } = await import('../../src/cli/headless/model.ts')
const { configuredCompatEndpoints } = await import('../../src/services/providers/openaicompat/compatAccounts.ts')

let checks = 0
const check = (name: string, truth: unknown, detail = ''): void => { assert.ok(truth, name + (detail ? ': ' + detail : '')); checks++; console.log('PASS ' + name) }

check('the runner resolves the endpoint it booted with', (await resolveHeadlessModel('compat/before/alive')) === 'compat/before/alive')
check('the settings cache now holds the file as it was', configuredCompatEndpoints().map(row => row.name).join(',') === 'before')

const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { compatProvider: Record<string, unknown> }
settings.compatProvider['pod-odoqvdb23009eo'] = { baseUrl: 'http://127.0.0.1:9/pod/v1', hostPodId: 'odoqvdb23009eo' }
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
check('this process has not seen the write yet (the situation the ready switch met)', configuredCompatEndpoints().map(row => row.name).join(',') === 'before')

const hosted = 'compat/pod-odoqvdb23009eo/openai/gpt-oss-120b'
check('the switch to a just-registered rental endpoint resolves: the miss re-read the settings', (await resolveHeadlessModel(hosted)) === hosted)
check('after the re-read the endpoint is in the cache', configuredCompatEndpoints().some(row => row.name === 'pod-odoqvdb23009eo' && row.hostPodId === 'odoqvdb23009eo'))
await assert.rejects(resolveHeadlessModel('compat/pod-nobody/openai/gpt-oss-120b'), /has no configured endpoint/)
check('an endpoint nobody registered is still refused after the re-read', true)

const { persistModelChoice } = await import('../../src/commands/model/persistModelChoice.ts')
const { getInitialSettings } = await import('../../src/utils/settings/settings.ts')
const rental = persistModelChoice(hosted)
check('/model onto the rented pod applies to the session only: nothing saved, no sentence', rental.outcome === 'session' && rental.sentence === '', JSON.stringify(rental))
check('the user’s default model is untouched', (getInitialSettings().engine?.model ?? '') === '' && !readFileSync(settingsPath, 'utf8').includes('"model"'))
const plain = persistModelChoice('compat/before/alive')
check('a compat endpoint that is not a rental still saves as the default', plain.outcome === 'saved' && (getInitialSettings().engine?.model ?? '') === 'compat/before/alive', JSON.stringify(plain))
plain.restore()
console.log('HOST READY SWITCH REREAD GREEN — ' + checks + ' checks; a scratch settings file, no daemon, no network')
