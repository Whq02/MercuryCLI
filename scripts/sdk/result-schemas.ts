import ts from 'typescript'
import { join } from 'node:path'

type Schema = Record<string, any>
export async function resultSchemas(root: string): Promise<Record<string, Schema>> {
  const { sessionFactsToWire, rewindOutcomeToWire } = await import(join(root, 'src/services/engine-connector/seatWire.ts'))
  const config = ts.readConfigFile(join(root, 'tsconfig.json'), ts.sys.readFile)
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options
  const files = ['src/services/engine-connector/seatProjections.ts', 'src/daemon/protocol.ts', 'src/cli/run.ts']
  const program = ts.createProgram(files.map(file => join(root, file)), options)
  const checker = program.getTypeChecker()
  const shape = (type: ts.Type, seen = new Set<ts.Type>()): Schema => {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return {}
    if (type.isUnion()) {
      const choices = type.types.filter(t => !(t.flags & ts.TypeFlags.Undefined)).map(t => shape(t, seen))
      if (choices.length === 2 && choices.some(s => s.const === true) && choices.some(s => s.const === false)) return { type: 'boolean' }
      return choices.length === 1 ? choices[0]! : { anyOf: choices }
    }
    if (type.isStringLiteral() || type.isNumberLiteral()) return { const: type.value }
    if (type.flags & ts.TypeFlags.BooleanLiteral) return { const: checker.typeToString(type) === 'true' }
    if (type.flags & ts.TypeFlags.StringLike) return { type: 'string' }
    if (type.flags & ts.TypeFlags.NumberLike) return { type: 'number' }
    if (type.flags & ts.TypeFlags.Boolean) return { type: 'boolean' }
    if (type.flags & ts.TypeFlags.Null) return { type: 'null' }
    if (type.flags & (ts.TypeFlags.Never | ts.TypeFlags.Undefined)) return {}
    if (seen.has(type)) throw new Error(`recursive SDK result type: ${checker.typeToString(type)}`)
    const next = new Set(seen).add(type)
    if (checker.isArrayType(type)) return { type: 'array', items: shape(checker.getTypeArguments(type as ts.TypeReference)[0]!, next) }
    if (!(type.flags & ts.TypeFlags.Object)) throw new Error(`unsupported SDK result type: ${checker.typeToString(type)}`)
    const properties: Record<string, Schema> = {}
    const required: string[] = []
    for (const prop of type.getProperties()) {
      const field = checker.getTypeOfSymbol(prop)
      if (field.flags & ts.TypeFlags.Undefined) continue
      properties[prop.name] = shape(field, next)
      if (!(prop.flags & ts.SymbolFlags.Optional)) required.push(prop.name)
    }
    const index = checker.getIndexTypeOfType(type, ts.IndexKind.String)
    return { type: 'object', properties, required, additionalProperties: index ? shape(index, next) : true }
  }
  const declared = (file: string, name: string): Schema => {
    const source = program.getSourceFile(join(root, file))!
    const declaration = source.statements.find(node => (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name.text === name)
    if (!declaration) throw new Error(`SDK result source missing: ${name}`)
    return shape(checker.getTypeAtLocation(declaration))
  }
  const handler = (name: string): Schema => {
    let found: ts.ArrowFunction | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text === name && ts.isArrowFunction(node.initializer)) found = node.initializer
      ts.forEachChild(node, visit)
    }
    visit(program.getSourceFile(join(root, 'src/cli/run.ts'))!)
    if (!found) throw new Error(`SDK result handler missing: ${name}`)
    const returns: Schema[] = []
    const returned = (node: ts.Node): void => {
      if (node !== found && ts.isFunctionLike(node)) return
      if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
        const result = shape(checker.getTypeAtLocation(node.expression))
        for (const prop of node.expression.properties) {
          if (!ts.isPropertyAssignment(prop)) continue
          const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined
          if (key && ts.isStringLiteral(prop.initializer)) result.properties[key] = { const: prop.initializer.text }
          if (key && [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(prop.initializer.kind)) result.properties[key] = { const: prop.initializer.kind === ts.SyntaxKind.TrueKeyword }
        }
        returns.push(result)
      }
      ts.forEachChild(node, returned)
    }
    returned(found)
    if (!returns.length) throw new Error('SDK result has no object returns: ' + name)
    return returns.length === 1 ? returns[0]! : { anyOf: returns }
  }
  const remap = (schema: Schema, encode: (value: any) => unknown): Schema => {
    const sample = (s: Schema, path: string): any => {
      if (s.anyOf) {
        const objects = s.anyOf.filter((c: Schema) => c.type === 'object')
        if (objects.length) return Object.assign({}, ...objects.map((c: Schema) => sample(c, path)))
        return sample(s.anyOf[0], path)
      }
      if (s.type === 'array') return [sample(s.items, `${path}.*`)]
      if (s.type === 'object') return { __sdk_path__: path, ...Object.fromEntries(Object.entries(s.properties ?? {}).map(([key, child]) => [key, sample(child as Schema, `${path}.${key}`)])) }
      return { __sdk_path__: path }
    }
    const paths = new Map<string, string>()
    const collect = (value: any, path: string): void => {
      if (Array.isArray(value)) { if (typeof value[0]?.__sdk_path__ === 'string') paths.set(value[0].__sdk_path__.replace(/\.\*$/, ''), path); value.forEach(item => collect(item, `${path}.*`)); return }
      if (!value || typeof value !== 'object') return
      if (typeof value.__sdk_path__ === 'string') paths.set(value.__sdk_path__, path)
      for (const [key, child] of Object.entries(value)) if (key !== '__sdk_path__') collect(child, `${path}.${key}`)
    }
    collect(encode(sample(schema, '')), '')
    const convert = (s: Schema, path: string): Schema => {
      if (s.anyOf) return { ...s, anyOf: s.anyOf.map((c: Schema) => convert(c, path)) }
      if (s.type === 'array') return { ...s, items: convert(s.items, `${path}.*`) }
      if (s.type !== 'object') return s
      const rename = (key: string): string => paths.get(`${path}.${key}`)?.split('.').at(-1) ?? key
      return { ...s, properties: Object.fromEntries(Object.entries(s.properties ?? {}).map(([key, child]) => [rename(key), convert(child as Schema, `${path}.${key}`)])), required: (s.required ?? []).map(rename) }
    }
    return convert(schema, '')
  }
  return {
    'session/facts': remap(declared(files[0]!, 'SessionFactsAnswerV1'), sessionFactsToWire),
    'session/rewind': remap(declared(files[1]!, 'SessionRewindOutcomeV1'), rewindOutcomeToWire),
    'agent/stop': handler('agent/stop'),
    'agent/resume': handler('agent/resume'),
  }
}
