
interface TransformedCell {
  code: string
  persistedNames: string[]
  capturesResult: boolean
}

function createJsCellTransformer() {
const LEADING_TRIVIA = /^(?:\s+|\/\/[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)*/
const DECL_KEYWORD = /^(const|let|var)\b/
const FUNC_DECL = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
const CLASS_DECL = /^class\s+([A-Za-z_$][\w$]*)/
const IMPORT_FROM = /^import\s+([\s\S]+?)\s+from\s*(['"])([^'"\n]+)\2\s*;?$/
const IMPORT_BARE = /^import\s*(['"])([^'"\n]+)\1\s*;?$/
const BLOCK_FOLLOWER = /^[ \t]*(?:var|let|const|function|async[ \t]+function|class|import|export)\b/
const STATEMENT_KEYWORD =
  /^(?:const|let|var|function|class|if|for|while|do|switch|try|throw|return|break|continue|import|export|async\s+function|debugger)\b/
const REGEX_LEAD_KEYWORD = /^(?:return|throw|case|yield|await|typeof|void|delete|in|of)$/

function regexCanStart(source: string, at: number): boolean {
  let k = at - 1
  while (k >= 0 && /\s/.test(source[k]!)) k--
  if (k < 0) return true
  const prev = source[k]!
  if ((prev === '+' || prev === '-') && source[k - 1] === prev) return false
  if ('=(:,!&|?;[{}+-*%^~<>'.includes(prev)) return true
  if (!/[\w$]/.test(prev)) return false
  let start = k
  while (start > 0 && /[\w$]/.test(source[start - 1]!)) start--
  return REGEX_LEAD_KEYWORD.test(source.slice(start, k + 1))
}

interface Segment {
  text: string
}

function splitTopLevelSegments(source: string): Segment[] {
  const segments: Segment[] = []
  let start = 0
  for (const i of topLevelCodePositions(source)) {
    const c = source[i]!
    if (c === ';' || c === '\n' || c === '}' && BLOCK_FOLLOWER.test(source.slice(i + 1, i + 41))) {
      segments.push({ text: source.slice(start, i + 1) })
      start = i + 1
    }
  }
  if (start < source.length) segments.push({ text: source.slice(start) })
  return segments
}

function topLevelCodePositions(source: string): Generator<number> {
  return codePositions(source, false)
}

function* codePositions(source: string, everyDepth: boolean): Generator<number> {
  let depth = 0
  let i = 0
  const n = source.length
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template' | 'regex'
  let mode: Mode = 'code'
  let regexClass = false
  const templateDepths: number[] = []
  while (i < n) {
    const c = source[i]!
    const next = i + 1 < n ? source[i + 1]! : ''
    switch (mode) {
      case 'line':
        if (c === '\n') {
          mode = 'code'
          if (depth === 0) yield i
        }
        i++
        continue
      case 'regex':
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === '[') regexClass = true
        if (c === ']') regexClass = false
        if (c === '/' && !regexClass || c === '\n') mode = 'code'
        i++
        continue
      case 'block':
        if (c === '*' && next === '/') {
          mode = 'code'
          i += 2
          continue
        }
        i++
        continue
      case 'single':
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === "'" || c === '\n') mode = 'code'
        i++
        continue
      case 'double':
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === '"' || c === '\n') mode = 'code'
        i++
        continue
      case 'template':
        if (c === '\\') {
          i += 2
          continue
        }
        if (c === '`') {
          mode = 'code'
          i++
          continue
        }
        if (c === '$' && next === '{') {
          templateDepths.push(depth)
          depth++
          mode = 'code'
          i += 2
          continue
        }
        i++
        continue
      case 'code':
        break
    }
    if (c === '/' && next === '/') {
      mode = 'line'
      i += 2
      continue
    }
    if (c === '/' && next === '*') {
      mode = 'block'
      i += 2
      continue
    }
    if (c === '/' && regexCanStart(source, i)) {
      mode = 'regex'
      regexClass = false
      i++
      continue
    }
    if (c === "'") {
      mode = 'single'
      i++
      continue
    }
    if (c === '"') {
      mode = 'double'
      i++
      continue
    }
    if (c === '`') {
      mode = 'template'
      i++
      continue
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++
      if (everyDepth) yield i
      i++
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1)
      if (
        c === '}' &&
        templateDepths.length > 0 &&
        depth === templateDepths[templateDepths.length - 1]
      ) {
        templateDepths.pop()
        mode = 'template'
        i++
        continue
      }
      if (everyDepth || depth === 0) yield i
      i++
      continue
    }
    if (everyDepth || depth === 0) yield i
    i++
  }
}

function patternNames(region: string): string[] {
  const names: string[] = []
  const code = new Set(codePositions(region, true))
  let depth = 0
  let defaultDepth: number | null = null
  for (let i = 0; i < region.length; i++) {
    if (!code.has(i)) continue
    const c = region[i]!
    if (c === '(' || c === '[' || c === '{') {
      depth++
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      depth--
      if (defaultDepth !== null && depth < defaultDepth) defaultDepth = null
      continue
    }
    if (defaultDepth !== null) {
      if (c === ',' && depth === defaultDepth) defaultDepth = null
      continue
    }
    if (c === '=') {
      defaultDepth = depth
      continue
    }
    if (!/[A-Za-z_$]/.test(c)) continue
    let end = i + 1
    while (end < region.length && /[\w$]/.test(region[end]!)) end++
    const name = region.slice(i, end)
    i = end - 1
    if (name === 'const' || name === 'let' || name === 'var') continue
    if (/^\s*:/.test(region.slice(end))) continue
    names.push(name)
  }
  return names
}

function declarationNames(statement: string): string[] {
  const body = statement.replace(DECL_KEYWORD, '')
  const names: string[] = []
  let start = 0
  const flush = (end: number): void => {
    const current = body.slice(start, end)
    const eq = findTopLevelAssign(current)
    names.push(...patternNames(eq >= 0 ? current.slice(0, eq) : current))
    start = end + 1
  }
  for (const i of topLevelCodePositions(body)) {
    if (body[i] === ',') flush(i)
  }
  flush(body.length)
  return names
}

function nestedVarNames(segment: string): string[] {
  const names: string[] = []
  const code = [...codePositions(segment, true)]
  let depth = 0
  let pendingFunctionDepth: number | null = null
  const functionDepths: number[] = []
  for (let k = 0; k < code.length; k++) {
    const i = code[k]!
    const c = segment[i]!
    if (c === '(' || c === '[' || c === '{') {
      if (c === '{' && pendingFunctionDepth === depth) {
        functionDepths.push(depth + 1)
        pendingFunctionDepth = null
      }
      depth++
      continue
    }
    if (c === ')' || c === ']' || c === '}') {
      if (functionDepths[functionDepths.length - 1] === depth) functionDepths.pop()
      depth--
      continue
    }
    if (c === '=' && segment[i + 1] === '>') {
      if (/^=>\s*\{/.test(segment.slice(i))) pendingFunctionDepth = depth
      continue
    }
    if (!/[A-Za-z_$]/.test(c) || (i > 0 && /[\w$.]/.test(segment[i - 1]!))) continue
    let end = i + 1
    while (end < segment.length && /[\w$]/.test(segment[end]!)) end++
    const word = segment.slice(i, end)
    k += end - i - 1
    if (word === 'function' || word === 'class') {
      pendingFunctionDepth = depth
      continue
    }
    if (word !== 'var' || functionDepths.length > 0) continue
    let stop = segment.length
    let inner = depth
    let assigned = false
    for (let m = k + 1; m < code.length; m++) {
      const p = code[m]!
      const ch = segment[p]!
      if (ch === '(' || ch === '[' || ch === '{') inner++
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (inner === depth) {
          stop = p
          break
        }
        inner--
      } else if (inner !== depth) continue
      else if (ch === ';' || ch === '\n') {
        stop = p
        break
      } else if (ch === '=') assigned = true
      else if (!assigned && /^(?:of|in)(?![\w$])/.test(segment.slice(p, p + 3)) && !/[\w$]/.test(segment[p - 1] ?? '')) {
        stop = p
        break
      }
    }
    names.push(...declarationNames(`var ${segment.slice(end, stop)}`))
  }
  return names
}

function rewriteDynamicImports(source: string): string {
  const starts: number[] = []
  for (const i of codePositions(source, true)) {
    if (source[i] !== 'i' || !source.startsWith('import', i)) continue
    if (i > 0 && /[\w$.]/.test(source[i - 1]!)) continue
    let end = i + 'import'.length
    while (end < source.length && /\s/.test(source[end]!)) end++
    if (source[end] === '(') starts.push(i)
  }
  if (starts.length === 0) return source
  let out = ''
  let last = 0
  for (const i of starts) {
    out += `${source.slice(last, i)}__mercuryImport`
    last = i + 'import'.length
  }
  return out + source.slice(last)
}

function findTopLevelAssign(text: string): number {
  for (const i of topLevelCodePositions(text)) {
    if (text[i] === '=') {
      const prev = i > 0 ? text[i - 1]! : ''
      const next = i + 1 < text.length ? text[i + 1]! : ''
      if (prev === '=' || prev === '!' || prev === '<' || prev === '>') continue
      if (next === '=' || next === '>') continue
      return i
    }
  }
  return -1
}

function rewriteImport(statement: string): { code: string; names: string[] } | null {
  const trimmed = statement.trim()
  const bare = IMPORT_BARE.exec(trimmed)
  if (bare) {
    return { code: `await __mercuryImport(${JSON.stringify(bare[2]!)});`, names: [] }
  }
  const from = IMPORT_FROM.exec(trimmed)
  if (!from) return null
  const clause = from[1]!.trim()
  const specifier = from[3]!
  const moduleVar = `__mercuryModule${Math.abs(hashCode(specifier + clause)) % 100000}`
  const bindings: string[] = []
  const names: string[] = []
  let rest = clause
  const defaultMatch = /^([A-Za-z_$][\w$]*)\s*(,)?\s*/.exec(rest)
  if (defaultMatch && !rest.startsWith('{') && !rest.startsWith('*')) {
    const name = defaultMatch[1]!
    bindings.push(
      `const ${name} = ${moduleVar}.default !== undefined ? ${moduleVar}.default : ${moduleVar};`,
    )
    names.push(name)
    rest = rest.slice(defaultMatch[0].length)
  }
  if (rest.startsWith('*')) {
    const ns = /^\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(rest)
    if (!ns) return null
    bindings.push(`const ${ns[1]!} = ${moduleVar};`)
    names.push(ns[1]!)
  } else if (rest.startsWith('{')) {
    const inner = rest.slice(1, rest.lastIndexOf('}'))
    const parts = inner
      .split(',')
      .map(p => p.trim())
      .filter(Boolean)
    const destructure: string[] = []
    for (const part of parts) {
      const asMatch = /^([A-Za-z_$][\w$]*|default)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part)
      if (asMatch) {
        destructure.push(`${asMatch[1]!}: ${asMatch[2]!}`)
        names.push(asMatch[2]!)
      } else if (/^[A-Za-z_$][\w$]*$/.test(part)) {
        destructure.push(part)
        names.push(part)
      } else {
        return null
      }
    }
    bindings.push(`const { ${destructure.join(', ')} } = ${moduleVar};`)
  } else if (rest.trim() !== '') {
    return null
  }
  return {
    code: `const ${moduleVar} = await __mercuryImport(${JSON.stringify(specifier)});\n${bindings.join('\n')}`,
    names,
  }
}

function hashCode(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return hash
}

function isCapturableExpression(segment: string, leadingGroupSafe: boolean): boolean {
  const trimmed = segment.trim().replace(/;+$/, '')
  if (!trimmed) return false
  if (STATEMENT_KEYWORD.test(trimmed)) return false
  if (/^[.+\-*/%&|^<>?:,)\]}]/.test(trimmed)) return false
  if (!leadingGroupSafe && /^[([]/.test(trimmed)) return false
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function(`return async () => (${trimmed}\n);`)
    return true
  } catch {
    return false
  }
}

function directivePrologue(source: string): string {
  const trivia = LEADING_TRIVIA
  let offset = 0
  let end = 0
  while (offset < source.length) {
    offset += trivia.exec(source.slice(offset))![0].length
    const literal = /^(?:"(?:[^"\\\r\n]|\\[\s\S])*"|'(?:[^'\\\r\n]|\\[\s\S])*')/.exec(source.slice(offset))
    if (literal === null) break
    const literalEnd = offset + literal[0].length
    const gap = trivia.exec(source.slice(literalEnd))![0]
    const rest = source.slice(literalEnd + gap.length)
    if (rest.startsWith(';')) offset = literalEnd + gap.length + 1
    else if (rest === '' || /[\r\n\u2028\u2029]/.test(gap) && (/^(?:\+\+|--)/.test(rest) || !/^(?:[.(\[`+\-*/%<>=?&|^,]|!=|in\b|instanceof\b)/.test(rest))) offset = literalEnd
    else break
    end = offset
  }
  return source.slice(0, end)
}

function transformJsCell(source: string): TransformedCell {
  const base = rewriteDynamicImports(source)
  const segments = splitTopLevelSegments(base)
  const names: string[] = []
  const out: string[] = []
  let lastCodeIndex = -1
  let prevCodeIndex = -1
  for (let i = 0; i < segments.length; i++) {
    const text = segments[i]!.text
    if (text.replace(LEADING_TRIVIA, '').trim()) {
      prevCodeIndex = lastCodeIndex
      lastCodeIndex = i
    }
  }
  const prev = prevCodeIndex >= 0 ? segments[prevCodeIndex]!.text.trim() : ''
  const prevEndsCleanly =
    prevCodeIndex < 0 ||
    !(
      /[=+\-*/%&|^<>?:,.([{]$/.test(prev) ||
      /=>$/.test(prev) ||
      /\b(?:return|typeof|instanceof|in|of|new|await|yield|case|else|do)$/.test(prev)
    )
  const previousOutline = [...topLevelCodePositions(prev)].map(i => prev[i]).join('').replace(/\s/g, '')
  const previousBlock = /^(?:(?:for(?:await)?|while|switch)\)\}|if\)\}(?:elseif\)\})*(?:else\})?|try\}(?:catch(?:\))?\})?(?:finally\})?)$/.test(previousOutline)
  let capturesResult = false
  for (let i = 0; i < segments.length; i++) {
    let text = segments[i]!.text
    const leading = LEADING_TRIVIA.exec(text)![0]
    const trimmed = text.slice(leading.length).trim()
    if (trimmed.startsWith('export ')) {
      const afterExport = trimmed.slice('export '.length)
      if (/^(?:const|let|var|function|class|async\s+function)\b/.test(afterExport)) {
        text = leading + afterExport
      }
    }
    const effective = text.slice(leading.length).trim()
    if (/^import\b/.test(effective)) {
      const rewritten = rewriteImport(effective)
      if (rewritten) {
        names.push(...rewritten.names)
        out.push(leading + rewritten.code + '\n')
        continue
      }
    }
    if (DECL_KEYWORD.test(effective)) {
      names.push(...declarationNames(effective))
      out.push(text)
      continue
    }
    const funcMatch = FUNC_DECL.exec(effective)
    if (funcMatch?.[1]) {
      names.push(funcMatch[1])
      out.push(text)
      continue
    }
    const classMatch = CLASS_DECL.exec(effective)
    if (classMatch?.[1]) {
      names.push(classMatch[1])
      out.push(text)
      continue
    }
    names.push(...nestedVarNames(effective))
    if (i === lastCodeIndex && prevEndsCleanly && !(effective.startsWith('`') && prevCodeIndex >= 0 && !prev.endsWith(';')) && isCapturableExpression(effective, prevCodeIndex < 0 || prev.endsWith(';') || previousBlock)) {
      const expr = effective.replace(/;+\s*$/, '')
      out.push(`${leading}globalThis.__mercuryResult = (${expr}\n);`)
      capturesResult = true
      continue
    }
    out.push(text)
  }
  const unique = [...new Set(names)].filter(n => /^[A-Za-z_$][\w$]*$/.test(n) && parsesCell(`let ${n};`))
  const persist = unique
    .map(
      n =>
        `try { const __mercuryValue = ${n}; if (!(__mercuryThrew && __mercuryValue === undefined)) { globalThis.${n} = __mercuryValue; globalThis.__mercuryPersistedNames.push(${JSON.stringify(n)}); } } catch {}`,
    )
    .join(' ')
  const stamp = Math.abs(hashCode(source))
  const save = `__mercuryPersist${stamp}`
  const threw = `__mercuryThrew${stamp}`
  const code = `${directivePrologue(base)}\nlet ${save}, ${threw} = false;\ntry {\n${save} = (__mercuryThrew) => { globalThis.__mercuryPersistedNames = []; ${persist} };\n${out.join('')}\n} catch (__mercuryError) { ${threw} = true; throw __mercuryError } finally { ${save}(${threw}); }`
  if (!parsesCell(code)) {
    if (parsesCell(base)) return { code: base, persistedNames: [], capturesResult: false }
    if (parsesCell(source)) return { code: source, persistedNames: [], capturesResult: false }
  }
  return { code, persistedNames: unique, capturesResult }
}

function parsesCell(code: string): boolean {
  try {
    new Function(`return (async () => {\n${code}\n})`)
    return true
  } catch {
    return false
  }
}

return { transformJsCell, splitTopLevelSegments }
}

export const { transformJsCell, splitTopLevelSegments } = createJsCellTransformer()

export function jsCellTransformerSource(): string {
  return `(${createJsCellTransformer.toString()})()`
}
