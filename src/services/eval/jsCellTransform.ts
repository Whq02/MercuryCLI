// ============================================================================
//  services/eval/jsCellTransform — the JS cell dialect, made persistent.
//
//  A cell runs as the body of one sloppy-mode async function in the JS
//  kernel, so raw `const`/`let`/`class` bindings and static imports would
//  die with the call. This transform makes the notebook contract hold:
//
//  · top-level static imports become awaited __mercuryImport calls (the
//    runner resolves specifiers against the kernel cwd and cache-busts
//    RELATIVE files between cells, so an edited module re-imports fresh
//    while package identity is preserved);
//  · every top-level declared name is exported to globalThis when the cell
//    finishes (per-name try/catch, so a name that never initialised —
//    error mid-cell, TDZ — is skipped rather than throwing);
//  · when the final statement is an expression, its value is captured for
//    the result frame.
//
//  The scanner is deliberately lexical (strings, template literals with
//  nesting, comments, bracket depth) rather than a full parser: a
//  construct it cannot read is left byte-identical, which degrades to
//  "that binding does not persist", never to broken code. Regex literals
//  are not modelled; a `/` pattern containing quotes or braces can confuse
//  depth for the rest of the cell — accepted bound, noted in the tool
//  prompt's dialect notes.
// ============================================================================

export interface TransformedCell {
  code: string
  /** Top-level names exported to globalThis at cell end. */
  persistedNames: string[]
  /** Whether the final statement's value is captured as the cell result. */
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

/** Split source into top-level (depth-0) statement segments, preserving all
 *  bytes: joining the segments back yields the input. */
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
    // mode === 'code'
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
      // A '}' that closes a template interpolation resumes the template.
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
      // Closing brackets never end a segment — statements end at depth-0
      // ';' or '\n' only, so `import { a } from 'x'`, member chains after a
      // call, and multi-line object literals stay whole.
      continue
    }
    if (c === ';' && depth === 0) {
      i++
      segments.push({ text: source.slice(start, i) })
      start = i
      continue
    }
    if (c === '\n' && depth === 0) {
      // Newline ends a segment only when the next non-blank line starts a
      // fresh statement keyword or the segment already looks complete; a
      // conservative ASI stand-in. We end the segment and let downstream
      // joining keep byte identity either way.
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

/** Identifiers bound by a declarator pattern region (pre-`=`), excluding
 *  object keys (`b:` in `{ b: c }`). */
function patternNames(region: string): string[] {
  const names: string[] = []
  const idRe = /[A-Za-z_$][\w$]*/g
  let match: RegExpExecArray | null
  while ((match = idRe.exec(region)) !== null) {
    const name = match[0]
    if (name === 'const' || name === 'let' || name === 'var') continue
    const after = region.slice(match.index + name.length).match(/^\s*:/)
    if (after) continue // an object-pattern key, not a binding
    names.push(name)
  }
  return names
}

/** Names bound by a whole `const|let|var …` statement. Splits declarators on
 *  relative-depth-0 commas; each declarator contributes its pre-`=` pattern. */
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

/** Index of the first depth-0 `=` that is assignment (not ==, =>, <=, >=, !=). */
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

/** Rewrite one static import statement to awaited __mercuryImport form.
 *  Returns null when the statement is not a rewritable import. */
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
  // `default` leading name (possibly followed by , {…} or , * as ns)
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
        return null // an import form the scanner cannot read — leave the cell alone
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

/** True when the segment reads as a capturable final expression (not a
 *  declaration/flow statement, not empty, not comment-only). */
function isCapturableExpression(segment: string): boolean {
  const trimmed = segment.trim().replace(/;+$/, '')
  if (!trimmed) return false
  if (STATEMENT_KEYWORD.test(trimmed)) return false
  // A segment starting with a continuation token is the tail of the
  // previous statement (`.map(…)`, `+ 1`) or ambiguous under ASI (`(`,
  // `[`); never wrap those.
  if (/^[.+\-*/%&|^<>?:,)\]}([]/.test(trimmed)) return false
  try {
    // Function construction parses without executing — a pure syntax probe.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    new Function(`return (${trimmed});`)
    return true
  } catch {
    return false
  }
}

/**
 * The whole transform. Best-effort by construction: any segment the
 * scanner cannot read passes through byte-identical.
 */
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
  // Capture is only safe when the final segment starts at a clean statement
  // boundary — a newline split mid-statement (`… =>` \n `x + 1`) must not be
  // wrapped, or the wrap would rewrite the statement's own tail. ASI makes
  // `const a = 1` + newline a finished statement, so the test is for a
  // trailing CONTINUATION (operator, `=>`, an operator keyword), not for an
  // explicit `;`.
  const prev = prevCodeIndex >= 0 ? segments[prevCodeIndex]!.text.trim() : ''
  const prevEndsCleanly =
    prevCodeIndex < 0 ||
    !(
      /[=+\-*/%&|^<>?:,.([{]$/.test(prev) ||
      /=>$/.test(prev) ||
      /\b(?:return|typeof|instanceof|in|of|new|await|yield|case|else|do)$/.test(prev)
    )
  let capturesResult = false
  for (let i = 0; i < segments.length; i++) {
    let text = segments[i]!.text
    const trimmed = text.trim()
    const leading = text.slice(0, text.length - text.trimStart().length)
    if (trimmed.startsWith('export ')) {
      // Strip `export` ONLY from a declaration that then persists to
      // globalThis (export const/let/var/function/class/async function). The
      // other export forms — `export default X`, `export * from …`,
      // `export { … }` — cannot legally appear in the cell's function body at
      // all; slicing `export default foo` to `default foo` would replace the
      // honest "Unexpected token 'export'" error (naming the model's own
      // keyword) with a mangled "Unexpected keyword 'default'". Those pass
      // through byte-identical so the syntax error points at what was written.
      const afterExport = trimmed.slice('export '.length)
      if (/^(?:const|let|var|function|class|async\s+function)\b/.test(afterExport)) {
        text = leading + afterExport
      }
    }
    const effective = text.trim()
    if (/^import\b/.test(effective)) {
      const rewritten = rewriteImport(effective)
      if (rewritten) {
        out.push(leading + rewritten.code)
        names.push(...rewritten.names)
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
    if (i === lastCodeIndex && prevEndsCleanly && isCapturableExpression(effective)) {
      const expr = effective.replace(/;+\s*$/, '')
      out.push(`${leading}globalThis.__mercuryResult = (${expr});`)
      capturesResult = true
      continue
    }
    out.push(text)
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
