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
const { ALL_PROVIDER_CREDENTIAL_ENV_VARS } = await import('../../src/services/providers/credentialEnvSpellings.ts')
for (const name of ALL_PROVIDER_CREDENTIAL_ENV_VARS) delete process.env[name]
const { LLM_HOST_SEARCH_MIN_CHARS, LLM_HOST_SEARCH_SETTLE_MS } = await import('../../src/commands/llmhost/words.ts')
const { BANK_DOOR } = await import('../../src/services/host/bank.ts')
const { BANK_KEYS } = await import('../../src/services/host/fastLoad.ts')
const { HF_GATED_WORDS, HF_NOT_CHAT_WORDS, HF_OFFLINE_WORDS, HF_SEARCH_LIMIT, HF_SEARCH_PLACEHOLDER } = await import('../../src/services/host/hfRecipes.ts')
const { hostIdleHoursWords } = await import('../../src/services/host/idle.ts')
const { createHostRoad } = await import('../../src/services/host/index.ts')
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const { HOST_VENDORS, vendorLabel } = await import('../../src/services/host/vendors/client.ts')

const root = resolve(import.meta.dir, '../..')
const doc = readFileSync(join(root, 'docs/LLM-HOST.md'), 'utf8')
const index = readFileSync(join(root, 'docs/README.md'), 'utf8')
const norm = (text: string): string => text.replaceAll('’', "'").replace(/\s+/g, ' ')
let failures = 0, checks = 0
const check = (name: string, truth: unknown): void => { checks++; if (!truth) failures++; console.log((truth ? 'PASS ' : 'FAIL ') + name) }
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
    'the guide does not advertise verification tiers or developer stamps': !/verification stamps|RECIPE · unverified|not booted by Mercury|verified on a live rental|API only — not yet booted|VERIFIED RECIPES/.test(text),
    'search values match the implementation': [HF_SEARCH_PLACEHOLDER, HF_OFFLINE_WORDS, HF_GATED_WORDS, HF_NOT_CHAT_WORDS, modelsHeading].every(word => flat.includes(norm(word))) && flat.includes(LLM_HOST_SEARCH_MIN_CHARS + ' characters') && flat.includes(LLM_HOST_SEARCH_SETTLE_MS + ' ms') && flat.includes('up to ' + HF_SEARCH_LIMIT),
    'model and recipe counts match the catalogue': flat.includes(new Set(HOST_RECIPES.map(row => row.model)).size + ' models') && flat.includes(HOST_RECIPES.length + ' recipes'),
    'model values and optional Tune remain documented': ['**QUALITY**', '**CONVERSATIONS × CONTEXT**', '**THINKING**', '**WEIGHTS**', '**Tune**', '`Choose quality →`'].every(word => text.includes(word)),
    'Bank keys match the actions': JSON.stringify(keys) === JSON.stringify(BANK_KEYS.map(row => [row.key, row.label])),
    'Bank columns and failed-check remedy match the table': [BANK_DOOR, '`MODEL`', '`SIZE`', '`BANKED`', '`CHECK`', '`VOLUME`', '`failed · v`', '`SHA256SUMS`'].every(word => text.includes(word)),
    'Bank folder changes preserve existing files': flat.includes('**Change folder**') && flat.includes('Existing weights are not moved or deleted') && flat.includes('manifest or `config.json`'),
    'Bank checking still includes sizes and hashes': flat.includes('checks file sizes') && flat.includes('`SHA256SUMS` digests') && flat.includes('SHA-256 or git blob hashes'),
    'mirroring covers shipped, derived and private recipes': flat.includes('shipped, derived or private recipe') && flat.includes('download receipts') && flat.includes('any GPU shape'),
    'Vast volumes remain machine-local and separately billed': flat.includes('Vast.ai sells **local volumes only**') && flat.includes('only an instance on that same machine can mount it') && flat.includes('per GB-month'),
    'rental consent names cost, source and closing consequences': flat.includes('**Confirm the hourly price.**') && flat.includes('storage charges and deletion consequences') && flat.includes('private repository') && flat.includes('Bank upload bills compute throughout the transfer') && flat.includes('continues after you close'),
    'watch consent names automatic rental and price ceiling': flat.includes('**Watch for stock and rent at this price or less**') && flat.includes('polls every connected provider') && flat.includes('up to 12 hours'),
    'setup faults pause rather than terminate': flat.includes('No setup check ever terminates a rented machine on its own') && flat.includes('Resume or Terminate in /llmhost') && flat.includes('still billing'),
    'the two-hour idle rule is explicit': flat.includes('The only automatic terminate is the two-hour rule') && flat.includes('no model request reached it for ' + hostIdleHoursWords) && flat.includes('the setup pause went unanswered for ' + hostIdleHoursWords) && flat.includes('the keep-alive poll does not count'),
    'an unconfirmed termination is not reported as gone': flat.includes('`termination sent;') && flat.includes('never claims the pod is gone'),
    'paused engine and link recovery reuse the rental': flat.includes('five failed reconnects pause the rental without terminating it') && flat.includes('an answering engine is reused without restarting it or downloading weights'),
    'paid machines and disk read failures stay distinct': flat.includes('counts only live machines') && flat.includes('If only weights disks cannot be read, the machines remain listed') && flat.includes('failed request and cause and shows **Retry**'),
    'provider credentials and permission remedies remain documented': flat.includes('**Replace key / Remove key**') && flat.includes('https://huggingface.co/settings/tokens') && flat.includes('removal does not stop rentals or bills'),
    'private recipe selection and persistence remain documented': ['**Which private recipes file?**', '**Use this file**', '`host/recipes-file.json`', 'survives restarts', 'zero valid rows', 'invalid row and field'].every(word => flat.includes(word)),
    'tool and reasoning capabilities are not reduced': flat.includes('the request was not sent and no tools were removed') && flat.includes('does not retry at default effort') && flat.includes('`chat_template_kwargs.thinking`'),
    'vision projector and engine remedies remain documented': HOST_RECIPES.filter(row => row.mmproj).every(row => text.includes('`' + row.mmproj + '`')) && text.includes('`--enable-auto-tool-choice`') && text.includes('`--tool-call-parser`'),
    'spinner words agree with the concise HUD': flat.includes('verb, elapsed time, token count and rate') && !/waiting for the first token|reading <N>k tokens|↓ ~<N> thinking tokens|`writing`/.test(text),
  }
}
for (const [name, truth] of Object.entries(facts(doc))) check(name, truth)
check('documentation index points at hosting, search and Bank', ['`/llmhost`', '`mercury host`', 'Hugging Face', 'Bank'].every(word => index.split('\n').find(line => line.includes('[LLM-HOST.md]'))?.includes(word)))
check('poison: developer stamp fails', !facts(doc + '\nverified on a live rental')['the guide does not advertise verification tiers or developer stamps'])
check('poison: changed bank key fails', !facts(doc.replace('- **`m` (`mirror`):**', '- **`m` (`upload`):**'))['Bank keys match the actions'])
check('poison: stale HUD phase fails', !facts(doc + '\nwaiting for the first token')['spinner words agree with the concise HUD'])
console.log((failures ? 'FAIL' : 'PASS') + ' prove-llmhost-doc: ' + (checks - failures) + '/' + checks)
if (failures) process.exit(1)
