import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = mkdtempSync(join(tmpdir(), 'model-page-count-'))
process.env.MERCURY_CONFIG_DIR = home
await import('../../src/integrations/resources/registry.ts')
const { liveModelsReferenceText } = await import('../../src/integrations/resources/adapters/models.ts')
const { liveCount } = await import('../../src/models/facts/modelPickerGroups.ts')
const models = [{ id: 'first', displayName: 'First' }, { id: 'second', displayName: 'Second' }, { id: 'hidden', displayName: 'Hidden', unavailable: 'hidden by the account source' }]
const count = liveCount(models.map(model => ({ id: model.id, name: model.displayName, tag: '', group: 'OpenAI', gated: model.unavailable !== undefined })))
const text = liveModelsReferenceText({ readAt: 'now', notSignedIn: [], providers: [{ provider: 'openai', providerName: 'OpenAI', account: 'fixture', list: { kind: 'live', count: 10, readAt: 'now' }, models }] })
const ok = text.includes(`(${count} live)`) && !text.includes('(10 models)') && text.includes('hidden by the account source')
console.log(`${ok ? 'PASS' : 'FAIL'} the provider header counts the same selectable rows as the picker, without hiding unavailable rows${ok ? '' : ' \u2014 to fix, make the provider header in liveModelsReferenceText (src/integrations/resources/adapters/models.ts) print the count liveCount (src/models/facts/modelPickerGroups.ts) gives, keep unavailable rows listed with their reason, and never print the provider list count as (N models)'}\n${text}`)
rmSync(home, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
