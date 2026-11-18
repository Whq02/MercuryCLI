import { readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import ts from 'typescript'

export type Kind = 'static' | 'lazy' | 'type'
export type Edge = { from: string; to: string; kind: Kind; line: number; names: string[]; leaves: boolean }
export type Unread = { file: string; line: number; text: string }
type Reading = {
  files: string[]
  known: Set<string>
  tsconfig: ReturnType<typeof ts.readConfigFile>
  aliases: Array<[string, string[]]>
  edges: Edge[]
  unread: Unread[]
  passedOn: Set<string>
}

const SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

function bare(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) current = current.expression
  return current
}

const typeOnlyClause = (clause: ts.ImportClause): boolean =>
  clause.isTypeOnly === true || (clause as { phaseModifier?: ts.SyntaxKind }).phaseModifier === ts.SyntaxKind.TypeKeyword

function importKind(node: ts.ImportDeclaration): Kind {
  const clause = node.importClause
  if (!clause) return 'static'
  if (typeOnlyClause(clause)) return 'type'
  const bindings = clause.namedBindings
  if (clause.name || !bindings || ts.isNamespaceImport(bindings)) return 'static'
  return bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly) ? 'type' : 'static'
}

function importedNames(clause: ts.ImportClause | undefined): string[] {
  const bindings = clause?.namedBindings
  if (!clause || (bindings && ts.isNamespaceImport(bindings))) return []
  return [...(clause.name ? ['default'] : []), ...(bindings ? bindings.elements.map(element => (element.propertyName ?? element.name).text) : [])]
}

function exportKind(node: ts.ExportDeclaration): Kind {
  if (node.isTypeOnly) return 'type'
  const clause = node.exportClause
  return clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every(element => element.isTypeOnly) ? 'type' : 'static'
}

export function readImports(root: string): Reading {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`)
      else if (entry.isFile() && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name)) files.push(`${dir}/${entry.name}`)
    }
  }
  walk('src')
  files.sort()
  const known = new Set(files)

  const tsconfig = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile)
  const aliases = Object.entries(((tsconfig.config as { compilerOptions?: { paths?: Record<string, string[]> } } | undefined)?.compilerOptions?.paths ?? {}))

  function aliased(spec: string): string[] {
    const out: string[] = []
    for (const [pattern, targets] of aliases) {
      const star = pattern.indexOf('*')
      const head = star < 0 ? pattern : pattern.slice(0, star)
      const tail = star < 0 ? '' : pattern.slice(star + 1)
      if (star < 0 ? spec !== pattern : spec.length < head.length + tail.length || !spec.startsWith(head) || !spec.endsWith(tail)) continue
      const middle = star < 0 ? '' : spec.slice(head.length, spec.length - tail.length)
      for (const target of targets) out.push(posix.normalize(target.replace('*', middle)))
    }
    return out
  }

  function resolveSpec(from: string, spec: string): string | null {
    const bases = spec.startsWith('.') ? [posix.join(posix.dirname(from), spec)] : spec.startsWith('src/') ? [spec] : aliased(spec)
    for (const base of bases) {
      const tries = [
        base,
        base.replace(/\.jsx?$/, '.ts'),
        base.replace(/\.jsx?$/, '.tsx'),
        base.replace(/\.mjs$/, '.mts'),
        base.replace(/\.cjs$/, '.cts'),
        ...SUFFIXES.map(suffix => base + suffix),
        ...SUFFIXES.map(suffix => `${base}/index${suffix}`),
      ]
      const hit = tries.find(candidate => known.has(candidate))
      if (hit !== undefined) return hit
    }
    return null
  }

  const unread: Unread[] = []
  const passedOn = new Set<string>()

  function importsOf(file: string): Edge[] {
    const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
    const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.ESNext, false, kind)
    const out: Edge[] = []
    const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
    const add = (spec: string, edgeKind: Kind, node: ts.Node, names: string[] = [], leaves = false): void => {
      const to = resolveSpec(file, spec)
      if (to !== null) out.push({ from: file, to, kind: edgeKind, line: lineOf(node), names, leaves })
    }
    const makers = new Set(['createRequire'])
    for (const statement of source.statements) {
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === 'createRequire') makers.add(element.name.text)
    }
    const makesRequire = (expression: ts.Expression): boolean => {
      const call = bare(expression)
      if (!ts.isCallExpression(call)) return false
      const callee = bare(call.expression)
      return ts.isIdentifier(callee) ? makers.has(callee.text) : ts.isPropertyAccessExpression(callee) && callee.name.text === 'createRequire'
    }
    const calledInPlace = new Set<ts.Node>()
    const visit = (node: ts.Node, enclosed: boolean, requires: ReadonlySet<string>): void => {
      let inner = enclosed
      let scope = requires
      if (ts.isFunctionLike(node) ? !calledInPlace.has(node) : ts.isPropertyDeclaration(node) && !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) inner = true
      if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseOrDefaultClause(node)) {
        const bound: string[] = []
        for (const statement of node.statements) {
          if (!ts.isVariableStatement(statement)) continue
          for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer && makesRequire(declaration.initializer)) bound.push(declaration.name.text)
        }
        if (bound.length > 0) scope = new Set([...requires, ...bound])
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier.text, importKind(node), node, importedNames(node.importClause))
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const clause = node.exportClause
        add(node.moduleSpecifier.text, exportKind(node), node, clause && ts.isNamedExports(clause) ? clause.elements.map(element => (element.propertyName ?? element.name).text) : [], true)
      } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) passedOn.add(`${file}\t${(element.propertyName ?? element.name).text}`)
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
        add(node.moduleReference.expression.text, node.isTypeOnly ? 'type' : 'static', node)
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) add(node.argument.literal.text, 'type', node)
      else if (ts.isCallExpression(node)) {
        const callee = bare(node.expression)
        if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) calledInPlace.add(callee)
        const first = node.arguments[0]
        if (first && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && requires.has(callee.text)) || makesRequire(callee))) {
          const specifier = bare(first)
          if (ts.isStringLiteralLike(specifier)) add(specifier.text, enclosed ? 'lazy' : 'static', node)
          else unread.push({ file, line: lineOf(node), text: node.getText(source).replace(/\s+/g, ' ').slice(0, 80) })
        }
      }
      ts.forEachChild(node, child => visit(child, inner, scope))
    }
    visit(source, false, new Set(['require']))
    return out
  }

  const edges = files.flatMap(importsOf)
  return { files, known, tsconfig, aliases, edges, unread, passedOn }
}

export function staticPairs(edges: Edge[]): Array<[string, string]> {
  return [...new Set(edges.filter(edge => edge.kind === 'static' && edge.from !== edge.to).map(edge => `${edge.from}\t${edge.to}`))].map(pair => pair.split('\t') as [string, string])
}

export function largestCycle(files: string[], pairs: Array<[string, string]>): Set<string> {
  const next = new Map<string, string[]>(files.map(file => [file, []]))
  for (const [from, to] of pairs) next.get(from)!.push(to)
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  let counter = 0
  let best: string[] = []
  for (const root of files) {
    if (index.has(root)) continue
    const work: Array<[string, number]> = [[root, 0]]
    index.set(root, counter)
    low.set(root, counter)
    counter++
    stack.push(root)
    onStack.add(root)
    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const node = frame[0]
      const targets = next.get(node)!
      if (frame[1] < targets.length) {
        const target = targets[frame[1]++]!
        if (!index.has(target)) {
          index.set(target, counter)
          low.set(target, counter)
          counter++
          stack.push(target)
          onStack.add(target)
          work.push([target, 0])
        } else if (onStack.has(target)) low.set(node, Math.min(low.get(node)!, index.get(target)!))
      } else {
        if (low.get(node) === index.get(node)) {
          const component: string[] = []
          let member: string
          do {
            member = stack.pop()!
            onStack.delete(member)
            component.push(member)
          } while (member !== node)
          if (component.length > best.length) best = component
        }
        work.pop()
        if (work.length > 0) {
          const parent = work[work.length - 1]![0]
          low.set(parent, Math.min(low.get(parent)!, low.get(node)!))
        }
      }
    }
  }
  return new Set(best.length > 1 ? best : [])
}
