#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { pinSourceRef } from '../lib/settingsPopupHarness.ts'

pinSourceRef()
const root = join(import.meta.dir, '../..')
const SURFACES = ['src/services/host', 'src/services/llmHost/index.ts', 'src/commands/llmhost', 'src/commands/host/index.ts', 'src/services/providers/openaicompat/compatRefusals.ts', 'src/services/providers/openaicompat/compatToolSchemas.ts', 'src/components/LlmHostDialog.tsx']
const HOUSE_WORDS = /\b(doors?|roads?|seats?|folds?|lanes?|ladders?|owners?|laws?|pins?|provers?)\b/i
const SCREENS = ['Machines I’m paying for', 'Bank', 'Rent a GPU', 'the model', 'A server that’s already running', 'A box I can reach by SSH', 'One of my computers']
const RETIRED_SCREENS = [/→ Fast-load\b/, /\b(open|refresh|reopen)(ing)? Fast-load\b/i, /\bFast-load (closed|shows|does not|screen)\b/]
const NEXT_STEPS = ['/llmhost', 'Machines I’m paying for', 'Bank', 'Resume', 'Terminate', 'Cancel', 'Refresh', 'try again', 'rent again', 'check your account', 'console', 'b banks', 'b resumes', 'Connect']
const FAILURE_KINDS = new Set(['failed', 'stalled'])
let checks = 0
const failures: string[] = []
const check = (name: string, truth: unknown, detail = ''): void => { checks++; if (truth) { console.log('PASS ' + name); return } failures.push(name + (detail ? '\n' + detail : '')); console.log('FAIL ' + name + (detail ? '\n' + detail : '')) }

interface Sentence { file: string; line: number; text: string }
interface NoticeSite { file: string; line: number; kind: string; text: string | undefined }

function sourceFiles(): string[] {
  const files: string[] = []
  const walk = (path: string): void => {
    if (statSync(path).isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); return }
    if (/\.tsx?$/.test(path)) files.push(path)
  }
  for (const surface of SURFACES) walk(join(root, surface))
  return files.sort()
}

function isSentence(text: string): boolean {
  return /\s/.test(text.trim()) && /[A-Za-z]/.test(text) && !/^\s*https?:\/\//.test(text)
}

function literalFragments(node: ts.Node | undefined, scope: ts.Node | undefined, depth = 0): string[] | undefined {
  if (!node || depth > 8) return undefined
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return literalFragments(node.expression, scope, depth)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.flatMap(span => [...(literalFragments(span.expression, scope, depth + 1) ?? []), span.literal.text])]
  if (ts.isBinaryExpression(node)) {
    const left = literalFragments(node.left, scope, depth + 1) ?? []
    const right = literalFragments(node.right, scope, depth + 1) ?? []
    return left.length || right.length ? [...left, ...right] : undefined
  }
  if (ts.isConditionalExpression(node)) {
    const yes = literalFragments(node.whenTrue, scope, depth + 1) ?? []
    const no = literalFragments(node.whenFalse, scope, depth + 1) ?? []
    return yes.length || no.length ? [...yes, ...no] : undefined
  }
  if (ts.isIdentifier(node) && scope) {
    const declaration = findDeclaration(node.text, scope)
    if (declaration?.initializer) return literalFragments(declaration.initializer, scope, depth + 1)
    return undefined
  }
  if (ts.isCallExpression(node) && scope) {
    const callee = ts.isIdentifier(node.expression) ? findDeclaration(node.expression.text, scope)?.initializer : undefined
    const body = callee && ts.isArrowFunction(callee) ? (ts.isBlock(callee.body) ? returnedExpressions(callee.body).flatMap(expression => literalFragments(expression, scope, depth + 1) ?? []) : literalFragments(callee.body, scope, depth + 1) ?? []) : []
    const args = node.arguments.flatMap(argument => literalFragments(argument, scope, depth + 1) ?? [])
    return body.length || args.length ? [...body, ...args] : undefined
  }
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return literalFragments(node.body, scope, depth + 1)
  return undefined
}

function returnedExpressions(block: ts.Block): ts.Expression[] {
  const found: ts.Expression[] = []
  const visit = (node: ts.Node): void => { if (ts.isReturnStatement(node) && node.expression) found.push(node.expression); if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit) }
  ts.forEachChild(block, visit)
  return found
}

function findDeclaration(name: string, from: ts.Node): ts.VariableDeclaration | undefined {
  for (let scope: ts.Node | undefined = from; scope; scope = scope.parent) {
    const statements = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope) || ts.isModuleBlock(scope) ? scope.statements : undefined
    if (!statements) continue
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration
    }
  }
  return undefined
}

function census(files: string[]): { sentences: Sentence[]; notices: NoticeSite[] } {
  const sentences: Sentence[] = []
  const notices: NoticeSite[] = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const at = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const name = relative(root, file)
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) { if (isSentence(node.text)) sentences.push({ file: name, line: at(node), text: node.text }) }
      else if (ts.isTemplateExpression(node)) { for (const chunk of [node.head, ...node.templateSpans.map(span => span.literal)]) if (isSentence(chunk.text)) sentences.push({ file: name, line: at(chunk), text: chunk.text }) }
      else if (ts.isJsxText(node)) { if (isSentence(node.text)) sentences.push({ file: name, line: at(node), text: node.text }) }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'hostNotice' && node.arguments.length >= 3) {
        const kind = node.arguments[1]!
        const kindText = ts.isStringLiteral(kind) ? kind.text : '?'
        const fragments = literalFragments(node.arguments[2], node)
        notices.push({ file: name, line: at(node), kind: kindText, text: fragments?.join('') })
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { sentences, notices }
}

const houseWordBreaks = (sentences: Sentence[]): Sentence[] => sentences.filter(row => HOUSE_WORDS.test(row.text))
const deadScreenBreaks = (sentences: Sentence[]): Sentence[] => sentences.filter(row => {
  if (RETIRED_SCREENS.some(pattern => pattern.test(row.text))) return true
  for (const match of row.text.matchAll(/\/llmhost → ([^·;.]+)/g)) if (!SCREENS.some(screen => match[1]!.startsWith(screen))) return true
  return false
})
const nextStepBreaks = (notices: NoticeSite[]): NoticeSite[] => notices.filter(row => FAILURE_KINDS.has(row.kind) && (row.text === undefined || !NEXT_STEPS.some(step => row.text!.includes(step))))
const describe = (rows: { file: string; line: number; text?: string; kind?: string }[]): string => rows.map(row => '  ' + row.file + ':' + row.line + (row.kind ? ' [' + row.kind + ']' : '') + ' ' + JSON.stringify((row.text ?? '<unresolved>').slice(0, 140))).join('\n')

const files = sourceFiles()
const { sentences, notices } = census(files)
check('the census reads every surface and finds the sentences and the failure notices', files.length >= 30 && sentences.length >= 400 && notices.filter(row => FAILURE_KINDS.has(row.kind)).length >= 12, files.length + ' files · ' + sentences.length + ' sentences · ' + notices.length + ' notice sites')
const house = houseWordBreaks(sentences)
check('§1 no sentence on the host surfaces carries a house word', house.length === 0, describe(house))
const dead = deadScreenBreaks(sentences)
check('§2 every /llmhost pointer names a live screen and no sentence sends the user to the retired Fast-load screen', dead.length === 0, describe(dead))
const silent = nextStepBreaks(notices)
check('§3 every failed/stalled host notice names a next step the user can take', silent.length === 0, describe(silent))

const wordsFile = join(root, 'src/commands/llmhost/words.ts')
const wordsSource = ts.createSourceFile(wordsFile, readFileSync(wordsFile, 'utf8'), ts.ScriptTarget.Latest, true)
const wordKeys: string[] = []
const findWords = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'LLM_HOST_WORDS' && node.initializer) {
    const object = ts.isAsExpression(node.initializer) ? node.initializer.expression : node.initializer
    if (ts.isObjectLiteralExpression(object)) for (const property of object.properties) if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) wordKeys.push(property.name.text)
  }
  ts.forEachChild(node, findWords)
}
findWords(wordsSource)
const srcFiles: string[] = []
const walkSrc = (path: string): void => { if (statSync(path).isDirectory()) { for (const name of readdirSync(path)) walkSrc(join(path, name)) } else if (/\.tsx?$/.test(path)) srcFiles.push(path) }
walkSrc(join(root, 'src'))
const corpus = srcFiles.filter(file => file !== wordsFile).map(file => readFileSync(file, 'utf8')).join('\n')
const deadKeys = wordKeys.filter(key => !new RegExp('\\b(words|LLM_HOST_WORDS)\\.' + key + '\\b|LLM_HOST_WORDS\\[\'' + key + '\'\\]').test(corpus))
check('§4 every LLM_HOST_WORDS entry is read somewhere outside words.ts (' + wordKeys.length + ' keys)', wordKeys.length >= 60 && deadKeys.length === 0, 'dead: ' + deadKeys.join(', '))
const refusalsFile = join(root, 'src/services/providers/openaicompat/compatRefusals.ts')
const refusalExports = [...readFileSync(refusalsFile, 'utf8').matchAll(/^export (?:function|const) (\w+)/gm)].map(match => match[1]!)
const deadExports = refusalExports.filter(name => !srcFiles.some(file => file !== refusalsFile && new RegExp('\\b' + name + '\\b').test(readFileSync(file, 'utf8'))))
check('§4 every compatRefusals.ts export is used by a product file (' + refusalExports.length + ' exports)', refusalExports.length >= 2 && deadExports.length === 0, 'dead: ' + deadExports.join(', '))

const synthetic = (body: string): { sentences: Sentence[]; notices: NoticeSite[] } => {
  const source = ts.createSourceFile('planted.ts', body, ts.ScriptTarget.Latest, true)
  const sentencesFound: Sentence[] = []
  const noticesFound: NoticeSite[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && isSentence(node.text)) sentencesFound.push({ file: 'planted.ts', line: 1, text: node.text })
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'hostNotice' && node.arguments.length >= 3) {
      const kind = node.arguments[1]!
      noticesFound.push({ file: 'planted.ts', line: 1, kind: ts.isStringLiteral(kind) ? kind.text : '?', text: literalFragments(node.arguments[2], node)?.join('') })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { sentences: sentencesFound, notices: noticesFound }
}
const plantedHouse = synthetic("const a = 'Choose a road. No GPU is rented.'; const b = 'The weights are pinned by revision.'")
check('§5 a planted house word is caught and a pinned (not pin) sentence passes', houseWordBreaks(plantedHouse.sentences).map(row => row.text).join('|') === 'Choose a road. No GPU is rented.')
const plantedScreen = synthetic("const a = 'open Fast-load before renting'; const b = '/llmhost → Fast-load to delete it'; const c = 'mirrored to a fast-load volume'; const d = '/llmhost → Bank → d deletes the disk'; const e = '/llmhost → Settings → keys'")
check('§5 a retired screen and an unknown screen are caught; the volume term and a live screen pass', deadScreenBreaks(plantedScreen.sentences).map(row => row.text).join('|') === 'open Fast-load before renting|/llmhost → Fast-load to delete it|/llmhost → Settings → keys')
const plantedNotice = synthetic(`function run(record: any, error: unknown) {
  const words = record.name + ' · banking failed: ' + String(error) + ' · b resumes'
  const bankWords = (detail: string): string => record.name + ' · ' + detail + ' · /llmhost → Bank to try again'
  hostNotice(record, 'failed', words)
  hostNotice(record, 'failed', bankWords('could not start'))
  hostNotice(record, 'failed', record.name + ' · the process ended')
  hostNotice(record, 'stalled', detailFromElsewhere)
  hostNotice(record, 'ended', 'watch ended · no pod was created')
}`)
check('§5 a failed notice without a next step and an unresolvable one are caught; resolved consts, helpers and non-failure kinds pass', nextStepBreaks(plantedNotice.notices).map(row => row.text ?? '<unresolved>').join('|') === ' · the process ended|<unresolved>')

assert.equal(failures.length, 0, failures.length + ' of ' + checks + ' checks failed:\n' + failures.join('\n'))
console.log('HOST WORDS TRUTH GREEN · ' + checks + ' checks · ' + files.length + ' files · ' + sentences.length + ' sentences · ' + notices.length + ' notice sites · static census, nothing rented')
