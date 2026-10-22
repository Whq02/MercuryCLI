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

export interface SentenceHit {
  file: string
  line: number
  rule: string
  text: string
}

const SURFACES: readonly string[] = [
  'src/services/host',
  'src/commands/llmhost',
  'src/commands/host/index.ts',
  'src/services/llmHost/index.ts',
  'src/components/LlmHostDialog.tsx',
  'src/commands/login/login.tsx',
  'src/components/ConsoleOAuthFlow.tsx',
  'src/components/Onboarding.tsx',
  'src/components/loginFamilyRows.ts',
  'src/components/BootLoginsScreen.tsx',
  'src/components/LoginAccountCard.tsx',
  'src/components/ApproveApiKey.tsx',
  'src/components/MercuryApiKey.tsx',
  'src/components/geminiConnectGuide.ts',
  'src/components/CompatConnect.tsx',
  'src/components/OpenaiConnect.tsx',
  'src/components/OpenrouterConnect.tsx',
  'src/components/GeminiConnect.tsx',
  'src/components/HuggingfaceConnect.tsx',
  'src/components/KimiConnect.tsx',
  'src/components/ZaiConnect.tsx',
  'src/components/DeepseekConnect.tsx',
  'src/components/XaiConnect.tsx',
  'src/components/MetaConnect.tsx',
  'src/components/MistralConnect.tsx',
  'src/components/NousConnect.tsx',
  'src/components/ZenConnect.tsx',
  'src/components/MinimaxConnect.tsx',
  'src/components/TogetherConnect.tsx',
  'src/components/CohereConnect.tsx',
  'src/services/providers/groq/GroqConnect.tsx',
  'src/services/providers/cerebras/CerebrasConnect.tsx',
  'src/services/providers/fireworks/FireworksConnect.tsx',
  'src/services/providers/qwen/QwenConnect.tsx',
  'src/services/providers/openai/openaiAccounts.ts',
  'src/services/providers/openrouter/openrouterAccounts.ts',
  'src/services/providers/gemini/geminiAccounts.ts',
  'src/services/providers/huggingface/huggingfaceAccounts.ts',
  'src/services/providers/moonshot/moonshotAccounts.ts',
  'src/services/providers/zai/zaiAccounts.ts',
  'src/services/providers/deepseek/deepseekAccounts.ts',
  'src/services/providers/xai/xaiAccounts.ts',
  'src/services/providers/meta/metaAccounts.ts',
  'src/services/providers/mistral/mistralAccounts.ts',
  'src/services/providers/nous/nousAccounts.ts',
  'src/services/providers/zen/zenAccounts.ts',
  'src/services/providers/minimax/minimaxAccounts.ts',
  'src/services/providers/together/togetherAccounts.ts',
  'src/services/providers/cohere/cohereAccounts.ts',
  'src/services/providers/groq/groqAccounts.ts',
  'src/services/providers/cerebras/cerebrasAccounts.ts',
  'src/services/providers/fireworks/fireworksAccounts.ts',
  'src/services/providers/qwen/qwenAccounts.ts',
  'src/services/providers/local/localAccounts.ts',
  'src/services/providers/openai/openaiLogin.ts',
  'src/services/providers/openrouter/openrouterLogin.ts',
  'src/services/providers/gemini/geminiLogin.ts',
  'src/services/providers/huggingface/huggingfaceLogin.ts',
  'src/services/providers/moonshot/moonshotLogin.ts',
  'src/services/providers/zai/zaiLogin.ts',
  'src/services/providers/deepseek/deepseekLogin.ts',
  'src/services/providers/xai/xaiLogin.ts',
  'src/services/providers/meta/metaLogin.ts',
  'src/services/providers/mistral/mistralLogin.ts',
  'src/services/providers/nous/nousLogin.ts',
  'src/services/providers/zen/zenLogin.ts',
  'src/services/providers/minimax/minimaxLogin.ts',
  'src/services/providers/together/togetherLogin.ts',
  'src/services/providers/cohere/cohereLogin.ts',
  'src/services/providers/groq/groqLogin.ts',
  'src/services/providers/cerebras/cerebrasLogin.ts',
  'src/services/providers/fireworks/fireworksLogin.ts',
  'src/services/providers/qwen/qwenLogin.ts',
  'src/services/providers/accountSlots.ts',
  'src/services/providers/slotSwitch.ts',
  'src/services/providers/providerUsability.ts',
]

const SKIP_FUNCTIONS = new Set([
  'weightCheckScript',
  'downloadWatchScript',
  'hostDownloadScript',
  'bankDownloadScript',
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

export const ALLOW_LIST: ReadonlyArray<{ file: string; text: string; reason: string }> = [
  {
    file: 'src/services/host/vendors/client.ts',
    text: 'Mercury’s SSH key is added to this pod only, never to your Runpod account.',
    reason: 'Consent disclosure: tells the user what happens to their Runpod account and pod.',
  },
  {
    file: 'src/services/host/vendors/vast.ts',
    text: 'Renting adds Mercury’s SSH public key to your Vast.ai account keys, which Vast.ai installs on your instances. Remove it at https://cloud.vast.ai/manage-keys/ when you stop renting through Mercury.',
    reason: 'Consent disclosure: tells the user what is added to their Vast.ai account and how to remove it.',
  },
  {
    file: 'src/services/host/vendors/lambda.ts',
    text: 'Renting adds Mercury’s SSH public key to your Lambda account keys, named mercury-host- and the key’s fingerprint; only instances launched with that key accept it. Remove it in the Lambda console when you stop renting through Mercury.',
    reason: 'Consent disclosure: tells the user what is added to their Lambda account and how to remove it.',
  },
]

export const MECHANISM_WORDS: ReadonlyArray<[string, RegExp]> = [
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

export function extractSentencesFromSource(file: string, sourceText: string): Array<{ file: string; line: number; text: string }> {
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

export function scanSentences(rows: ReadonlyArray<{ file: string; line: number; text: string }>): SentenceHit[] {
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
    'src/services/host/planted.ts',
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
  const fileText = readFileSync(join(ROOT, allowed.file), 'utf8')
  check(
    `§2 allow-listed consent sentence stands in ${allowed.file}`,
    fileText.includes(allowed.text),
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
