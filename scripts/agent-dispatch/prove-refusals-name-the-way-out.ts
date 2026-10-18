#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'refusals-way-out-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of ['MERCURY_MODEL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'XAI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'MODEL_API_KEY', 'MISTRAL_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'HF_TOKEN', 'MERCURY_COMPAT_BASE_URL', 'MERCURY_COMPAT_MODELS', 'MERCURY_LOCAL_BASE_URL', 'NODE_ENV']) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_EVOLUTION_LEDGER = '0'
for (const base of ['MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_XAI_API_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_OPENROUTER_API_BASE']) process.env[base] = 'http://127.0.0.1:1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' every refusal of the dispatch road names the way out: a page to read, a door to open, an id to name, or the operator to ask')
console.log('============================================================')

const WAY_OUT = [/mercury:\/\/models/, /\/logins/, /ask the operator/, /\/health ROUTER/, /MERCURY_LOCAL_BASE_URL/, /MERCURY_COMPAT_MODELS/]
const OWNERS_WORDS = new Set(['verdict.reason', 'qualification.message', 'authority.reason'])
const compatOwner = readFileSync(join(import.meta.dir, '../../src/services/providers/openaicompat/compatAccounts.ts'), 'utf8')
const path = join(import.meta.dir, '../../src/utils/crew/engineDispatch.ts')
const source = readFileSync(path, 'utf8')
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

type Refusal = { line: number; text: string; dynamic: boolean }
const refusals: Refusal[] = []
const visit = (node: ts.Node): void => {
  if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression) && node.expression.expression.getText(ast) === 'Error') {
    const arg = node.expression.arguments?.[0]
    if (arg) {
      const text = arg.getText(ast)
      const dynamic = !(ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || ts.isTemplateExpression(arg) || ts.isConditionalExpression(arg))
      refusals.push({ line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, text, dynamic })
    }
  }
  ts.forEachChild(node, visit)
}
visit(ast)

section('§1 the census: each refusal thrown by the road')
{
  check('the road throws refusals (the census found them)', refusals.length >= 25, String(refusals.length))
  for (const refusal of refusals) {
    if (refusal.dynamic) {
      const callee = refusal.text.replace(/\(.*$/s, '')
      check(`engineDispatch.ts:${refusal.line} throws its owner's words (${refusal.text.slice(0, 60)})`, OWNERS_WORDS.has(refusal.text) || callee === 'providerUnavailableRefusal' || (refusal.text === 'refusal' && source.includes('const refusal = compatModelRefusal(id)') && compatOwner.includes('mercury://models lists the available endpoint models.')), refusal.text)
      continue
    }
    const named = WAY_OUT.some(way => way.test(refusal.text))
    check(`engineDispatch.ts:${refusal.line} names the way out — ${refusal.text.slice(0, 90).replace(/\s+/g, ' ')}…`, named, refusal.text)
  }
  const unrecognised = source.slice(source.indexOf('export function unrecognisedModelWordRefusal'), source.indexOf('type EngineProvider ='))
  check('the unrecognised-word refusal names mercury://models, the known page and the ask rung (RED on the base)', unrecognised.includes('mercury://models lists the providers the operator is signed into') && unrecognised.includes('${MODEL_LOOKUP_LADDER}'), unrecognised.slice(-400))
  check('no refusal still ends on "never dispatching an unverified id" or "cannot resolve a model." with nothing after it (RED on the base)', !source.includes('never dispatching an unverified id.`') && !source.includes("cannot resolve a model.')"), '')
  check('the provider-unavailable refusal names the sign-in door for a missing credential, the local and compat doors for those slots, and /health ROUTER otherwise', source.includes('export function providerUnavailableRefusal') && source.includes("${door} connects it") && source.includes('MERCURY_LOCAL_BASE_URL') && source.includes('MERCURY_COMPAT_BASE_URL') && source.includes('/health ROUTER names the fix'), '')
}

section('§2 the words on the wire, in the owner\'s shape')
{
  ;(await import('../../src/utils/config.ts')).enableConfigs()
  const engine = await import('../../src/utils/crew/engineDispatch.ts')
  const discovery = await import('../../src/services/providers/providerDiscovery.ts')
  const road = (word: string): Promise<string> => engine.resolveEngineDispatch(word).then(r => `resolved ${r?.model ?? 'null'}`, e => (e instanceof Error ? e.message : String(e)))
  const unrecognised = engine.unrecognisedModelWordRefusal('frobnicator-9000') ?? ''
  check("'frobnicator-9000': names no model — the refusal points at mercury://models and the ask rung, never a provider", unrecognised.includes("model 'frobnicator-9000' names no model") && unrecognised.includes('mercury://models') && unrecognised.includes('ask the operator for the model id') && unrecognised.toLowerCase().includes('never switch to another provider'), unrecognised)
  discovery.__resetProviderDiscoveryForTest()
  const keyless = await road('grok')
  check("'grok' with no sign-in: the door is /logins xai (RED on the base: '/health ROUTER and /capabilities name the fix')", keyless.includes('/logins xai connects it') && keyless.includes('mercury://models'), keyless)
  const localClass = await road('local')
  check("'local' with no server: the refusal names the server to start or MERCURY_LOCAL_BASE_URL, and mercury://models", localClass.includes('MERCURY_LOCAL_BASE_URL') && localClass.includes('mercury://models'), localClass)
  const compatClass = await road('compat')
  check("'compat' with no slot: the refusal names MERCURY_COMPAT_BASE_URL and mercury://models", compatClass.includes('MERCURY_COMPAT_BASE_URL') && compatClass.includes('mercury://models'), compatClass)
  process.env.OPENAI_API_KEY = 'sk-fixture-not-real'
  discovery.__resetProviderDiscoveryForTest()
  const gptUnknown = await road('gpt-9.9-fixture')
  check("'gpt-9.9-fixture' with the live list unreachable: the refusal names the ids this build knows, mercury://models/known and the ask rung (RED on the base: 'dispatchable pins:' alone)", gptUnknown.includes('catalogue-verified') && gptUnknown.includes('mercury://models/known') && gptUnknown.includes('ask the operator for the model id'), gptUnknown)
  delete process.env.OPENAI_API_KEY
  discovery.__resetProviderDiscoveryForTest()
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`}`)
process.exit(failures === 0 ? 0 : 1)
