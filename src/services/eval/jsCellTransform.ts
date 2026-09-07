
export interface TransformedCell {
  code: string
  persistedNames: string[]
  capturesResult: boolean
}

const DECL_KEYWORD = /^(const|let|var)\b/
const FUNC_DECL = /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
const CLASS_DECL = /^class\s+([A-Za-z_$][\w$]*)/
const IMPORT_FROM = /^import\s+([\s\S]+?)\s+from\s*(['"])([^'"\n]+)\2\s*;?$/
const IMPORT_BARE = /^import\s*(['"])([^'"\n]+)\1\s*;?$/
const STATEMENT_KEYWORD =
  /^(?:const|let|var|function|class|if|for|while|do|switch|try|throw|return|break|continue|import|export|async\s+function|debugger)\b/

interface Segment {
  text: string
}

export function splitTopLevelSegments(source: string): Segment[] {
  const segments: Segment[] = []
  let start = 0
  let depth = 0
  let i = 0
  const n = source.length
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template'
  let mode: Mode = 'code'
  const templateDepths: number[] = []
  while (i < n) {
    const c = source[i]!
    const next = i + 1 < n ? source[i + 1]! : ''
    switch (mode) {
      case 'line':
        if (c === '\n') mode = 'code'
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
      i++
      continue
    }
    if (c === ';' && depth === 0) {
      i++
      segments.push({ text: source.slice(start, i) })
      start = i
      continue
    }
    if (c === '\n' && depth === 0) {
      i++
      segments.push({ text: source.slice(start, i) })
      start = i
      continue
    }
    i++
  }
  if (start < n) segments.push({ text: source.slice(start) })
  return segments
}

function patternNames(region: string): string[] {
  const names: string[] = []
  const idRe = /[A-Za-z_$][\w$]*/g
  let match: RegExpExecArray | null
  while ((match = idRe.exec(region)) !== null) {
    const name = match[0]
    if (name === 'const' || name === 'let' || name === 'var') continue
    const after = region.slice(match.index + name.length).match(/^\s*:/)
    if (after) continue
    names.push(name)
  }
  return names
}

export function declarationNames(statement: string): string[] {
  const body = statement.replace(DECL_KEYWORD, '')
  const names: string[] = []
  let depth = 0
  let current = ''
  const flush = (): void => {
    const eq = findTopLevelAssign(current)
    names.push(...patternNames(eq >= 0 ? current.slice(0, eq) : current))
    current = ''
  }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    if (c === ',' && depth === 0) {
      flush()
      continue
    }
    current += c
  }
  flush()
  return names
}

function findTopLevelAssign(text: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === '=' && depth === 0) {
      const prev = i > 0 ? text[i - 1]! : ''
      const next = i + 1 < text.length ? text[i + 1]! : ''
      if (prev === '=' || prev === '!' || prev === '<' || prev === '>') continue
      if (next === '=' || next === '>') {
        i++
        continue
      }
      return i
    }
  }
  return -1
}

export function rewriteImport(statement: string): { code: string; names: string[] } | null {
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

function isCapturableExpression(segment: string): boolean {
  const trimmed = segment.trim().replace(/;+$/, '')
  if (!trimmed) return false
  if (STATEMENT_KEYWORD.test(trimmed)) return false
  if (/^[.+\-*/%&|^<>?:,)\]}([]/.test(trimmed)) return false
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function(`return (${trimmed});`)
    return true
  } catch {
    return false
  }
}

export function transformJsCell(source: string): TransformedCell {
  const segments = splitTopLevelSegments(source)
  const names: string[] = []
  const out: string[] = []
  let lastCodeIndex = -1
  let prevCodeIndex = -1
  for (let i = 0; i < segments.length; i++) {
    const text = segments[i]!.text
    if (text.trim()) {
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
  let capturesResult = false
  const syncTail = (): string =>
    names.length > 0
      ? `\n;(() => { ${[...new Set(names)].filter(n => /^[A-Za-z_$][\w$]*$/.test(n)).map(n => `try { globalThis.${n} = ${n}; } catch {}`).join(' ')} })();`
      : ''
  const endsCleanly = (segment: string): boolean =>
    !(
      /[=+\-*/%&|^<>?:,.([{]$/.test(segment) ||
      /=>$/.test(segment) ||
      /\b(?:return|typeof|instanceof|in|of|new|await|yield|case|else|do)$/.test(segment)
    )
  const controlHead = /^(?:if|else|for|while|do|switch|try|catch|finally|with|case|default|return|throw|break|continue|yield)\b/
  const nextContinues = (i: number): boolean => {
    for (let j = i + 1; j < segments.length; j++) {
      const following = segments[j]!.text.trim()
      if (following === '') continue
      return /^(?:[.?\[(+\-*/%&|^<>=,:]|\|\||&&|instanceof\b|in\b)/.test(following)
    }
    return false
  }
  const afterOpenHead = (i: number): boolean => {
    for (let j = i - 1; j >= 0; j--) {
      const previous = segments[j]!.text.trim()
      if (previous === '') continue
      return controlHead.test(previous) && !/[};]$/.test(previous)
    }
    return false
  }
  const tailAfter = (i: number, segment: string): string =>
    segment !== '' && endsCleanly(segment) && !controlHead.test(segment) && !nextContinues(i) && !afterOpenHead(i) ? syncTail() : ''
  for (let i = 0; i < segments.length; i++) {
    let text = segments[i]!.text
    const trimmed = text.trim()
    const leading = text.slice(0, text.length - text.trimStart().length)
    if (trimmed.startsWith('export ')) {
      const afterExport = trimmed.slice('export '.length)
      if (/^(?:const|let|var|function|class|async\s+function)\b/.test(afterExport)) {
        text = leading + afterExport
      }
    }
    const effective = text.trim()
    if (/^import\b/.test(effective)) {
      const rewritten = rewriteImport(effective)
      if (rewritten) {
        names.push(...rewritten.names)
        out.push(leading + rewritten.code + syncTail())
        continue
      }
    }
    if (DECL_KEYWORD.test(effective)) {
      names.push(...declarationNames(effective))
      out.push(text + tailAfter(i, effective))
      continue
    }
    const funcMatch = FUNC_DECL.exec(effective)
    if (funcMatch?.[1]) {
      names.push(funcMatch[1])
      out.push(text + tailAfter(i, effective))
      continue
    }
    const classMatch = CLASS_DECL.exec(effective)
    if (classMatch?.[1]) {
      names.push(classMatch[1])
      out.push(text + tailAfter(i, effective))
      continue
    }
    if (i === lastCodeIndex && prevEndsCleanly && isCapturableExpression(effective)) {
      const expr = effective.replace(/;+\s*$/, '')
      out.push(`${leading}globalThis.__mercuryResult = (${expr});`)
      capturesResult = true
      continue
    }
    out.push(text + tailAfter(i, effective))
  }
  const unique = [...new Set(names)].filter(n => /^[A-Za-z_$][\w$]*$/.test(n))
  const exportTail =
    unique.length > 0
      ? `\n;(() => { ${unique.map(n => `try { globalThis.${n} = ${n}; } catch {}`).join(' ')} })();`
      : ''
  return {
    code: out.join('') + exportTail,
    persistedNames: unique,
    capturesResult,
  }
}
