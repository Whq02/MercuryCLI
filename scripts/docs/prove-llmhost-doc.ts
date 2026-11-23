#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const scratchHome = mkdtempSync(join(tmpdir(), 'docs-llmhost-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.on('exit', () => rmSync(scratchHome, { recursive: true, force: true }))
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/models/sign-in/credentials/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
const { LLM_HOST_SEARCH_MIN_CHARS, LLM_HOST_SEARCH_SETTLE_MS } = await import('../../src/commands/llmhost/words.ts')
const { BANK_DOOR } = await import('../../src/models/hosting/bank.ts')
const { BANK_KEYS } = await import('../../src/models/hosting/fastLoad.ts')
const { HF_GATED_WORDS, HF_NOT_CHAT_WORDS, HF_OFFLINE_WORDS, HF_SEARCH_LIMIT, HF_SEARCH_PLACEHOLDER } = await import('../../src/models/hosting/hfRecipes.ts')
const { createHostRoad } = await import('../../src/models/hosting/index.ts')
const { HOST_RECIPES } = await import('../../src/models/hosting/recipes.ts')
const { HOST_VENDORS, vendorLabel } = await import('../../src/models/hosting/vendors/client.ts')

const root = resolve(import.meta.dir, '../..')
const doc = readFileSync(join(root, 'docs/LLM-HOST.md'), 'utf8')
const norm = (text: string): string => text.replaceAll('’', "'").replace(/\s+/g, ' ')
let failures = 0, checks = 0
const llmhostDocFixHint = (name: string): string => name.startsWith('poison')
  ? ' — facts() in this proof no longer notices the changed bank key; fix the Bank keys fact so it compares the doc keys to BANK_KEYS'
  : ' — to fix, edit the matching line of docs/LLM-HOST.md to the live value from src/commands/llmhost/words.ts or src/models/hosting/ (index.ts, bank.ts, fastLoad.ts, hfRecipes.ts, recipes.ts, vendors/client.ts)'
const check = (name: string, truth: unknown): void => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name + (truth ? '' : llmhostDocFixHint(name))) }
let whereRows: string[] = []
let paidLabel = ''
let menuLabel = ''
let modelsHeading = ''
await createHostRoad({ runner: { run: async () => '', tunnel: () => ({ stop: () => {}, failed: () => undefined }) } })(async plan => {
  if (plan.step === 'door-models') {
    paidLabel = plan.rows?.find(row => row.value === 'pods')?.label.split(' · ')[0] ?? ''
    menuLabel = plan.rows?.find(row => row.value === 'other')?.label ?? ''
    modelsHeading = plan.rows?.find(row => row.section)?.section ?? ''
    return 'other'
  }
  if (plan.step === 'where') whereRows = plan.rows?.map(row => norm(row.label)) ?? []
  return null
}, () => {}, new AbortController().signal)

function facts(text: string): Record<string, boolean> {
  const flat = norm(text)
  const menu = /`More options →` menu \(([\s\S]*?)\)\. Each/.exec(text)?.[1] ?? ''
  const docRows = [...menu.matchAll(/`([^`]+)`/g)].map(row => norm(row[1]!))
  const keys = [...text.matchAll(/^- \*\*`([a-z])` \(`([^`]+)`\):\*\*/gm)].map(row => [row[1], row[2]])
  const vendorHeading = /^## Rent a GPU \(([^)]+)\)$/m.exec(text)?.[1] ?? ''
  const vendors = vendorHeading.split(/,\s*|\s+and\s+/).filter(Boolean)
  return {
    'menu entries match the live actions in order': JSON.stringify(docRows) === JSON.stringify(whereRows),
    'paid machines and More options use the live names': flat.includes('**' + norm(paidLabel) + '**') && text.includes('`' + menuLabel + '`'),
    'all vendor names match HOST_VENDORS': JSON.stringify(vendors) === JSON.stringify(HOST_VENDORS.map(vendorLabel)),
    'search values match the implementation': [HF_SEARCH_PLACEHOLDER, HF_OFFLINE_WORDS, HF_GATED_WORDS, HF_NOT_CHAT_WORDS, modelsHeading].every(word => flat.includes(norm(word))) && flat.includes(LLM_HOST_SEARCH_MIN_CHARS + ' characters') && flat.includes(LLM_HOST_SEARCH_SETTLE_MS + ' ms') && flat.includes('up to ' + HF_SEARCH_LIMIT),
    'model and recipe counts match the catalogue': flat.includes(new Set(HOST_RECIPES.map(row => row.model)).size + ' models') && flat.includes(HOST_RECIPES.length + ' recipes'),
    'Bank keys match the actions': JSON.stringify(keys) === JSON.stringify(BANK_KEYS.map(row => [row.key, row.label])),
    'Bank door matches the implementation': text.includes(BANK_DOOR),
    'vision projector files match HOST_RECIPES': HOST_RECIPES.filter(row => row.mmproj).every(row => text.includes('`' + row.mmproj + '`')),
  }
}
for (const [name, truth] of Object.entries(facts(doc))) check(name, truth)
check('poison: changed bank key fails', !facts(doc.replace('- **`m` (`mirror`):**', '- **`m` (`upload`):**'))['Bank keys match the actions'])
console.log((failures ? 'FAIL' : 'PASS') + ' prove-llmhost-doc: ' + (checks - failures) + '/' + checks)
if (failures) process.exit(1)
