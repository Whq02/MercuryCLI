#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const scratchHome = mkdtempSync(join(tmpdir(), 'docs-llmhost-home-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
delete process.env.MERCURY_HOME
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
process.on('exit', () => rmSync(scratchHome, { recursive: true, force: true }))

const { LLM_HOST_SEARCH_MIN_CHARS, LLM_HOST_SEARCH_SETTLE_MS } = await import('../../src/commands/llmhost/words.ts')
const { BANK_DOOR } = await import('../../src/services/host/bank.ts')
const { modelTitle } = await import('../../src/services/host/door.ts')
const { keptStallWords } = await import('../../src/services/host/download.ts')
const { BANK_KEYS } = await import('../../src/services/host/fastLoad.ts')
const { HF_GATED_WORDS, HF_NOT_CHAT_WORDS, HF_OFFLINE_WORDS, HF_SEARCH_LIMIT, HF_SEARCH_PLACEHOLDER } = await import('../../src/services/host/hfRecipes.ts')
const { hostIdleHoursWords } = await import('../../src/services/host/idle.ts')
const { createHostRoad } = await import('../../src/services/host/index.ts')
const { HOST_RECIPES } = await import('../../src/services/host/recipes.ts')
const { hostRecipeSchema } = await import('../../src/services/host/recipesFile.ts')
const { HOST_VENDORS, vendorLabel } = await import('../../src/services/host/vendors/client.ts')
const { vendorStamp } = await import('../../src/services/host/vendors/vendor.ts')
const { compatImageRefusalWords } = await import('../../src/services/providers/openaicompat/compatProbe.ts')
const { compatEngineRefusalText, compatToolSupportRefusal } = await import('../../src/services/providers/openaicompat/compatRefusals.ts')
const { compatToolSchemaRefusal } = await import('../../src/services/providers/openaicompat/compatToolSchemas.ts')
const { updateSettingsForSource } = await import('../../src/utils/settings/settings.ts')

const ROOT = resolve(import.meta.dir, '..', '..')

const docPath = join(ROOT, 'docs', 'LLM-HOST.md')
const indexPath = join(ROOT, 'docs', 'README.md')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${title}`)
const normQuotes = (text: string): string => text.replaceAll('’', "'").replaceAll('“', '"').replaceAll('”', '"')

function schemaStampOptions(): string[] {
  const candidates = ['measured', 'documented', 'community', 'unverified', 'invented']
  const base = {
    id: 'sample-id',
    label: 'Sample · FP8',
    model: 'org/sample',
    gpu: 'H100',
    count: 1,
    vramGb: 80,
    diskGb: 100,
    weightsGb: 50,
    image: 'vllm/vllm-openai:latest',
    cuda: '13.0',
    flags: [],
    source: 'https://huggingface.co/org/sample',
    verification: 'sample',
  }
  return candidates.filter(by =>
    hostRecipeSchema.safeParse({
      ...base,
      verified: { by, on: '2026-10-22', source: 'https://huggingface.co/org/sample' },
    }).success,
  )
}

let liveMenuLabel = ''
let livePaidLabel = ''
async function liveWhereRows(): Promise<string[]> {
  let rows: string[] = []
  const road = createHostRoad({
    runner: {
      run: async () => '',
      tunnel: () => ({ stop: () => {}, failed: () => undefined }),
    },
  })
  await road(
    async plan => {
      if (plan.step === 'door-models') { liveMenuLabel = normQuotes(plan.rows?.find(row => row.value === 'other')?.label ?? ''); livePaidLabel = normQuotes(plan.rows?.find(row => row.value === 'pods')?.label.split('\n').at(-1)?.split(' · ')[0] ?? ''); return 'other' }
      if (plan.step === 'where') {
        rows = (plan.rows ?? []).map(row => normQuotes(row.label))
        return null
      }
      return null
    },
    () => {},
    new AbortController().signal,
  )
  return rows
}

interface ValidationResult {
  stampsMatch: boolean
  stampMeaningsMatch: boolean
  otherRoadsMatch: boolean
  bankKeysMatch: boolean
  vendorsMatch: boolean
  vendorStampsMatch: boolean
  searchFactsMatch: boolean
  modelScreenMatches: boolean
  bankScreenMatches: boolean
  watchAndRunpodOnlyMatch: boolean
  failureAndHiccupWordsMatch: boolean
  projectorAndEngineRefusalsMatch: boolean
  indexMatches: boolean
  detail: Record<string, string>
}

function validateLlmHostDoc(
  docText: string,
  indexText: string,
  expectedStamps: readonly string[],
  expectedWhereRows: readonly string[],
): ValidationResult {
  const doc = normQuotes(docText)
  const flatDoc = doc.replace(/\s+/g, ' ')
  const idx = normQuotes(indexText)

  const stampMatches = [...doc.matchAll(/^- \*\*`(measured|documented|community|unverified)`:\*\* (.+)$/gm)]
  const docStamps = stampMatches.map(m => m[1]!)
  const stampByKind = new Map(stampMatches.map(m => [m[1]!, m[2]!]))
  const stampsMatch = JSON.stringify(docStamps) === JSON.stringify(expectedStamps)

  const stampMeaningsMatch =
    /booted the recipe on that GPU shape/.test(stampByKind.get('measured') ?? '') &&
    /published deployment guide or model card/.test(stampByKind.get('documented') ?? '') &&
    /community repository/.test(stampByKind.get('community') ?? '') &&
    /derived on the spot from a Hugging Face repository's file list and `config\.json`/.test(stampByKind.get('unverified') ?? '') &&
    /nobody has booted this exact recipe yet/.test(stampByKind.get('unverified') ?? '')

  const otherBlock = /`More options →` menu \(([\s\S]*?)\)\. Each/.exec(doc)?.[1] ?? ''
  const docOtherRoads = [...otherBlock.matchAll(/`([^`]+)`/g)].map(m => m[1]!.replace(/\s+/g, ' '))
  const otherRoadsMatch =
    JSON.stringify(docOtherRoads) === JSON.stringify(expectedWhereRows) &&
    !flatDoc.includes('Fast-load (keep weights near the GPU)')

  const bankKeyMatches = [...doc.matchAll(/^- \*\*`([a-z])` \(`([^`]+)`\):\*\*/gm)].map(m => [m[1]!, m[2]!])
  const expectedBankKeys = BANK_KEYS.map(row => [row.key, row.label ?? row.value])
  const bankKeysMatch = JSON.stringify(bankKeyMatches) === JSON.stringify(expectedBankKeys)

  const expectedVendorLabels = HOST_VENDORS.map(vendorLabel)
  const rentHeading = /^## Rent a GPU \(([^)]+)\)$/m.exec(doc)?.[1] ?? ''
  const docVendors = rentHeading.split(/,\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean)
  const vendorsMatch = JSON.stringify(docVendors) === JSON.stringify(expectedVendorLabels)

  const vendorStampsMatch = HOST_VENDORS.every(id => {
    const label = vendorLabel(id)
    const stamp = normQuotes(vendorStamp(id))
    return doc.includes(label) && doc.includes(`\`${stamp}\``)
  })

  const modelCount = new Set(HOST_RECIPES.map(row => row.model)).size
  const recipeCount = HOST_RECIPES.length
  const searchFactsMatch =
    doc.includes(`\`${normQuotes(HF_SEARCH_PLACEHOLDER)}\``) &&
    flatDoc.includes(`${LLM_HOST_SEARCH_MIN_CHARS} characters`) &&
    flatDoc.includes(`${LLM_HOST_SEARCH_SETTLE_MS} ms`) &&
    flatDoc.includes(`up to ${HF_SEARCH_LIMIT}`) &&
    doc.includes('`VERIFIED RECIPES`') &&
    doc.includes('`HUGGING FACE · fetching…`') &&
    doc.includes(`\`${normQuotes(HF_OFFLINE_WORDS)}\``) &&
    doc.includes(`\`${normQuotes(HF_GATED_WORDS)}\``) &&
    doc.includes(`\`${normQuotes(HF_NOT_CHAT_WORDS)}\``) &&
    flatDoc.includes(`${modelCount} models`) &&
    flatDoc.includes(`${recipeCount} recipes`) &&
    new Set(HOST_RECIPES.map(modelTitle)).size > 0

  const modelScreenMatches =
    doc.includes('`RECIPE · unverified — recipe derived from the repo') &&
    doc.includes('**QUALITY:**') &&
    doc.includes('**CONVERSATIONS × CONTEXT:**') &&
    doc.includes('**THINKING:**') &&
    doc.includes('**WEIGHTS:**') &&
    doc.includes('**WHERE:**') &&
    doc.includes('`boots from your volume`') &&
    doc.includes('`downloads the weights first`') &&
    doc.includes('`Watch stock · across every provider above · tell me when the cheapest shape comes back`')

  const bankScreenMatches =
    doc.includes(`\`${BANK_DOOR}\``) &&
    ['MODEL', 'SIZE', 'BANKED', 'VERIFIED', 'VOLUME'].every(col => doc.includes(`\`${col}\``)) &&
    doc.includes('`bank.json`') &&
    doc.includes('`SHA256SUMS`') &&
    doc.includes('`~/mercury-model-bank`')

  const watchAndRunpodOnlyMatch =
    flatDoc.includes('polls every connected provider') &&
    !flatDoc.includes('Stock watches, multi-node clusters') &&
    flatDoc.includes('Multi-node clusters and in-place `Tune` reloads are supported on Runpod only') &&
    !flatDoc.includes('fast-load weights volumes and in-place `Tune` reloads are supported on Runpod only') &&
    flatDoc.includes('kept weights volumes exist on Runpod (one data centre or any) and on Vast.ai (one machine)') &&
    flatDoc.includes('Vast.ai sells **local volumes only**') &&
    flatDoc.includes('`Vast.ai volume · keep on one Vast.ai machine · per GB-month at the machine\'s rate`') &&
    flatDoc.includes('a rental on that machine boots in ~<m> min · other machines download') &&
    flatDoc.includes('boots from your Vast.ai volume on its machine') &&
    flatDoc.includes('no stock on that machine right now · w watch it')

  const failureAndHiccupWordsMatch =
    doc.includes('`the engine died loading the weights:') &&
    doc.includes('`Download stalled') &&
    doc.includes(keptStallWords) &&
    doc.includes('`Engine not ready. The engine printed nothing new for') &&
    doc.includes("`the machine never accepted Mercury's SSH key before the setup deadline") &&
    doc.includes('`the vendor no longer lists pod') &&
    doc.includes('`termination sent;') &&
    doc.includes('retrying in') &&
    doc.includes('did not answer') &&
    doc.includes('`setup paused · Resume retries') &&
    flatDoc.includes('No setup check ever terminates a rented machine on its own') &&
    doc.includes('stays up and bills $<rate>/hr while paused · Resume retries the setup, Terminate stops the bill · /llmhost → Machines I\'m paying for`') &&
    flatDoc.includes('The only automatic terminate is the two-hour rule') &&
    doc.includes('no model request reached it for ' + hostIdleHoursWords) &&
    doc.includes('the setup pause went unanswered for ' + hostIdleHoursWords) &&
    doc.includes('the engine died and the pause went unanswered for ' + hostIdleHoursWords) &&
    doc.includes('the link dropped and the pause went unanswered for ' + hostIdleHoursWords) &&
    doc.includes('`Mercury attached the SSH key to this instance and retried`') &&
    flatDoc.includes('retries for up to four more minutes') &&
    flatDoc.includes('five failed reconnects pause the rental without terminating it') &&
    doc.includes('`Resume reconnects, Terminate stops the bill`') &&
    doc.includes('`engine log unread`') &&
    flatDoc.includes('The notice detail includes the last engine lines') &&
    flatDoc.includes('an answering engine is reused without restarting it or downloading weights') &&
    flatDoc.includes("name the rental and Mercury's reconnect count") &&
    doc.includes('`link dropped <n> min ago · <k> reconnects`') &&
    flatDoc.includes('stays selectable but follows unaffected machines') &&
    flatDoc.includes('the keep-alive poll does not count') &&
    !flatDoc.includes('three times in a row') &&
    !flatDoc.includes('machine terminated and verified absent · nothing more bills') &&
    !flatDoc.includes('Mercury terminates the pod')

  updateSettingsForSource('userSettings', () => ({
    compatProvider: {
      'pod-1': { baseUrl: 'http://127.0.0.1:30000/v1', label: 'pod-1', dialect: 'llamacpp' },
    },
  }))
  const projectors = HOST_RECIPES.map(r => r.mmproj).filter((v): v is string => Boolean(v))
  const sampleImageRefusal = normQuotes(compatImageRefusalWords('compat/pod-1/model', 'missing mmproj') ?? '')
  const sampleVllmRefusal = normQuotes(compatEngineRefusalText('vllm', { status: 400, message: 'auto tool choice requires --enable-auto-tool-choice and --tool-call-parser' }) ?? '')
  const sampleNoTools = normQuotes(compatToolSupportRefusal('sglang', 'model-x'))
  const sampleBadSchema = normQuotes(compatToolSchemaRefusal('llamacpp', { name: 'BadTool', input_schema: { $ref: '#' } }) ?? '')
  const projectorAndEngineRefusalsMatch =
    projectors.length > 0 &&
    projectors.every(p => doc.includes(`\`${p}\``)) &&
    doc.includes('`--mmproj`') &&
    sampleImageRefusal.includes('without its vision projector') &&
    flatDoc.includes('without its vision projector') &&
    sampleVllmRefusal.includes('--enable-auto-tool-choice') &&
    doc.includes('`--enable-auto-tool-choice`') &&
    sampleNoTools.includes('reports no tool-call support') &&
    flatDoc.includes('reports no tool-call support') &&
    sampleBadSchema.includes('the request was not sent and no tools were removed') &&
    flatDoc.includes('the request was not sent and no tools were removed') &&
    doc.includes('`waiting for the first token`')

  const indexLine = idx.split('\n').find(line => line.includes('[LLM-HOST.md](LLM-HOST.md)')) ?? ''
  const indexMatches =
    indexLine.includes('`/llmhost`') &&
    indexLine.includes('`mercury host`') &&
    indexLine.includes('Hugging Face') &&
    indexLine.includes('Bank')

  return {
    stampsMatch,
    stampMeaningsMatch,
    otherRoadsMatch,
    bankKeysMatch,
    vendorsMatch,
    vendorStampsMatch,
    searchFactsMatch,
    modelScreenMatches,
    bankScreenMatches,
    watchAndRunpodOnlyMatch,
    failureAndHiccupWordsMatch,
    projectorAndEngineRefusalsMatch,
    indexMatches,
    detail: {
      docStamps: JSON.stringify(docStamps),
      expectedStamps: JSON.stringify(expectedStamps),
      docOtherRoads: JSON.stringify(docOtherRoads),
      expectedWhereRows: JSON.stringify(expectedWhereRows),
      bankKeyMatches: JSON.stringify(bankKeyMatches),
      expectedBankKeys: JSON.stringify(expectedBankKeys),
      docVendors: JSON.stringify(docVendors),
      expectedVendorLabels: JSON.stringify(expectedVendorLabels),
      indexLine,
    },
  }
}

const expectedStamps = schemaStampOptions()
const expectedWhereRows = await liveWhereRows()
const docText = readFileSync(docPath, 'utf8')
const indexText = readFileSync(indexPath, 'utf8')
const res = validateLlmHostDoc(docText, indexText, expectedStamps, expectedWhereRows)

section('§1 stamp vocabulary & meanings match hostRecipeSchema')
check('the documented stamp vocabulary equals hostRecipeSchema verified.by in rank order', res.stampsMatch, `${res.detail.docStamps} vs ${res.detail.expectedStamps}`)
check('each of the four stamps (measured, documented, community, unverified) states its meaning from the code', res.stampMeaningsMatch)

section('§2 More options → entries equal the live where-step rows')
check('every mention of the menu in docs/LLM-HOST.md uses the label the Which-model screen paints (' + liveMenuLabel + ') and the retired Other roads → name is gone', liveMenuLabel.length > 0 && (docText.match(/`More options →`/g) ?? []).length >= 7 && docText.split('`' + liveMenuLabel + '`').length - 1 === (docText.match(/`More options →`/g) ?? []).length && !docText.includes('Other roads'))
check('the More options → menu list in docs/LLM-HOST.md equals the where-step rows in order and drops Fast-load (keep weights near the GPU)', res.otherRoadsMatch, `${res.detail.docOtherRoads} vs ${res.detail.expectedWhereRows}`)
check('the paid-machine screen label is read from the live model menu and documented', livePaidLabel === "Machines I'm paying for" && normQuotes(docText).includes('**' + livePaidLabel + '**'))

section('§3 Bank keys & table columns equal BANK_KEYS and fastLoad.ts')
check('the documented Bank shortcut keys equal BANK_KEYS (b, v, m, d, k and their labels)', res.bankKeysMatch, `${res.detail.bankKeyMatches} vs ${res.detail.expectedBankKeys}`)
check('the Bank section names Bank · your weights, the five table columns (MODEL, SIZE, BANKED, VERIFIED, VOLUME), bank.json and SHA256SUMS', res.bankScreenMatches)

section('§4 GPU vendors and their live-rental / API-only stamps equal HOST_VENDORS')
check('the Rent section names HOST_VENDORS in order (Runpod, Vast.ai, Lambda, Hugging Face)', res.vendorsMatch, `${res.detail.docVendors} vs ${res.detail.expectedVendorLabels}`)
check('every vendor stamp from vendorStamp(id) is documented verbatim', res.vendorStampsMatch)

section('§5 Hugging Face search, model screen, cross-provider stock watch, failure cleanup, vendor hiccups, vision projectors and engine refusals')
check('Hugging Face search parameters, section headings, gated/non-chat/offline notices and 32-model / 78-recipe counts match the code', res.searchFactsMatch)
check('the model screen sections (RECIPE, QUALITY, CONVERSATIONS × CONTEXT, THINKING, WEIGHTS, WHERE), boot words and watch row match door.ts', res.modelScreenMatches)
check('stock watches are documented across all connected providers and not listed as Runpod-only', res.watchAndRunpodOnlyMatch)
check('the setup pause causes (engine death, engine silence, download stall, SSH key refusal), the pause notice, the missing-pod road, the two-hour rule, unconfirmed termination and vendor hiccup retry words match worker.ts, ssh.ts, idle.ts and retry.ts, and no watchdog terminate claim remains', res.failureAndHiccupWordsMatch)
check('shipped GGUF vision projectors (mmproj), image refusal words, engine refusal remedies and first-token progress match compatProbe.ts and compatRefusals.ts', res.projectorAndEngineRefusalsMatch)
check('docs/README.md line for LLM-HOST.md names /llmhost, mercury host, Hugging Face search and the Bank', res.indexMatches, res.detail.indexLine)

section('§6 Bank, account and reasoning instructions agree throughout the guide')
const guide = normQuotes(docText).replace(/\s+/g, ' ')
check('the Bank introduction counts all five keys instead of four', guide.includes('Five single-key shortcuts') && !guide.includes('Four single-key shortcuts'))
check('every paid-screen pointer uses Machines, including the Vast volume section', !/Pods I['’]m paying for/.test(docText))
check('the Bank guide names Change folder and content-based folder recognition', guide.includes('**Change folder**') && guide.includes('Existing weights are not moved or deleted') && guide.includes('manifest or `config.json`'))
check('mirroring covers derived and private banks and any fitting fill shape', guide.includes('shipped, derived or private recipe') && guide.includes('download receipts') && guide.includes('any GPU shape') && !guide.includes('opens Runpod fast-load volume setup for a shipped recipe'))
check('the guide names in-place key controls, the HF permission remedy and live-only machine counts', guide.includes('**Replace key / Remove key**') && guide.includes('https://huggingface.co/settings/tokens') && guide.includes('counts only live machines') && guide.includes('no instances') && guide.includes('unread'))
check('the guide preserves effort on refusal and names the SGLang thinking switch', guide.includes('does not retry at default effort') && guide.includes('`chat_template_kwargs.thinking`') && !guide.includes('retries once without that field'))
check('a failed disk read does not hide machines, names its cause and offers Retry', guide.includes('If only weights disks cannot be read, the machines remain listed') && guide.includes('weights disks unread; storage may still bill') && guide.includes('transient reads try up to three times') && guide.includes('failed request and cause and offers **Retry**'))

check('the private recipe chooser documents the live menu row, path precedence, validation, replacement and persistence', expectedWhereRows.includes('Private recipes · none · choose a file →') && ['**Which private recipes file?**', 'Private recipes · <path> · <N> rows · replaces the shipped list', 'saved choice, `MERCURY_HOST_RECIPES_FILE` and `host/private-recipes.json`', 'zero valid rows', 'invalid row and field', '**Use this file**', '`host/recipes-file.json`', 'survives restarts', 'refreshes immediately with `private` tags'].every(text => guide.includes(text)))

section('§7 poison controls — a drifted doc fails the proof')
check(
  'poison control: dropping unverified from the stamp bullets fails stampsMatch',
  !validateLlmHostDoc(docText.replace('- **`unverified`:**', '- **`draft`:**'), indexText, expectedStamps, expectedWhereRows).stampsMatch,
)
check(
  'poison control: restoring Fast-load (keep weights near the GPU) in More options → fails otherRoadsMatch',
  !validateLlmHostDoc(docText.replace('`Bank · your weights`', '`Fast-load (keep weights near the GPU)`'), indexText, expectedStamps, expectedWhereRows).otherRoadsMatch,
)
check(
  'poison control: changing a Bank key label fails bankKeysMatch',
  !validateLlmHostDoc(docText.replace('- **`m` (`mirror`):**', '- **`m` (`upload`):**'), indexText, expectedStamps, expectedWhereRows).bankKeysMatch,
)
check(
  'poison control: omitting a vendor from the Rent heading fails vendorsMatch',
  !validateLlmHostDoc(docText.replace(/^## Rent a GPU \([^)]+\)$/m, '## Rent a GPU (Runpod and Vast.ai)'), indexText, expectedStamps, expectedWhereRows).vendorsMatch,
)
check(
  'poison control: claiming stock watches are Runpod-only fails watchAndRunpodOnlyMatch',
  !validateLlmHostDoc(`${docText}\nStock watches, multi-node clusters, fast-load weights disks and in-place Tune reloads are supported on Runpod only.\n`, indexText, expectedStamps, expectedWhereRows).watchAndRunpodOnlyMatch,
)

if (failures > 0) {
  console.error(`\nFAIL prove-llmhost-doc: ${failures} of ${checks} check(s) failed`)
  process.exit(1)
}
console.log(`\nPASS prove-llmhost-doc: all ${checks} checks passed`)
