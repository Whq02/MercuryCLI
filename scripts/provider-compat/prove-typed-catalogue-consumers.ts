#!/usr/bin/env bun
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const rootAt = process.argv.indexOf('--root')
const ROOT = resolve(rootAt < 0 ? join(import.meta.dir, '../..') : process.argv[rootAt + 1]!)
const SRC = join(ROOT, 'src')
const tables = ['GLM_STATIC_CATALOGUE', 'KIMI_DISPLAY_PINS', 'GPT_DISPLAY_PINS'] as const
const ownerAt = process.argv.indexOf('--openai-owner')
const openaiOwner = ownerAt < 0 ? 'OpenAI chooser follow-up' : process.argv[ownerAt + 1]
let failures = 0
let consumers = 0
const check = (label: string, ok: boolean): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [])
}
function functionOwner(node: ts.Node): ts.FunctionDeclaration | ts.VariableDeclaration | undefined {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isFunctionDeclaration(at)) return at
    if (ts.isVariableDeclaration(at) && at.initializer && (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))) return at
  }
  return undefined
}
function classification(file: string, table: string, owner: string, body: string): string | undefined {
  if (table === 'KIMI_DISPLAY_PINS') {
    if (file === 'src/services/providers/moonshot/kimiPins.ts' && owner === 'kimiDisplayPin' && /KIMI_DISPLAY_PINS\.find\(/.test(body)) return 'display/price metadata by id'
    if (file === 'src/commands/caching/caching.tsx' && owner === 'familyRows' && body.includes('pinnedCacheHitLines(KIMI_DISPLAY_PINS)')) return 'price display'
    if (file === 'src/services/providers/moonshot/moonshotCatalogue.ts' && owner === 'moonshotCatalogueRows' && body.includes('getCachedMoonshotCatalogue(env)') && body.includes('snapshot.fetchedAtMs === 0')) return 'dated fallback behind the live snapshot'
    return undefined
  }
  if (table === 'GLM_STATIC_CATALOGUE') {
    const permitted: Record<string, string[]> = {
      'src/utils/router/providers/zai.ts': ['describeZaiProvider', 'listZaiModels'],
      'src/utils/swarm/engineDispatch.ts': ['engineDispatchModelsForSchema', 'resolveEngineDispatch'],
      'src/utils/model/modelOptions.ts': ['keyLanePins'],
      'src/utils/model/capabilities.ts': ['resolveContextWindow'],
    }
    return permitted[file]?.includes(owner) ? 'dated Z.AI observation; no documented models endpoint' : undefined
  }
  if (file === 'src/services/providers/openai/gptPins.ts' && owner === 'gptDisplayPin') return 'display/price metadata by id'
  if (file === 'src/utils/model/providerFrontier.ts' && ['providerFrontierFact', 'providerLightFact', 'providerSmallFastFact'].includes(owner)) return `existing OpenAI chooser obligation: ${openaiOwner}`
  if (file === 'src/utils/router/providers/openai.ts' && owner === 'staticPinCatalogue') return 'display projection; admission reads the live catalogue'
  if (file === 'src/utils/swarm/engineDispatch.ts' && owner === 'engineDispatchModelsForSchema') return 'schema advertisement; dispatch revalidates live'
  if (file === 'src/utils/swarm/engineDispatch.ts' && owner === 'resolveGptExactModel' && body.includes('await refreshOpenaiCatalogue') && body.includes('evaluateGptCandidate')) return 'exact-id fallback behind live admission'
  if (file === 'src/utils/model/modelOptions.ts' && owner === 'getQualifiedGptOptions' && body.includes('getGptSeatAvailability') && body.includes('evaluateGptCandidate')) return 'unavailable display rows behind live qualification'
  if (file === 'src/services/concourse/coordinatorModels.ts' && owner === 'composeCoordinatorModelRegistry') return `existing OpenAI chooser obligation: ${openaiOwner}`
  return undefined
}
for (const table of tables) check(`${table}: a new unclassified chooser is refused`, classification('src/utils/model/newChooser.ts', table, 'choose', `return ${table}[0]`) === undefined)
check('the known Moonshot fallback owner cannot drop its live check', classification('src/services/providers/moonshot/moonshotCatalogue.ts', 'KIMI_DISPLAY_PINS', 'moonshotCatalogueRows', 'return KIMI_DISPLAY_PINS') === undefined)
for (const path of files(SRC)) {
  const source = readFileSync(path, 'utf8')
  if (!tables.some(table => source.includes(table))) continue
  const file = relative(ROOT, path).replaceAll('\\', '/')
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const names = new Map<string, string>(tables.map(table => [table, table]))
  const aliases = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && names.has((node.propertyName ?? node.name).text)) names.set(node.name.text, names.get((node.propertyName ?? node.name).text)!)
    if (ts.isBindingElement(node) && node.propertyName && ts.isIdentifier(node.propertyName) && names.has(node.propertyName.text) && ts.isIdentifier(node.name)) names.set(node.name.text, names.get(node.propertyName.text)!)
    ts.forEachChild(node, aliases)
  }
  aliases(ast)
  const seen = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      const parent = node.parent
      let excluded = ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isBindingElement(parent) || (ts.isVariableDeclaration(parent) && parent.name === node)
      for (let at: ts.Node | undefined = parent; at && at !== ast; at = at.parent) if (ts.isTypeNode(at)) excluded = true
      if (!excluded) {
        const owner = functionOwner(node)
        const name = owner?.name?.getText(ast) ?? '<module>'
        const table = names.get(node.text)!
        const key = `${table}:${name}`
        if (!seen.has(key)) {
          seen.add(key)
          consumers++
          const kind = classification(file, table, name, owner?.getText(ast) ?? source)
          const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
          check(`${file}:${line} ${name} reads ${table} — ${kind ?? 'unclassified typed-table authority'}`, kind !== undefined)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}
const options = readFileSync(join(SRC, 'utils/model/modelOptions.ts'), 'utf8')
const dispatch = readFileSync(join(SRC, 'utils/swarm/engineDispatch.ts'), 'utf8')
const adapter = readFileSync(join(SRC, 'utils/router/providers/moonshot.ts'), 'utf8')
check('Moonshot picker reads the live-backed row owner', options.includes('moonshotCatalogueRows().rows') && !options.includes('KIMI_DISPLAY_PINS'))
check('Moonshot specialist choice and exact admission read the catalogue, never a parallel static projection', dispatch.includes('moonshotCatalogueEntries()') && dispatch.includes('qualifyMoonshotModel(') && !dispatch.includes('KIMI_STATIC_CATALOGUE'))
check('the Moonshot adapter does not rebuild a chooser from typed pins', adapter.includes('moonshotCatalogueRows()') && !adapter.includes('KIMI_DISPLAY_PINS'))
check('the census actually found consumers', consumers > 0)
console.log(`${consumers} consumers, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
