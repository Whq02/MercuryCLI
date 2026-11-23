#!/usr/bin/env bun
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? `\n${detail}` : ''}`)
}

interface SentenceHit {
  file: string
  line: number
  rule: string
  text: string
}

const SURFACES: readonly string[] = [
  'src/models/hosting',
  'src/commands/llmhost',
  'src/commands/host/index.ts',
  'src/models/llm-host/index.ts',
  'src/commands/logins/login.tsx',
  'src/models/sign-in/flow-cards/SignInFlow.tsx',
  'src/models/sign-in/flow-cards/enterKeys.tsx',
  'src/models/sign-in/flow-cards/flowCards.tsx',
  'src/models/sign-in/flow-cards/legCard.tsx',
  'src/models/sign-in/flow-cards/openaiLegs.tsx',
  'src/models/sign-in/flow-cards/readiness.tsx',
  'src/boot/first-run/Onboarding.tsx',
  'src/models/sign-in/flow-cards/loginFamilyRows.ts',
  'src/screen/boot-face/BootLoginsScreen.tsx',
  'src/screen/boot-face/logins',
  'src/models/sign-in/flow-cards/LoginAccountCard.tsx',
  'src/models/sign-in/flow-cards/ApproveApiKey.tsx',
  'src/models/sign-in/gemini-connect/geminiConnectGuide.ts',
  'src/models/sign-in/flow-cards/CompatConnect.tsx',
  'src/models/sign-in/flow-cards/OpenaiConnect.tsx',
  'src/models/sign-in/flow-cards/OpenrouterConnect.tsx',
  'src/models/sign-in/flow-cards/GeminiConnect.tsx',
  'src/models/sign-in/gemini-connect/clientSteps.tsx',
  'src/models/sign-in/flow-cards/HuggingfaceConnect.tsx',
  'src/models/sign-in/flow-cards/KimiConnect.tsx',
  'src/models/sign-in/flow-cards/ZaiConnect.tsx',
  'src/models/sign-in/flow-cards/DeepseekConnect.tsx',
  'src/models/sign-in/flow-cards/XaiConnect.tsx',
  'src/models/sign-in/flow-cards/MetaConnect.tsx',
  'src/models/sign-in/flow-cards/MistralConnect.tsx',
  'src/models/sign-in/flow-cards/NousConnect.tsx',
  'src/models/sign-in/flow-cards/ZenConnect.tsx',
  'src/models/sign-in/flow-cards/MinimaxConnect.tsx',
  'src/models/sign-in/flow-cards/TogetherConnect.tsx',
  'src/models/sign-in/flow-cards/CohereConnect.tsx',
  'src/models/roads/groq/GroqConnect.tsx',
  'src/models/roads/cerebras/CerebrasConnect.tsx',
  'src/models/roads/fireworks/FireworksConnect.tsx',
  'src/models/roads/qwen/QwenConnect.tsx',
  'src/models/roads/openai/openaiAccounts.ts',
  'src/models/roads/openrouter/openrouterAccounts.ts',
  'src/models/roads/gemini/geminiAccounts.ts',
  'src/models/roads/huggingface/huggingfaceAccounts.ts',
  'src/models/roads/moonshot/moonshotAccounts.ts',
  'src/models/roads/zai/zaiAccounts.ts',
  'src/models/roads/deepseek/deepseekAccounts.ts',
  'src/models/roads/xai/xaiAccounts.ts',
  'src/models/roads/meta/metaAccounts.ts',
  'src/models/roads/mistral/mistralAccounts.ts',
  'src/models/roads/nous/nousAccounts.ts',
  'src/models/roads/zen/zenAccounts.ts',
  'src/models/roads/minimax/minimaxAccounts.ts',
  'src/models/roads/together/togetherAccounts.ts',
  'src/models/roads/cohere/cohereAccounts.ts',
  'src/models/roads/groq/groqAccounts.ts',
  'src/models/roads/cerebras/cerebrasAccounts.ts',
  'src/models/roads/fireworks/fireworksAccounts.ts',
  'src/models/roads/qwen/qwenAccounts.ts',
  'src/models/roads/local/localAccounts.ts',
  'src/models/roads/openai/openaiLogin.ts',
  'src/models/roads/openrouter/openrouterLogin.ts',
  'src/models/roads/gemini/geminiLogin.ts',
  'src/models/roads/huggingface/huggingfaceLogin.ts',
  'src/models/roads/moonshot/moonshotLogin.ts',
  'src/models/roads/zai/zaiLogin.ts',
  'src/models/roads/deepseek/deepseekLogin.ts',
  'src/models/roads/xai/xaiLogin.ts',
  'src/models/roads/meta/metaLogin.ts',
  'src/models/roads/mistral/mistralLogin.ts',
  'src/models/roads/nous/nousLogin.ts',
  'src/models/roads/zen/zenLogin.ts',
  'src/models/roads/minimax/minimaxLogin.ts',
  'src/models/roads/together/togetherLogin.ts',
  'src/models/roads/cohere/cohereLogin.ts',
  'src/models/roads/groq/groqLogin.ts',
  'src/models/roads/cerebras/cerebrasLogin.ts',
  'src/models/roads/fireworks/fireworksLogin.ts',
  'src/models/roads/qwen/qwenLogin.ts',
  'src/models/roads/accountSlots.ts',
  'src/models/roads/account-slots',
  'src/models/roads/slotSwitch.ts',
  'src/models/roads/providerUsability.ts',
  'src/screen/settings',
  'src/screen/help',
  'src/screen/tasks',
  'src/screen/trust-dialog',
  'src/screen/fullscreen-layout/MercuryFilesMenu.tsx',
  'src/screen/composer/MercuryFileOpen.tsx',
  'src/commands/localsetup/LocalSetupDialog.tsx',
  'src/commands/exit/WorktreeExitDialog.tsx',
  'src/boot/first-run/SovereignModeDialog.tsx',
  'src/screen/session-chooser/SessionPreview.tsx',
  'src/commands/export/ExportDialog.tsx',
  'src/screen/chat/CrashResumeDialog.tsx',
  'src/models/usage/CostThresholdDialog.tsx',
  'src/boot/first-run/InvalidSettingsDialog.tsx',
  'src/boot/first-run/InvalidConfigDialog.tsx',
  'src/screen/mcp/MCPServerApprovalDialog.tsx',
  'src/screen/mcp/MCPServerMultiselectDialog.tsx',
  'src/commands/bootmenu/index.ts',
  'src/commands/caching/caching.tsx',
  'src/commands/defaultprovider/index.ts',
  'src/commands/export/export.tsx',
  'src/commands/palette/index.ts',
  'src/screen/composer/CapOfferCard.tsx',
  'src/commands/critter/CritterSelect.tsx',
  'src/screen/rewind-picker/RewindPicker.tsx',
  'src/screen/rewind-picker/preview.ts',
  'src/screen/rewind-picker/stats.ts',
  'src/screen/rewind-picker/views.tsx',
  'src/screen/composer/SlotOfferCard.tsx',
  'src/screen/extensions/ExtensionsBoard.tsx',
  'src/screen/extensions/board',
  'src/models/jev/jevKey.ts',
]

const SKIP_FUNCTIONS = new Set([
  'weightCheckScript',
  'tensorFoldEngineScript',
  'downloadWatchScript',
  'hostDownloadScript',
  'bankDownloadScript',
  'privateRepoDownloadScript',
  'boxEngineScript',
  'boxServiceDocument',
  'boxServiceCommand',
  'restartHostScript',
  'readHostEngine',
  'verifyBoxBank',
  'sealDownloadedBank',
  'engineBinary',
  'downloadFailure',
])

const SKIP_CONSTS = new Set([
  'pythonInstall',
  'llamaInstall',
  'boxInspectionScript',
  'windowsBoxInspectionScript',
  'processTable',
  'ONSTART',
  'LAMBDA_USER_DATA',
  'KEPT_MISMATCH',
])

const SKIP_CALLS = new Set(['logForDebugging', 'logError', 'noteLockRelease'])

const ALLOW_LIST: ReadonlyArray<{ file: string; text: string; reason: string }> = [
  {
    file: 'src/models/hosting/vendors/client.ts',
    text: 'Mercury’s SSH key is added to this pod only, never to your Runpod account.',
    reason: 'Consent disclosure: tells the user what happens to their Runpod account and pod.',
  },
  {
    file: 'src/models/hosting/vendors/vast.ts',
    text: 'Adds an SSH key to your Vast.ai account and instances. Remove it at https://cloud.vast.ai/manage-keys/ when finished.',
    reason: 'Consent disclosure: tells the user what is added to their Vast.ai account and how to remove it.',
  },
  {
    file: 'src/models/hosting/vendors/lambda.ts',
    text: 'Adds an SSH key to your Lambda account for new rentals. Remove it in the console when finished.',
    reason: 'Consent disclosure: tells the user what is added to their Lambda account and how to remove it.',
  },
  {
    file: 'src/screen/composer/MercuryFileOpen.tsx',
    text: 'fuzzy-find a file to reference…',
    reason: 'User term: referencing a file in the prompt with @.',
  },
  {
    file: 'src/screen/settings/config/configRowsView.tsx',
    text: 'a seat is one model call in flight; ',
    reason: 'Product term: the /seats command and the Seats row in /config.',
  },
  {
    file: 'src/screen/settings/config/configRowsView.tsx',
    text: 'set the seat ceiling to ',
    reason: 'Product term: the /seats command and the Seats row in /config.',
  },
  {
    file: 'src/screen/settings/config/configRowsView.tsx',
    text: 'Hide the side rails for full-width chat. /zen also toggles this.',
    reason: 'User screen term: the LANES and VITALS side rails in the cockpit.',
  },
  {
    file: 'src/screen/settings/config/configRowsMemory.tsx',
    text: ' · pin and unpin in /memory',
    reason: 'User command term: pinning and unpinning rules in /memory.',
  },
  {
    file: 'src/screen/settings/config/configRowsMemory.tsx',
    text: 'Memory at start, beyond the pins',
    reason: 'User command term: pinned rules in /memory.',
  },
]

const MECHANISM_WORDS: ReadonlyArray<[string, RegExp]> = [
  ['injected', /\binjected\b/i],
  ['replay', /\breplay(s|ed|ing)?\b/i],
  ['carried', /\bcarried\b/i],
  ['reconcile', /\breconcil(e|es|ed|ing|iation)\b/i],
  ['listing read', /\blisting read\b/i],
  ['worker', /\bworkers?\b/i],
  ['daemon', /\bdaemons?\b/i],
  ['job record', /\bjob records?\b/i],
  ['job process', /\bjob process\b/i],
  ['its process ended', /\bits process ended\b/i],
  ['pod guard', /\bpod guard\b/i],
  ['proof run', /\bproof run\b/i],
  ['queue', /\b(queue|queued|queuing)\b/i],
  ['fixture', /\bfixtures?\b/i],
  ['road', /\broads?\b/i],
  ['seat (outside /seats)', /(?<!\/)\bseats?\b/i],
  ['lane', /\blanes?\b/i],
  ['ladder', /\bladders?\b/i],
  ['fold', /\bfold(s|ed|ing)?\b/i],
  ['pin (noun/verb)', /\bpins?\b/i],
  ['prover', /\bprovers?\b/i],
  ['census', /\bcensus(es)?\b/i],
  ['carrier', /\bcarriers?\b/i],
  ['reference', /\breferences?\b/i],
  ['ed25519', /\bed25519\b/i],
  ['SHA-256 mechanism (outside SHA256SUMS file name)', /\bSHA-?256(?!SUMS)\b/i],
  ['stays in Mercury / stays here / remains on your computer', /\b(stays in Mercury|private key stays|key remains on your computer|never leaves|Mercury keeps)\b/i],
  ['internal credential store narration', /\b(compat login store|credential store|secret store|not written to settings|never settings|No second HF key is stored|is sent to HF only)\b/i],
  ['when stock appears', /\bwhen stock appears\b/i],
]

function isSentence(text: string): boolean {
  const trimmed = text.trim()
  if (!/\s/.test(trimmed) || !/[A-Za-z]/.test(trimmed)) return false
  if (/^https?:\/\//.test(trimmed)) return false
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE)\b/.test(trimmed)) return false
  if (/^(set -e|export PATH|mkdir -p|command -v|if test|python3 -m|apt-get|docker run)/.test(trimmed)) return false
  return true
}

function insideSkippedContext(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name && SKIP_FUNCTIONS.has(current.name.text)) return true
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && SKIP_CONSTS.has(current.name.text)) return true
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && SKIP_CALLS.has(current.expression.text)) return true
    if (ts.isPropertyAssignment(current) && ts.isIdentifier(current.name) && current.name.text === 'searchText') return true
    if (
      ts.isPropertyAssignment(current) &&
      ts.isIdentifier(current.name) &&
      current.name.text === 'note' &&
      current.parent &&
      ts.isObjectLiteralExpression(current.parent) &&
      current.parent.parent &&
      ts.isPropertyAssignment(current.parent.parent) &&
      ts.isIdentifier(current.parent.parent.name) &&
      current.parent.parent.name.text === 'verified'
    ) {
      return true
    }
  }
  return false
}

function extractSentencesFromSource(file: string, sourceText: string): Array<{ file: string; line: number; text: string }> {
  const sf = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const at = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const out: Array<{ file: string; line: number; text: string }> = []
  const push = (node: ts.Node, text: string): void => {
    if (!isSentence(text) || insideSkippedContext(node)) return
    out.push({ file, line: at(node), text })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      push(node, node.text)
    } else if (ts.isTemplateExpression(node)) {
      for (const chunk of [node.head, ...node.templateSpans.map(span => span.literal)]) {
        push(chunk, chunk.text)
      }
    } else if (ts.isJsxText(node)) {
      push(node, node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function scanSentences(rows: ReadonlyArray<{ file: string; line: number; text: string }>): SentenceHit[] {
  const hits: SentenceHit[] = []
  for (const row of rows) {
    if (ALLOW_LIST.some(allowed => allowed.file === row.file && row.text.includes(allowed.text))) continue
    for (const [rule, pattern] of MECHANISM_WORDS) {
      if (pattern.test(row.text)) {
        hits.push({ file: row.file, line: row.line, rule, text: row.text })
      }
    }
  }
  return hits
}

function collectFiles(): string[] {
  const files: string[] = []
  const walk = (abs: string): void => {
    const st = statSync(abs)
    if (st.isDirectory()) {
      for (const entry of readdirSync(abs)) walk(join(abs, entry))
      return
    }
    if (/\.tsx?$/.test(abs)) files.push(abs)
  }
  for (const surface of SURFACES) walk(join(ROOT, surface))
  return files.sort()
}

console.log('============================================================')
console.log(' quiet prose — user-visible strings speak the user’s side')
console.log('============================================================')

{
  const planted = extractSentencesFromSource(
    'src/models/hosting/planted.ts',
    [
      "const a = 'ed25519 · private key stays in Mercury; public key is injected when stock appears.'",
      "const b = 'Saved in Mercury’s credential store. Never written to the project.'",
      "const c = 'The Mercury daemon must be running before renting a pod.'",
      "const d = 'Bank · b bank the weights to ~/mercury-model-bank (8.2 KB, hash-verified)'",
    ].join('\n'),
  )
  const plantedHits = scanSentences(planted)
  check(
    '§0 self-test: planted mechanism sentences trip and a hash-verified tick stays silent',
    plantedHits.length >= 4 && !plantedHits.some(hit => hit.text.includes('hash-verified')),
    plantedHits.map(h => `    ${h.file}:${h.line} [${h.rule}] ${JSON.stringify(h.text)}`).join('\n'),
  )
  const allowedSample = scanSentences([
    {
      file: ALLOW_LIST[0]!.file,
      line: 20,
      text: ALLOW_LIST[0]!.text,
    },
  ])
  check('§0 self-test: an allow-listed consent disclosure passes', allowedSample.length === 0)
}

const files = collectFiles()
const allSentences = files.flatMap(abs => extractSentencesFromSource(relative(ROOT, abs), readFileSync(abs, 'utf8')))
check(
  `§1 scanned ${files.length} files (${allSentences.length} user-visible sentences)`,
  files.length >= 30 && allSentences.length >= 400,
)

for (const allowed of ALLOW_LIST) {
  check(
    `§2 allow-listed consent sentence stands in ${allowed.file}`,
    allSentences.some(row => row.file === allowed.file && row.text.includes(allowed.text)),
    `    missing: ${JSON.stringify(allowed.text)}`,
  )
}

const hits = scanSentences(allSentences)
check(
  '§3 no user-visible sentence narrates Mercury’s internal mechanics',
  hits.length === 0,
  hits.map(h => `    ${h.file}:${h.line} [${h.rule}] ${JSON.stringify(h.text)}`).join('\n'),
)

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(`FAIL quiet-prose: ${failures} check(s) failed (${hits.length} sentence hit(s))`)
  process.exit(1)
}
console.log(`PASS quiet-prose: ${files.length} files · ${allSentences.length} sentences clean`)
