#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { proofHome } from '../lib/hermetic.ts'
import { strict as assert } from 'node:assert'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const root = join(import.meta.dir, '..', '..')
const rename = (s: string): string => s.replace(/DEEPSEEK/g, 'XAI').replace(/Deepseek|DeepSeek/g, 'Xai').replace(/deepseek/g, 'xai')
function exportsOf(path: string): Map<string, string> {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const out = new Map<string, string>()
  for (const statement of source.statements) {
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      const params = statement.parameters.map(p => [p.questionToken ? '?' : '', p.type?.getText(source) ?? '', p.initializer ? '=' : ''].join('')).join(',')
      out.set(statement.name.text, `(${params}):${statement.type?.getText(source) ?? ''}`.replace(/[\s;]/g, ''))
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) out.set(declaration.name.getText(source), declaration.type?.getText(source).replace(/[\s;]/g, '') ?? 'inferred')
    } else if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) out.set(statement.name.text, 'type')
  }
  return out
}
let count = 0
try {
  const pairs = ['CallModel', 'Catalogue', 'Login', 'Pins'].map(part => [`src/services/providers/deepseek/deepseek${part}.ts`, `src/services/providers/xai/xai${part}.ts`])
  pairs.push(['src/utils/router/providers/deepseek.ts', 'src/utils/router/providers/xai.ts'])
  for (const [from, to] of pairs) {
    const expected = exportsOf(join(root, from!))
    const actual = exportsOf(join(root, to!))
    for (const [name, signature] of expected) {
      assert.equal(actual.get(rename(name)), rename(signature), `${to}: ${rename(name)} preserves the mirrored signature`)
      count++
    }
    console.log(`[PASS] ${to}: all ${expected.size} mirrored exports and function signatures`)
  }
  const flags = readFileSync(join(root, 'src/substrate/flagRegistry.ts'), 'utf8')
  const shard = readFileSync(join(root, 'scripts/gate/ci-shard.sh'), 'utf8')
  assert.ok(flags.includes("env: 'MERCURY_XAI_API_BASE'"))
  assert.ok(shard.includes('MERCURY_DEEPSEEK_API_BASE MERCURY_XAI_API_BASE MERCURY_XAI_MANAGEMENT_API_BASE'))
  assert.ok(flags.includes("env: 'MERCURY_XAI_MANAGEMENT_API_BASE'"))
  const accounts = exportsOf(join(root, 'src/services/providers/xai/xaiAccounts.ts'))
  for (const name of ['resolveXaiApiKey', 'resolveXaiManagementApiKey', 'xaiApiBase', 'xaiManagementBase', 'resolveXaiAccount']) assert.ok(accounts.has(name), name)
  const usage = exportsOf(join(root, 'src/services/providers/xai/xaiUsageState.ts'))
  for (const name of ['fetchXaiUsage', 'refreshXaiUsage', 'xaiObservedUsage', 'decodeXaiPrepaidBalance', 'decodeXaiUsageSeries']) assert.ok(usage.has(name), name)
  console.log('[PASS] xAI has its own inference and management usage contracts, not DeepSeek balance aliases')
  console.log('[PASS] the xAI base joins the registered hermetic dead-letter census')
  console.log(`XAI CONTRACT GREEN (${count} mirrored exports; base census included)`)
} finally { rmSync(proofHome, { recursive: true, force: true }) }
