import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

export function copyDistChunks(source: string, target: string): void {
  mkdirSync(target, { recursive: true })
  const chunks = readdirSync(source).filter(name => name.endsWith('.mjs'))
  for (const name of chunks) copyFileSync(join(source, name), join(target, name))
  for (const name of chunks) {
    const tree = ts.createSourceFile(name, readFileSync(join(target, name), 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && /^\.\/[^/\\]+\.mjs$/.test(node.text) && !existsSync(join(target, node.text))) throw new Error(`Fixture chunk ${name} references missing sibling ${node.text}`)
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
}
