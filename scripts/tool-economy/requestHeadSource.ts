import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')
export const FORBIDDEN_HEAD_WORDS = ['<available-deferred-tools>', '</available-deferred-tools>']
export const FORBIDDEN_PROVIDER_WORDS = ['announcement', 'nameRowBytes', ...FORBIDDEN_HEAD_WORDS]

export function requestHeadSource(route: string): string {
  const owner = route === 'anthropic' ? 'anthropic/streamCore' : route === 'openai' ? 'openai/openaiCallModel' : route === 'zai' ? 'zai/zaiCallModel' : 'openaicompat/compatChatCallModel'
  return readFileSync(join(ROOT, 'src/services/providers', `${owner}.ts`), 'utf8')
}

export function requestHeadIsPlain(route: string, source = requestHeadSource(route)): boolean {
  const tree = ts.createSourceFile('request.ts', source, ts.ScriptTarget.Latest, true)
  const variable = route === 'anthropic' ? 'messagesForAPI' : 'wireMessages'
  let initializer = ''
  let minted = false
  const compact = (node: ts.Node): string => node.getText(tree).replace(/\s+/g, '')
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === variable && node.initializer) initializer = compact(node.initializer)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.left.text === variable && ts.isArrayLiteralExpression(node.right)) minted = true
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === variable && ['push', 'unshift', 'splice'].includes(node.expression.name.text)) minted = true
    ts.forEachChild(node, visit)
  }
  visit(tree)
  const expected = route === 'anthropic' ? 'normalizeMessagesForAPI(messages,filteredTools)' : route === 'openai' ? 'renderAdmissionRecordsAsText(projectedMessages)' : 'renderAdmissionRecordsAsText(messages,plan.wireForm)'
  return initializer === expected && !minted
}
