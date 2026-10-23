#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { visit } from './sourceCensus.ts'

const ROOT = resolve(import.meta.dir, '../..')
const SELF = 'scripts/gate/prove-proof-home-discipline.ts'
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8')
const tracked = execFileSync('git', ['ls-files', '-z', '--', 'scripts'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)

const CREDENTIALS = /\b(?:writeStored\w*ApiKey|store\w+Login|writeHostCredential|publishAuthScopedJson|write\w*TokenIdentity|writeAuthFile)\(|(?:from\s*|import\(\s*|require\(\s*)['"][^'"]*\/(?:providerSecrets|\w+Login|\w+Accounts)\.(?:ts|js)['"]/
const PRODUCT = /^(?:\.\.\/)+(?:src|dist)\//
const GUARDS = /guardLoginDriverWrite\(|withProofAccountHome\(|settingsPopupHarness|llmhostFixture\(/
const ACCOUNT_HOME = /homedir\(\)[^\n]*['"]\.mercury['"]|['"]~\/\.mercury|\/Users\/|USERPROFILE/

type Facts = { kept: number[]; pin: number | null; pinNamesAccountHome: boolean; importBeforePin: number | null; staticImport: number | null; dynamicImport: number | null; credentials: boolean; guarded: boolean }

function isHomeEnv(e: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(e)) return e.name.text === 'MERCURY_CONFIG_DIR' && e.expression.getText() === 'process.env'
  if (ts.isElementAccessExpression(e)) return ts.isStringLiteralLike(e.argumentExpression) && e.argumentExpression.text === 'MERCURY_CONFIG_DIR' && e.expression.getText() === 'process.env'
  return false
}

function assignsHome(node: ts.Node): boolean {
  let found = false
  visit(node, m => { if (ts.isBinaryExpression(m) && m.operatorToken.kind === ts.SyntaxKind.EqualsToken && isHomeEnv(m.left)) found = true })
  return found
}

function homeFacts(text: string, name = 'proof.ts'): Facts {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, name.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS)
  const line = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
  const f: Facts = { kept: [], pin: null, pinNamesAccountHome: false, importBeforePin: null, staticImport: null, dynamicImport: null, credentials: false, guarded: GUARDS.test(text) }
  const imports: ts.Node[] = []
  let pinNode: ts.Node | undefined
  visit(sf, n => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && PRODUCT.test(n.moduleSpecifier.text)) f.staticImport ??= line(n)
    if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && PRODUCT.test(n.arguments[0].text)) {
      f.dynamicImport ??= line(n)
      imports.push(n)
    }
    if (ts.isBinaryExpression(n) && isHomeEnv(n.left)) {
      const op = n.operatorToken.kind
      if (op === ts.SyntaxKind.QuestionQuestionEqualsToken || op === ts.SyntaxKind.BarBarEqualsToken) f.kept.push(line(n))
      else if (op === ts.SyntaxKind.EqualsToken) {
        const right = n.right
        if (ts.isBinaryExpression(right) && isHomeEnv(right.left) && (right.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || right.operatorToken.kind === ts.SyntaxKind.BarBarToken)) f.kept.push(line(n))
        else if (ts.isConditionalExpression(right) && isHomeEnv(right.condition)) f.kept.push(line(n))
        else if (f.pin === null) {
          f.pin = line(n)
          pinNode = n
          f.pinNamesAccountHome = ACCOUNT_HOME.test(right.getText())
        }
      }
    }
    if (ts.isIfStatement(n) && ts.isPrefixUnaryExpression(n.expression) && n.expression.operator === ts.SyntaxKind.ExclamationToken && isHomeEnv(n.expression.operand) && assignsHome(n.thenStatement)) f.kept.push(line(n))
  })
  if (pinNode !== undefined) {
    const enclosing = new Set<ts.Node>()
    for (let a: ts.Node | undefined = pinNode; a !== undefined; a = a.parent) if (ts.isBlock(a) || ts.isSourceFile(a) || ts.isModuleBlock(a)) enclosing.add(a)
    for (const i of imports) {
      if (i.getStart() >= pinNode.getStart()) continue
      let block: ts.Node | undefined = i.parent
      while (block !== undefined && !(ts.isBlock(block) || ts.isSourceFile(block) || ts.isModuleBlock(block))) block = block.parent
      if (block !== undefined && enclosing.has(block)) { f.importBeforePin = line(i); break }
    }
  }
  f.credentials = CREDENTIALS.test(text) && (f.staticImport !== null || f.dynamicImport !== null)
  return f
}

function pythonKeeps(text: string): number[] {
  const hits: number[] = []
  text.split('\n').forEach((l, i) => { if (/environ\.setdefault\(\s*['"]MERCURY_CONFIG_DIR['"]/.test(l) || /environ\.get\(\s*['"]MERCURY_CONFIG_DIR['"][^\n]*\)\s*or\s/.test(l)) hits.push(i + 1) })
  return hits
}

{
  const kept = homeFacts("process.env['MERCURY_CONFIG_DIR'] ??= mkdtempSync(join(tmpdir(), 'x-'))\nconst m = await import('../../src/a.ts')\nwriteStoredZaiApiKey('k')\n")
  assert.deepEqual(kept.kept, [1]); assert.equal(kept.pin, null); assert.equal(kept.dynamicImport, 2); assert.ok(kept.credentials)
  const pinned = homeFacts("import { x } from '../lib/kit.ts'\nprocess.env.MERCURY_CONFIG_DIR = mkdtempSync('p')\nconst m = await import('../../src/a.ts')\n")
  assert.deepEqual(pinned.kept, []); assert.equal(pinned.pin, 2); assert.equal(pinned.staticImport, null); assert.equal(pinned.dynamicImport, 3)
  const late = homeFacts("import { y } from '../../src/b.ts'\nprocess.env.MERCURY_CONFIG_DIR = process.env.MERCURY_CONFIG_DIR || '/tmp/x'\nif (!process.env.MERCURY_CONFIG_DIR) process.env.MERCURY_CONFIG_DIR = '/tmp/y'\n")
  assert.deepEqual(late.kept, [2, 3]); assert.equal(late.staticImport, 1)
  const quoted = homeFacts("check('never ??= the ambient one', !face.includes(\"process.env['MERCURY_CONFIG_DIR'] ??= mkdtempSync(\"))\n")
  assert.deepEqual(quoted.kept, []); assert.equal(quoted.pin, null)
  const reads = homeFacts("const home = process.env.MERCURY_CONFIG_DIR ?? '/tmp/z'\nif (!process.env.MERCURY_CONFIG_DIR) throw new Error('pin it')\n")
  assert.deepEqual(reads.kept, []); assert.equal(reads.pin, null)
  const census = homeFacts("const text = readFileSync('x.ts', 'utf8')\ncheck(text.includes('writeStoredZaiApiKey('))\nconst paths = ['src/services/providers/providerSecrets.ts']\n")
  assert.equal(census.credentials, false)
  const branches = homeFacts("if (child) {\n  const a = await import('../../src/a.ts')\n} else {\n  process.env.MERCURY_CONFIG_DIR = mkdtempSync('p')\n  const b = await import('../../src/services/providers/providerSecrets.ts')\n}\n")
  assert.equal(branches.importBeforePin, null); assert.ok(branches.credentials)
  const top = homeFacts("const env = await import('../../src/utils/envUtils.js')\n{\n  process.env.MERCURY_CONFIG_DIR = join(homedir(), '.mercury')\n}\n")
  assert.equal(top.importBeforePin, 1); assert.ok(top.pinNamesAccountHome)
  assert.equal(homeFacts("process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'p-'))\n").pinNamesAccountHome, false)
  assert.deepEqual(pythonKeeps("os.environ.setdefault('MERCURY_CONFIG_DIR', home)\nhome = os.environ.get('MERCURY_CONFIG_DIR') or tmp\nprint('MERCURY_CONFIG_DIR')\n"), [1, 2])
  console.log('PASS the detectors read a kept inherited home, an own pin and the first product import; a spelling inside a string is not an assignment')
}

const KEPT_HOME_WITHOUT_CREDENTIALS = new Set<string>([
  'scripts/agents/prove-structured-delivery.ts',
  'scripts/crew/prove-old-tool-name-rows.ts',
  'scripts/crew/prove-unshipped-tool-rows.ts',
  'scripts/dap/prove-dap-data-breakpoints.ts',
  'scripts/docs/prove-automation-examples.ts',
  'scripts/docs/prove-llmhost-doc.ts',
  'scripts/edit-tools/prove-write-edit-parse-check.ts',
  'scripts/headless/prove-blocked-run-exit.ts',
  'scripts/headless/prove-refusal-stays-closed.ts',
  'scripts/headless/prove-two-kinds-of-headless.ts',
  'scripts/ide/prove-debug-memory-adapters.ts',
  'scripts/lsp/prove-lsp-rename-fanout.ts',
  'scripts/memory/prove-semantic-study-honest.ts',
  'scripts/sdk/prove-run-door-client.ts',
  'scripts/tools/prove-sleep-row-frames.ts',
  'scripts/tools/prove-tool-contracts.ts',
  'scripts/wards/prove-generated-file-guard.ts',
  'scripts/wards/prove-omission-placeholder.ts',
  'scripts/wards/prove-wards.ts',
])
const STATIC_IMPORT_BEFORE_PIN = new Set<string>([
  'scripts/host/prove-recipes-live.ts',
  'scripts/provider-compat/prove-auth-journeys.ts',
  'scripts/providers/prove-usage-owner-per-family.ts',
  'scripts/settings/prove-usage-oauth-credits-words.ts',
])
const ACCOUNT_HOME_ON_PURPOSE: Record<string, string> = {
  'scripts/accounts/prove-auth-scope-isolation.ts': "pins the resolver at the account's own path, as a string, to prove the rest-identity law (getAuthConfigHomeDir equals getMercuryHome) and the keychain service-name hashing; it writes no store",
}
const SUITE_HOMED_WRITERS = new Set<string>([
  'scripts/accounts/prove-meta-login.ts',
  'scripts/accounts/prove-mistral-login.ts',
  'scripts/accounts/prove-removal-total.ts',
  'scripts/accounts/prove-xai-login.ts',
  'scripts/accounts/prove-zen-login.ts',
  'scripts/command-catalogue/prove-export-masking.ts',
  'scripts/default-model/prove-computed-default.ts',
  'scripts/eval/prove-env-filter.ts',
  'scripts/headless/prove-no-sign-in-names-local-road.ts',
  'scripts/host/prove-trillion-tier.ts',
  'scripts/host/prove-vendors.ts',
  'scripts/identity/prove-key-entry-one-home.ts',
  'scripts/journey/prove-model-picker-refresh-deepseek.ts',
  'scripts/journey/prove-model-picker-refresh-moonshot.ts',
  'scripts/provauth/prove-gemini-active-source.ts',
  'scripts/provauth/prove-gemini-plan-quota-open-read.ts',
  'scripts/provauth/prove-gemini-plan-signin.ts',
  'scripts/provauth/prove-meta-active-source.ts',
  'scripts/provider-compat/prove-alias-served-rows.ts',
  'scripts/provider-compat/prove-cerebras-wire.ts',
  'scripts/provider-compat/prove-cohere-wire.ts',
  'scripts/provider-compat/prove-fireworks-wire.ts',
  'scripts/provider-compat/prove-gemini-live-list.ts',
  'scripts/provider-compat/prove-groq-wire.ts',
  'scripts/provider-compat/prove-meta-catalogue.ts',
  'scripts/provider-compat/prove-minimax-wire.ts',
  'scripts/provider-compat/prove-mistral-catalogue.ts',
  'scripts/provider-compat/prove-moonshot-plan-picker.ts',
  'scripts/provider-compat/prove-nous-key-road.ts',
  'scripts/provider-compat/prove-qwen-wire.ts',
  'scripts/provider-compat/prove-together-wire.ts',
  'scripts/provider-compat/prove-xai-catalogue.ts',
  'scripts/provider-compat/prove-zai-flash-wire.ts',
  'scripts/providers/prove-gemini-family-refusal.ts',
  'scripts/providers/prove-meta-contract.ts',
  'scripts/providers/prove-mistral-contract.ts',
  'scripts/providers/prove-nous-client-contract.ts',
  'scripts/providers/prove-nous-contract.ts',
  'scripts/providers/prove-nous-signin.ts',
  'scripts/providers/prove-openrouter-expired-key.ts',
  'scripts/providers/prove-openrouter-refused-key.ts',
  'scripts/providers/prove-recorded-dead-key-reads-refused.ts',
  'scripts/providers/prove-xai-usage.ts',
  'scripts/providers/prove-zai-catalogue.ts',
  'scripts/providers/prove-zai-env-key-plan.ts',
  'scripts/providers/prove-zen-contract.ts',
])

const proofs = tracked.filter(path => /\/prove-[^/]+\.(?:ts|tsx|mjs|py)$/.test(path) && path !== SELF)
const failures: string[] = []
const found = { keptWithoutCredentials: new Set<string>(), staticBeforePin: new Set<string>(), suiteHomed: new Set<string>() }
let credentialProofs = 0
for (const path of proofs) {
  const text = read(path)
  if (path.endsWith('.py')) {
    for (const line of pythonKeeps(text)) failures.push(`${path}:${line}: a proof never keeps an inherited MERCURY_CONFIG_DIR; assign a scratch home of its own`)
    continue
  }
  const f = homeFacts(text, path)
  if (f.pinNamesAccountHome && !(path in ACCOUNT_HOME_ON_PURPOSE)) failures.push(`${path}:${f.pin}: the pin names the account's own home; a proof pins a scratch home of its own (a proof that reads the account home on purpose is listed in ACCOUNT_HOME_ON_PURPOSE with its reason)`)
  if (!f.credentials) {
    if (f.kept.length > 0) found.keptWithoutCredentials.add(path)
    continue
  }
  credentialProofs++
  for (const line of f.kept) failures.push(`${path}:${line}: a proof that reaches a credential writer never keeps an inherited MERCURY_CONFIG_DIR (the 2026-09-07 shape); assign a scratch home unconditionally`)
  if (f.importBeforePin !== null) failures.push(`${path}: the scratch home is pinned at line ${f.pin}, after the product import at line ${f.importBeforePin}; pin it first`)
  if (f.pin !== null && f.staticImport !== null) found.staticBeforePin.add(path)
  if (f.pin === null && f.kept.length === 0 && !f.guarded) found.suiteHomed.add(path)
}
const ratchet = (name: string, roster: Set<string>, seen: Set<string>, remedy: string): void => {
  for (const path of seen) if (!roster.has(path)) failures.push(`${path}: ${remedy} (${name} names the proofs that stood when the census was written; the list only shrinks)`)
  for (const path of roster) if (!seen.has(path)) failures.push(`${path}: no longer in the ${name} list's shape; remove it from the list`)
}
ratchet('KEPT_HOME_WITHOUT_CREDENTIALS', KEPT_HOME_WITHOUT_CREDENTIALS, found.keptWithoutCredentials, 'a proof never keeps an inherited MERCURY_CONFIG_DIR; assign a scratch home unconditionally')
ratchet('STATIC_IMPORT_BEFORE_PIN', STATIC_IMPORT_BEFORE_PIN, found.staticBeforePin, 'a credential-writing proof pins its scratch home before any product import (a static import evaluates first: pin from a kit imported ahead of the product, or import the product dynamically after the pin)')
ratchet('SUITE_HOMED_WRITERS', SUITE_HOMED_WRITERS, found.suiteHomed, 'a credential-writing proof pins a scratch home of its own before importing the product, or calls the login-driver guard first')
for (const path of Object.keys(ACCOUNT_HOME_ON_PURPOSE)) if (!proofs.includes(path) || !homeFacts(read(path), path).pinNamesAccountHome) failures.push(`${path}: listed in ACCOUNT_HOME_ON_PURPOSE but no longer pins the account home; remove it from the list`)

if (process.argv.includes('--list')) {
  for (const [name, set] of Object.entries(found)) console.log(`${name}:\n${[...set].sort().map(p => `  '${p}',`).join('\n')}`)
  process.exit(0)
}
assert.ok(proofs.length > 3000 && credentialProofs > 100, `the census saw ${proofs.length} proofs and ${credentialProofs} credential-writing ones`)
if (failures.length > 0) {
  for (const f of failures) console.log(`FAIL ${f}`)
  console.log(`FAIL ${failures.length} proof home discipline defect(s)`)
  process.exit(1)
}
console.log(`PASS ${credentialProofs} credential-writing proofs keep no inherited home and pin before importing the product (${found.suiteHomed.size} suite-homed, ${found.staticBeforePin.size} pin after a static import, both lists only shrink); ${found.keptWithoutCredentials.size} non-credential proofs keep a home, listed; ${proofs.length} proofs walked`)
