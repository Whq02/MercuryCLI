#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'
import ts from 'typescript'
import { FLAG_REGISTRY } from '../../src/substrate/flagRegistry.ts'
import { flagRegistryFiles, flagRegistryText, isFlagRegistryFile } from '../lib/flagRegistrySource.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const J = (...parts: string[]): string => parts.join('')
const M = J('flag', 'Registry')
const S = J('sub', 'strate')
const spell = (text: string): string => text.replaceAll('@M@', M).replaceAll('@S@', S)
const MODULE_PATH = spell('src/@S@/@M@.ts')
const ROWS_DIR = spell('src/@S@/flags')
const DOOR = 'scripts/lib/flagRegistrySource.ts'
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const DOCUMENT = /\.md$/
const SEP = String.raw`(?:\[[\\/]+\]|[\\/])+`
const QUICK = new RegExp(`${M}|${S}`, 'i')
const SPELLINGS = [
  `${M}\\\\?\\.[cm]?[jt]sx?(?![A-Za-z0-9_])`,
  `${SEP}${M}(?![A-Za-z0-9_])`,
  `${S}${SEP}flags(?![A-Za-z0-9_])`,
  `${S}${SEP}(?:[*?$\\[{]|flag[a-z]*[*?\\[{])`,
].join('|')
const FOLDER = `(?<![A-Za-z0-9_])src${SEP}${S}(?:${SEP})?(?=$|[\\s'"\`),;:|&<>\\]])`
const IN_A_LITERAL = new RegExp(`${SPELLINGS}|${FOLDER}`, 'gi')
const IN_A_SEGMENT = new RegExp(SPELLINGS, 'gi')
const IN_A_LINE = new RegExp(`${SPELLINGS}|${FOLDER}|(?<![A-Za-z0-9_.-])${M}(?![A-Za-z0-9_])`, 'i')
const WHOLE = new RegExp(`^${M}(?:[.*?]\\S*)?$`, 'i')
const FOLDER_WORD = new RegExp(S, 'i')
const ROWS_SEGMENT = /^[\\/]*flags(?![A-Za-z0-9_])/i
const FOLDER_SEGMENT = new RegExp(`(?:^|[\\\\/])${S}[\\\\/]*$`, 'i')
const SRC_SEGMENT = /(?:^|[\\/])src[\\/]*$/i
const SRC_NAME = /^src|src$/i
const INSTEAD = spell(`look the row up through getFlagSpec or FLAG_REGISTRY (a plain import of src/@S@/@M@.ts); a fact the rows cannot say reads the text through flagRegistryText, and a sweep tests a path with isFlagRegistryFile, both from ${DOOR}`)
const OUT_OF_REACH = 'a name assembled from fragments at run time, a path that arrives in a variable, a walk of the whole of src'

type Mention = { file: string; line: number; text: string }
type Scan = { read: number; imports: number; mentions: Mention[] }
type Row = { file: string; line: string; why: string }
type Near = { before: ts.Node | undefined; after: ts.Node | undefined; argument: boolean }

const NAMED: Row[] = [
  { file: 'scripts/gate/impact-doors.txt', line: 'src/@S@/flags/** src/@S@/@M@.ts', why: "the planner's door row: a glob and a path that scripts/verify/impactManifest.ts matches against changed paths; it opens no registry file" },
  { file: 'scripts/identity/prove-docs-altitude.ts', line: "const CONFIG_INDEX_SPELLING = J('src/@S@/', '@M@.ts')", why: 'the spelling a document may cite: the proof strips it from document text and opens no registry file' },
  { file: 'scripts/memory/prove-memory-always-on.ts', line: "for (const dir of ['src/mneme', 'src/tools/MemoryTools', 'src/components/memory', 'src/commands/memory', 'src/utils/capability', 'src/utils/cockpit', 'src/services/mcp', 'src/@S@', 'src/query', 'src/utils/attachments']) {", why: "ten folders walked for memory gate words: the registry's files are skipped by the path test and read through the door" },
  { file: 'scripts/motion/prove-motion-wire-trip.ts', line: "check('the governor is still config-free (flag reads only)', !/utils\\/config/.test(governorSrc) && /@M@/.test(governorSrc))", why: "tests the motion governor's own source for its import of the registry: it reads the governor" },
  { file: 'scripts/notifications/prove-surface-router.ts', line: "l => l.includes('@M@') || l.includes('ink/events/input-event') || l.includes('utils/fullscreen') || l.includes('services/concourse/concourseEnabled') || l.includes('components/mercury-ui/keyHintLabel'),", why: "an import the route owner may carry: the proof reads the owner's import lines" },
  { file: 'scripts/orphans/gen-reachability-manifest.ts', line: "'src/@S@/@M@.ts',", why: 'a root-class label written into the generated manifest: the generator reads the rows through its import' },
  { file: 'scripts/sessionStorage/prove-path-contract.ts', line: "'../../@S@/@M@.js': { flagEnv: (name: string) => flags[name] },", why: 'the specifier the sandboxed paths module asks for, answered with a stand-in that reads the flags the proof sets: the proof opens no registry file' },
  { file: 'scripts/substrate/gen-flag-table.ts', line: '> Derived from \\`src/@S@/@M@.ts\\` by \\`scripts/@S@/gen-flag-table.ts\\`.', why: 'a sentence in the header of the rendered table: the renderer reads the rows through its import' },
  { file: 'scripts/transcript-rows/prove-motion-governor.ts', line: "check('the governor is config-free (flag reads only — the ink layer taps it)', !/utils\\/config/.test(governor) && /@M@/.test(governor))", why: "tests the motion governor's own source for its import of the registry: it reads the governor" },
  { file: 'scripts/vulcan/vulcan-audit-waves.js', line: 'The new surfaces: src/utils/vulcan/*, src/services/vulcan/*, src/tools/GodotTool/*, assets/vulcan/addon/**, scripts/vulcan/*, plus edits in src/tools.ts, src/constants/prompts.ts, src/constants/subagentDoctrine.ts, src/utils/cockpit/harnessMap.ts, src/@S@/startupMenu.ts, src/@S@/@M@.ts, src/utils/healthReport.ts, assets/splash/mercury-splash.mjs.', why: 'a file list inside the audit prompt text: the script opens none of them' },
  { file: 'scripts/wards/prove-wards-model-free.ts', line: "'../@S@/@M@.js',", why: "an import specifier the wards guard may carry: the proof reads the guard's imports" },
].map(row => ({ ...row, line: spell(row.line) }))
const NAMED_ROWS = 11

type Place = { file: string; line: number; flag: string; form: string; say: string }
type Kept = { file: string; flag: string; places: number; why: string }
type Constants = { all: Map<string, string>; exported: Map<string, string>; aliases: Set<string> }

const REFLECTION = ['Reflect.get', 'Reflect.has', 'Reflect.set', 'Reflect.deleteProperty', 'Reflect.getOwnPropertyDescriptor', 'Object.hasOwn', 'Object.getOwnPropertyDescriptor']
const OWN_KEY_TESTS = ['hasOwnProperty', 'propertyIsEnumerable']
const THE_VERBS = spell("the door is src/@S@/@M@.ts: flagEnv(name) reads the process environment and flagEnv(name, env) another one, setFlagEnv and deleteFlagEnv write and delete, stampFlagEnv writes what is not the session's own stamp, stampFlagOnEnv and flagPair write into an environment that is being built")
const PAST_REACH = 'a name assembled at run time, a name handed in from another file, a name that arrives through a re-export, the key of an object literal (flagPair builds that one)'
const PAYLOAD = 'a payload copied out of the product and run by node on its own: it cannot import the registry'
const KEPT: Kept[] = [
  { file: 'src/extensions/@B@/shared/bootstrap.mjs', flag: 'MERCURY_CRAFT_INSTALL_KEY', places: 2, why: PAYLOAD },
  { file: 'src/extensions/@B@/shared/bootstrap.mjs', flag: 'MERCURY_EXTENSION_DATA', places: 1, why: PAYLOAD },
  { file: 'src/extensions/@B@/shared/install.mjs', flag: 'MERCURY_CRAFT_PLATFORM', places: 1, why: PAYLOAD },
].map(row => ({ ...row, file: row.file.replace('@B@', J('bund', 'led')) }))
const KEPT_PLACES = 4

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

function scriptKind(file: string): ts.ScriptKind {
  if (/\.(?:tsx|jsx)$/.test(file)) return ts.ScriptKind.TSX
  if (/\.(?:js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function importKind(node: ts.Node): 'plain' | 'attributed' | null {
  for (let at = node; at.parent; at = at.parent) {
    const p = at.parent
    if ((ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) && p.moduleSpecifier === at) return p.attributes ? 'attributed' : 'plain'
    if (ts.isExternalModuleReference(p) || ts.isImportTypeNode(p)) return 'plain'
    if (ts.isCallExpression(p) && p.arguments.includes(at as ts.Expression)) {
      const callee = p.expression
      if (callee.kind === ts.SyntaxKind.ImportKeyword) return p.arguments.length > 1 ? 'attributed' : 'plain'
      if (ts.isIdentifier(callee) && callee.text === 'require') return 'plain'
    }
    if (ts.isStatement(p) || ts.isSourceFile(p)) return null
  }
  return null
}

function nearOf(node: ts.Node): Near | null {
  const p = node.parent
  const call = ts.isCallExpression(p) || ts.isNewExpression(p)
  const list = call ? p.arguments : ts.isArrayLiteralExpression(p) ? p.elements : undefined
  const at = list ? list.indexOf(node as ts.Expression) : -1
  if (!list || at < 0) return null
  return { before: at > 0 ? list[at - 1] : call ? p.expression : undefined, after: list[at + 1], argument: call }
}

const plainSegment = (node: ts.Node | undefined): boolean => node !== undefined && ts.isStringLiteralLike(node)
const namesSrc = (node: ts.Node | undefined): boolean => node !== undefined && ((ts.isStringLiteralLike(node) && SRC_SEGMENT.test(node.text)) || (ts.isIdentifier(node) && SRC_NAME.test(node.text)))

function scan(root: string, files: string[]): Scan {
  const out: Scan = { read: 0, imports: 0, mentions: [] }
  for (const file of files) {
    if (file === DOOR || DOCUMENT.test(file)) continue
    let text: string
    try {
      text = readFileSync(join(root, file), 'utf8')
    } catch {
      continue
    }
    if (text.includes('\0')) continue
    out.read++
    if (!QUICK.test(text)) continue
    const all = text.split('\n')
    const lines = new Set<number>()
    if (CODE.test(file)) {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file))
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isRegularExpressionLiteral(node)) {
          const start = node.getStart(source)
          const near = ts.isStringLiteralLike(node) ? nearOf(node) : null
          const aSegmentFollows = near !== null && near.argument && plainSegment(near.after)
          const hits = [...text.slice(start, node.getEnd()).matchAll(aSegmentFollows ? IN_A_SEGMENT : IN_A_LITERAL)].map(hit => hit.index)
          if (ts.isStringLiteralLike(node)) {
            const rowsAfterTheFolder = near !== null && ROWS_SEGMENT.test(node.text) && near.before !== undefined && FOLDER_WORD.test(near.before.getText(source))
            const theFolderAfterSrc = near !== null && FOLDER_SEGMENT.test(node.text) && namesSrc(near.before) && !plainSegment(near.after)
            if (WHOLE.test(node.text) || rowsAfterTheFolder || theFolderAfterSrc) hits.push(0)
          }
          if (hits.length > 0) {
            if (importKind(node) === 'plain') out.imports++
            else for (const at of hits) lines.add(source.getLineAndCharacterOfPosition(start + at).line)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    } else {
      all.forEach((line, i) => {
        if (!line.trimStart().startsWith('#') && IN_A_LINE.test(line)) lines.add(i)
      })
    }
    for (const line of [...lines].sort((a, b) => a - b)) out.mentions.push({ file, line: line + 1, text: (all[line] ?? '').trim() })
  }
  return out
}

function judge(mentions: Mention[], rows: Row[]): { unlisted: Mention[]; stale: Row[] } {
  const used = new Set<Row>()
  const unlisted: Mention[] = []
  for (const m of mentions) {
    const row = rows.find(r => r.file === m.file && r.line === m.text && !used.has(r))
    if (row) used.add(row)
    else unlisted.push(m)
  }
  return { unlisted, stale: rows.filter(r => !used.has(r)) }
}

const where = (m: Mention): string => `${m.file}:${m.line}`

const peel = (node: ts.Node): ts.Node => {
  let at = node
  while (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at) || ts.isAsExpression(at) || ts.isSatisfiesExpression(at)) at = at.expression
  return at
}

function isProcessEnv(node: ts.Node): boolean {
  const at = peel(node)
  if (!ts.isPropertyAccessExpression(at) || at.name.text !== 'env') return false
  const owner = peel(at.expression)
  return (ts.isIdentifier(owner) && owner.text === 'process') || (ts.isPropertyAccessExpression(owner) && owner.name.text === 'process')
}

function constantsOf(source: ts.SourceFile): Constants {
  const all = new Map<string, string>()
  const exported = new Map<string, string>()
  const aliases = new Set<string>()
  const visit = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const value = peel(node.initializer)
      if (isProcessEnv(value)) aliases.add(node.name.text)
      if (ts.isVariableDeclaration(node) && ts.isStringLiteralLike(value) && !all.has(node.name.text)) {
        all.set(node.name.text, value.text)
        const statement = node.parent.parent
        if (ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent) && (statement.modifiers ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)) exported.set(node.name.text, value.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier !== undefined || statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue
    for (const el of statement.exportClause.elements) {
      const value = all.get((el.propertyName ?? el.name).text)
      if (value !== undefined) exported.set(el.name.text, value)
    }
  }
  return { all, exported, aliases }
}

function moduleFile(from: string, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith('.') && !spec.startsWith('src/')) return undefined
  const base = spec.startsWith('.') ? posix.join(posix.dirname(from), spec) : spec
  const stem = base.replace(/\.[cm]?[jt]sx?$/, '')
  return [base, `${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.js`, `${stem}.mjs`, `${stem}/index.ts`, `${stem}/index.tsx`].find(file => known.has(file))
}

function flagPlaces(root: string, files: string[], flags: Set<string>): { read: number; places: Place[] } {
  const texts = new Map<string, string>()
  for (const file of files) {
    if (!CODE.test(file) || isFlagRegistryFile(file)) continue
    try {
      texts.set(file, readFileSync(join(root, file), 'utf8'))
    } catch {
      continue
    }
  }
  const known = new Set(texts.keys())
  const names = [...flags]
  const stem = names.reduce((a, b) => {
    let n = 0
    while (n < a.length && a[n] === b[n]) n++
    return a.slice(0, n)
  }, names[0] ?? '')
  const mayName = (text: string): boolean => stem.length < 4 || text.includes(stem)
  const parsed = new Map<string, { source: ts.SourceFile; constants: Constants }>()
  const parse = (file: string): { source: ts.SourceFile; constants: Constants } => {
    const held = parsed.get(file)
    if (held !== undefined) return held
    const source = ts.createSourceFile(file, texts.get(file) ?? '', ts.ScriptTarget.Latest, true, scriptKind(file))
    const made = { source, constants: constantsOf(source) }
    parsed.set(file, made)
    return made
  }
  const carried = new Map<string, Map<string, string>>()
  for (const [file, text] of texts) {
    if (!mayName(text)) continue
    const held = new Map([...parse(file).constants.exported].filter(([, value]) => flags.has(value)))
    if (held.size > 0) carried.set(file, held)
  }
  const carriedNames = [...new Set([...carried.values()].flatMap(held => [...held.keys()]))]
  const namesACarried = carriedNames.length === 0 ? null : new RegExp(carriedNames.map(name => name.replace(/[$]/g, '\\$&')).join('|'))
  const places: Place[] = []
  for (const [file, text] of texts) {
    if (!mayName(text) && (namesACarried === null || !namesACarried.test(text))) continue
    const { source, constants } = parse(file)
    const handed = new Map<string, string>()
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
      const bindings = statement.importClause?.namedBindings
      if (bindings === undefined || !ts.isNamedImports(bindings)) continue
      const held = carried.get(moduleFile(file, statement.moduleSpecifier.text, known) ?? '')
      if (held === undefined) continue
      for (const el of bindings.elements) {
        const flag = held.get((el.propertyName ?? el.name).text)
        if (flag !== undefined) handed.set(el.name.text, flag)
      }
    }
    const flagOf = (value: string | undefined): string | undefined => (value !== undefined && flags.has(value) ? value : undefined)
    const keyOf = (node: ts.Node | undefined): string | undefined => {
      if (node === undefined) return undefined
      const at = peel(node)
      if (ts.isStringLiteralLike(at)) return flagOf(at.text)
      return ts.isIdentifier(at) ? flagOf(constants.all.get(at.text) ?? handed.get(at.text)) : undefined
    }
    const nameOf = (name: ts.Node): string | undefined => (ts.isIdentifier(name) ? flagOf(name.text) : ts.isComputedPropertyName(name) ? keyOf(name.expression) : keyOf(name))
    const helpers = new Map<string, number[]>()
    const helperOf = (name: string, fn: ts.FunctionLikeDeclaration): void => {
      const params = fn.parameters.map(p => (ts.isIdentifier(p.name) ? p.name.text : ''))
      const hit = new Set<number>()
      const seek = (node: ts.Node): void => {
        if (ts.isElementAccessExpression(node)) {
          const object = peel(node.expression)
          const key = peel(node.argumentExpression)
          if (ts.isIdentifier(key) && params.includes(key.text) && (isProcessEnv(object) || (ts.isIdentifier(object) && constants.aliases.has(object.text)))) hit.add(params.indexOf(key.text))
        }
        ts.forEachChild(node, seek)
      }
      if (fn.body !== undefined) seek(fn.body)
      if (hit.size > 0) helpers.set(name, [...hit])
    }
    const collect = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) helperOf(node.name.text, node)
      else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        const fn = peel(node.initializer)
        if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) helperOf(node.name.text, fn)
      }
      ts.forEachChild(node, collect)
    }
    collect(source)
    const note = (node: ts.Node, flag: string, form: string, say: string): void => {
      places.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, flag, form, say })
    }
    const holder = (object: ts.Node): string => (isProcessEnv(object) ? '' : peel(object).getText(source).replace(/\s+/g, ' ').slice(0, 60))
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const flag = ts.isPropertyAccessExpression(node) ? flagOf(node.name.text) : keyOf(node.argumentExpression)
        if (flag !== undefined) {
          const env = holder(node.expression)
          let up: ts.Node = node
          while (ts.isParenthesizedExpression(up.parent) || ts.isNonNullExpression(up.parent)) up = up.parent
          const parent = up.parent
          if (ts.isDeleteExpression(parent)) note(node, flag, 'delete', env === '' ? `delete it with deleteFlagEnv('${flag}')` : `delete it with for (const spelling of flagSpellings('${flag}')) delete ${env}[spelling]`)
          else if (ts.isBinaryExpression(parent) && parent.left === up && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) note(node, flag, 'write', env === '' ? `write it with setFlagEnv('${flag}', value), or with stampFlagEnv('${flag}', value) where the write is not the session's own stamp` : `write it with stampFlagOnEnv(${env}, '${flag}', value)`)
          else note(node, flag, ts.isPropertyAccessExpression(node) ? 'member' : 'key', `read it with flagEnv('${flag}'${env === '' ? '' : `, ${env}`})`)
        }
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const flag = nameOf(node.propertyName ?? node.name)
        if (flag !== undefined) note(node, flag, 'destructure', `take it with flagEnv('${flag}') in a constant of its own`)
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
        const flag = keyOf(node.left)
        const env = holder(node.right)
        if (flag !== undefined) note(node, flag, 'in', `test it with flagEnv('${flag}'${env === '' ? '' : `, ${env}`}) !== undefined`)
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const target = peel(node.left)
        if (ts.isObjectLiteralExpression(target)) {
          for (const property of target.properties) {
            const flag = ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) ? nameOf(property.name) : undefined
            if (flag !== undefined) note(property, flag, 'destructure', `take it with flagEnv('${flag}') in a constant of its own`)
          }
        }
      } else if (ts.isCallExpression(node)) {
        const callee = peel(node.expression)
        if (ts.isIdentifier(callee)) {
          for (const index of helpers.get(callee.text) ?? []) {
            const flag = keyOf(node.arguments[index])
            if (flag !== undefined) note(node.arguments[index] ?? node, flag, 'helper', `${callee.text} reads the environment by the name it is handed: read it there with flagEnv`)
          }
        } else if (ts.isPropertyAccessExpression(callee)) {
          const spelled = `${peel(callee.expression).getText(source)}.${callee.name.text}`
          if (REFLECTION.includes(spelled) || OWN_KEY_TESTS.includes(callee.name.text) || (callee.name.text === 'call' && OWN_KEY_TESTS.some(test => spelled.endsWith(`.${test}.call`)))) {
            for (const argument of node.arguments) {
              const flag = keyOf(argument)
              if (flag !== undefined) note(argument, flag, 'reflection', `read it with flagEnv('${flag}')`)
            }
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { read: texts.size, places }
}

function judgeKept(places: Place[], kept: Kept[]): { unlisted: Place[]; stale: string[] } {
  const room = new Map(kept.map(row => [`${row.file}\t${row.flag}`, row.places]))
  const unlisted: Place[] = []
  for (const place of places) {
    const key = `${place.file}\t${place.flag}`
    const left = room.get(key) ?? 0
    if (left > 0) room.set(key, left - 1)
    else unlisted.push(place)
  }
  const stale = kept.flatMap(row => {
    const left = room.get(`${row.file}\t${row.flag}`) ?? 0
    return left > 0 ? [`${row.file} ${row.flag}: the row keeps ${row.places} and ${row.places - left} stand, so lower it to ${row.places - left}${row.places - left === 0 ? ' (delete the row)' : ''}`] : []
  })
  return { unlisted, stale }
}

const told = (places: Place[]): string => places.slice(0, 60).map(p => `\n      ${p.file}:${p.line} ${p.flag} — ${p.say}`).join('') + (places.length > 60 ? `\n      … and ${places.length - 60} more` : '')

section('§0 the reading on a planted estate: every reader the net reaches is named with its line')
{
  const estate = mkdtempSync(join(tmpdir(), 'flag-registry-readers-'))
  const planted: Array<{ file: string; lines: string[]; named: number[] }> = [
    { file: DOOR, lines: ["export const text = (): string => readFileSync('src/@S@/@M@.ts', 'utf8')"], named: [] },
    {
      file: 'scripts/a/prove-lookup.ts',
      lines: [
        "import { getFlagSpec } from '../../src/@S@/@M@.ts'",
        "import { flagRegistryText } from '../lib/flagRegistrySource.ts'",
        "const { FLAG_REGISTRY } = await import('../../src/@S@/@M@.js')",
        "const late = await import(join(ROOT, 'src/@S@/@M@.ts'))",
        "type Spec = import('../../src/@S@/@M@.ts').FlagSpec",
        "import legacy = require('../../src/@S@/@M@.ts')",
        '// a comment may name src/@S@/@M@.ts',
        "const menu = readFileSync(join(ROOT, 'src', '@S@', 'startupMenu.ts'), 'utf8')",
        "const lock = read('src/@S@/pidLock.ts')",
        "const identity = walk(join(ROOT, 'src/@S@/identity'))",
        "check('the @M@ row is present exactly once', FLAG_REGISTRY.length > 0)",
        'export const out = [getFlagSpec, late, flagRegistryText, legacy, menu, lock, identity]',
      ],
      named: [],
    },
    {
      file: 'scripts/a/prove-read.ts',
      lines: [
        "import { readFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        "const text = readFileSync(join(ROOT, 'src/@S@/@M@.ts'), 'utf8')",
        "const again = src('@S@', '@M@.ts')",
        "const rows = readFileSync(join(ROOT, 'src', '@S@', 'flags', 'core.ts'), 'utf8')",
        "const more = read('src/@S@/flags/core.ts')",
        "const kept = files.filter(f => f !== 'src/@S@/@M@.ts' && !/@M@\\.ts$/.test(f))",
        'export const out = [text, again, rows, more, kept]',
      ],
      named: [3, 4, 5, 6, 7],
    },
    { file: 'scripts/a/run.sh', lines: ['#!/usr/bin/env bash', '# gate-watch: src/@S@/@M@.ts', 'grep -c MERCURY src/@S@/@M@.ts'], named: [3] },
    { file: 'scripts/a/notes.md', lines: ['src/@S@/@M@.ts is where the rows live'], named: [] },
    { file: 'scripts/a/hole-parts.ts', lines: ["const text = readFileSync(join(ROOT, 'src', '@S@', '@M@' + '.ts'), 'utf8')"], named: [1] },
    { file: 'scripts/a/hole-template.ts', lines: ["const MODULE = '@M@'", "const text = readFileSync(join(ROOT, `src/@S@/${MODULE}.ts`), 'utf8')"], named: [1, 2] },
    { file: 'scripts/lib/hole-second-helper.ts', lines: ["export const @S@Text = (name: string): string => readFileSync(join(ROOT, 'src', '@S@', `${name}.ts`), 'utf8')"], named: [1] },
    { file: 'scripts/a/hole-wrapper.ts', lines: ["import { @S@Text } from '../lib/hole-second-helper.ts'", "const text = @S@Text('@M@')"], named: [2] },
    { file: 'scripts/a/hole-folder.ts', lines: ["for (const full of walk(join(ROOT, 'src', '@S@'))) readFileSync(full, 'utf8')"], named: [1] },
    { file: 'scripts/a/hole-glob.ts', lines: ["const found = [...new Bun.Glob('src/@S@/flag*.ts').scanSync({ cwd: ROOT }), ...new Bun.Glob('src/@S@/flag*/**/*').scanSync({ cwd: ROOT })]"], named: [1] },
    { file: 'scripts/a/hole-exec.ts', lines: ["const out = execFileSync('grep', ['-rc', 'MERCURY_', 'src/@S@'], { cwd: ROOT, encoding: 'utf8' })"], named: [1] },
    { file: 'scripts/a/hole-shell.sh', lines: ['set -u', 'name=@M@', 'grep -c MERCURY_ "src/@S@/$name.ts"', 'cat src/@S@/flagR*.ts', "find src/@S@ -name 'flag*' -type f"], named: [2, 3, 4, 5] },
    { file: 'scripts/a/hole-import-text.ts', lines: ["import text from '../../src/@S@/@M@.ts' with { type: 'text' }", "const late = await import('../../src/@S@/@M@.ts', { with: { type: 'text' } })"], named: [1, 2] },
    { file: 'scripts/a/hole-rows-folder.ts', lines: ["const @S@Dir = join(ROOT, 'src', '@S@')", "const rows = join(@S@Dir, 'flags')", "const core = join(ROOT, 'src', '@S@', 'flags/core.ts')"], named: [1, 2, 3] },
    { file: 'scripts/a/hole-path-test.ts', lines: ["const registry = files.filter(f => f.includes('/@M@') || /@S@[\\\\/]flags[\\\\/]/.test(f))"], named: [1] },
    { file: 'scripts/a/hole-noext', lines: ['grep -c MERCURY_ src/@S@/@M@.ts'], named: [1] },
    { file: 'scripts/a/hole-list.txt', lines: ['# paths a reader opens', 'src/@S@/@M@.ts'], named: [2] },
    { file: 'scripts/a/hole-list-reader.ts', lines: ["const listed = readFileSync(join(import.meta.dir, 'hole-list.txt'), 'utf8').split('\\n')"], named: [] },
    { file: 'scripts/a/gen-list.ts', lines: ['export const roots = [', "  'src/@S@/@M@.ts',", ']', 'export const twice = [', "  'src/@S@/@M@.ts',", ']', "console.log(readFileSync('src/@S@/@M@.ts', 'utf8').length)"], named: [5, 7] },
    { file: 'scripts/a/out-of-reach.ts', lines: ["const built = ['flag', 'Registry.ts'].join('')", "const tail = files.filter(f => f.endsWith('Registry.ts'))", "const whole = walk(join(ROOT, 'src'))"], named: [] },
  ]
  for (const { file, lines } of planted) {
    mkdirSync(dirname(join(estate, file)), { recursive: true })
    writeFileSync(join(estate, file), spell(lines.join('\n') + '\n'))
  }
  const got = scan(estate, planted.map(p => p.file))
  rmSync(estate, { recursive: true, force: true })
  const { unlisted, stale } = judge(got.mentions, [{ file: 'scripts/a/gen-list.ts', line: spell("'src/@S@/@M@.ts',"), why: 'a label' }])
  const seen = unlisted.map(where).join(' ')
  const want = planted.flatMap(p => p.named.map(n => `${p.file}:${n}`)).join(' ')
  check('a direct read, a read through a helper, a read of a rows file, a path test in a sweep and a shell grep are each named with their line', ['scripts/a/prove-read.ts:3', 'scripts/a/prove-read.ts:4', 'scripts/a/prove-read.ts:5', 'scripts/a/prove-read.ts:6', 'scripts/a/prove-read.ts:7', 'scripts/a/run.sh:3'].every(at => unlisted.some(m => where(m) === at)), `seen ${seen}`)
  check("each reader the review planted is named with its line and nothing else is: a path built from parts, a template with a hole, a second helper and its caller, a walk of the folder, a glob, a command over the folder, a shell variable and wildcard, an import with an attribute, the rows folder, a path test of a sweep's own, a script with no extension, a path in a data file", seen === want, `seen ${seen} · want ${want}`)
  check('a named row excuses its whole line once: a copy of the line and a longer line that holds it are named, and the row is not stale', unlisted.some(m => where(m) === 'scripts/a/gen-list.ts:5') && unlisted.some(m => where(m) === 'scripts/a/gen-list.ts:7') && !unlisted.some(m => where(m) === 'scripts/a/gen-list.ts:2') && stale.length === 0)
  check('five plain imports are counted as lookups, and a comment, a document, the door, another file of the folder and a label that says the name are not named', got.imports === 5 && !seen.includes('prove-lookup') && !seen.includes('notes.md') && !seen.includes(DOOR), `imports ${got.imports}`)
  check(`out of reach, as the estate check's label says: ${OUT_OF_REACH}`, !seen.includes('out-of-reach') && !seen.includes('hole-list-reader'))
}

section("§1 the door: the registry's files, their text and the path test")
{
  const files = flagRegistryFiles()
  const text = flagRegistryText()
  check('the list holds the registry module first and only registry files', files[0] === MODULE_PATH && files.every(isFlagRegistryFile), files.join(', '))
  check('the text is the text of the listed files and holds the registry', text.includes('export const FLAG_REGISTRY') && text.length >= files.length)
  const outside = FLAG_REGISTRY.filter(row => !text.includes(`'${row.env}'`) && !text.includes(`"${row.env}"`)).map(row => row.env)
  check('every row of FLAG_REGISTRY is spelled in the text the door reads', outside.length === 0, `${outside.length} of ${FLAG_REGISTRY.length} rows are spelled in no file the door reads, so no absence check sees them: ${outside.slice(0, 12).join(', ')}`)
  check('the text holds the row type', text.includes('export interface FlagSpec'), 'export interface FlagSpec stands in no file the door reads')
  check('the path test takes the module and anything under the rows folder, in either spelling of the separator', isFlagRegistryFile(MODULE_PATH) && isFlagRegistryFile(`${ROWS_DIR}/core.ts`) && isFlagRegistryFile(spell('src\\@S@\\flags\\deep\\core.ts')) && isFlagRegistryFile(spell('src\\@S@\\@M@.ts')))
  check('the path test refuses a neighbour, a look-alike and the door itself', !isFlagRegistryFile(spell('src/@S@/flagOff.ts')) && !isFlagRegistryFile(`${ROWS_DIR}.ts`) && !isFlagRegistryFile(`${ROWS_DIR}Extra/core.ts`) && !isFlagRegistryFile(`${MODULE_PATH}x`) && !isFlagRegistryFile(DOOR))
  const split = mkdtempSync(join(tmpdir(), 'flag-registry-door-'))
  const w = (rel: string, body: string): void => {
    mkdirSync(dirname(join(split, rel)), { recursive: true })
    writeFileSync(join(split, rel), body)
  }
  w(MODULE_PATH, 'MODULE')
  w(`${ROWS_DIR}/b.ts`, 'B')
  w(`${ROWS_DIR}/a.ts`, 'A')
  w(`${ROWS_DIR}/deep/c.ts`, 'C')
  w(`${ROWS_DIR}/b.ts.orig`, 'A BACKUP')
  w(`${ROWS_DIR}/.DS_Store`, 'A FINDER FILE')
  w(spell('src/@S@/flagOff.ts'), 'OFF')
  const after = flagRegistryFiles(split)
  check('on a tree whose rows live in the rows folder the list is the module and every .ts file under the folder, in order', after.join(' ') === [MODULE_PATH, `${ROWS_DIR}/a.ts`, `${ROWS_DIR}/b.ts`, `${ROWS_DIR}/deep/c.ts`].join(' '), after.join(' '))
  check('…and the text is those files joined: a neighbour, a backup and a file that is not .ts are left out', flagRegistryText(split) === 'MODULE\nA\nB\nC', flagRegistryText(split))
  rmSync(join(split, MODULE_PATH))
  rmSync(join(split, ROWS_DIR), { recursive: true, force: true })
  check('a tree with no registry has no files and no text', flagRegistryFiles(split).length === 0 && flagRegistryText(split) === '')
  rmSync(split, { recursive: true, force: true })
}

section("§2 the estate: a script reads the registry's text through the door or not at all")
{
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'scripts'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
  const got = scan(ROOT, files)
  const { unlisted, stale } = judge(got.mentions, NAMED)
  console.log(`  ${files.length} files under scripts · ${got.read} read, whatever their extension (documents and binary files aside) · ${got.imports} plain imports of the registry · 1 door (${DOOR}) · ${got.mentions.length - unlisted.length} named lines that read nothing · ${unlisted.length} unlisted`)
  check('the door is a script of this tree', files.includes(DOOR))
  check(
    `no script names the registry's files outside a plain import and the door (0 unlisted readers; out of reach: ${OUT_OF_REACH})`,
    unlisted.length === 0,
    `${unlisted.length} found — ${INSTEAD}; the named list only shrinks:` + unlisted.slice(0, 40).map(m => `\n      ${where(m)} ${m.text.slice(0, 140)}`).join(''),
  )
  check('every named row still stands, on its whole line and once (a row whose line is gone is removed, and the count below with it)', stale.length === 0, stale.map(r => `${r.file} [${r.line.slice(0, 60)}]`).join(' · '))
  check(`the named list holds ${NAMED_ROWS} rows, each with its reason, and none of them reads the text`, NAMED.length === NAMED_ROWS && NAMED.every(r => r.why.trim().length > 0), `rows ${NAMED.length}`)
}

section('§3 the reading of src on a planted estate: a registered flag named at the environment is named with its file, its line, the flag and the verb')
{
  const estate = mkdtempSync(join(tmpdir(), 'flag-door-places-'))
  const FORMS = 'src/planted/forms.ts'
  const planted: Array<{ file: string; lines: string[]; named: number[] }> = [
    { file: 'src/planted/names.ts', lines: ["export const PLANT_ENV = 'MERCURY_PLANT_A'", "const LOCAL_ENV = 'MERCURY_PLANT_B'", 'export { LOCAL_ENV as SECOND_ENV }'], named: [] },
    {
      file: FORMS,
      lines: [
        "import { PLANT_ENV, SECOND_ENV as OTHER } from './names.js'",
        "const KEY = 'MERCURY_PLANT_A'",
        'export const member = process.env.MERCURY_PLANT_A',
        "export const key = process.env['MERCURY_PLANT_A']",
        'export const constant = process.env[KEY]',
        'export const handed = process.env[PLANT_ENV]',
        'export const renamed = process.env[OTHER]',
        'const env = process.env',
        'export const alias = env.MERCURY_PLANT_A',
        'export function parameter(env: NodeJS.ProcessEnv = process.env): string | undefined { return env.MERCURY_PLANT_B }',
        "export function typed(given: Record<string, string | undefined>): string | undefined { return given['MERCURY_PLANT_B'] }",
        'export const nested = (opts: { env: NodeJS.ProcessEnv }): string | undefined => opts.env.MERCURY_PLANT_A',
        'export const chained = (spec: { extraEnv?: Record<string, string> }): string | undefined => spec.extraEnv?.MERCURY_PLANT_A',
        'export const whole = globalThis.process.env.MERCURY_PLANT_A',
        'const { MERCURY_PLANT_A } = process.env',
        'const { MERCURY_PLANT_B: second } = env',
        'export const taken = ({ MERCURY_PLANT_A: first }: NodeJS.ProcessEnv): string | undefined => first',
        "export const present = 'MERCURY_PLANT_A' in process.env",
        "process.env.MERCURY_PLANT_A = '1'",
        "env.MERCURY_PLANT_B ??= '1'",
        'delete process.env.MERCURY_PLANT_A',
        'delete env[KEY]',
        "export const own = Object.hasOwn(process.env, 'MERCURY_PLANT_A')",
        'export const reflected = Reflect.get(env, KEY)',
        "export const has = env.hasOwnProperty('MERCURY_PLANT_B')",
        'function read(name: string): string | undefined { return process.env[name] }',
        "export const helped = read('MERCURY_PLANT_A')",
        'export const out = [MERCURY_PLANT_A, second]',
      ],
      named: [3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 27],
    },
    { file: 'src/planted/Screen.tsx', lines: ['export const Screen = (): JSX.Element => <Text>{process.env.MERCURY_PLANT_A}</Text>'], named: [1] },
    { file: 'src/planted/payload.mjs', lines: ['export const dir = process.env.MERCURY_PLANT_A'], named: [1] },
    {
      file: 'src/planted/quiet.ts',
      lines: [
        "import { flagEnv, flagPair, setFlagEnv, stampFlagEnv, stampFlagOnEnv } from '../@S@/@M@.js'",
        "export const read = flagEnv('MERCURY_PLANT_A')",
        "export const from = (env: NodeJS.ProcessEnv): string | undefined => flagEnv('MERCURY_PLANT_A', env)",
        "setFlagEnv('MERCURY_PLANT_A', '1')",
        "stampFlagEnv('MERCURY_PLANT_B', '1')",
        "export const built = (env: Record<string, string | undefined>): void => stampFlagOnEnv(env, 'MERCURY_PLANT_B', '1')",
        "export const child = { ...process.env, ...flagPair('MERCURY_PLANT_A', '1') }",
        'export const noRow = process.env.MERCURY_NO_ROW',
        'export const platform = process.env.HOME',
        "export const names = ['MERCURY_PLANT_A', 'MERCURY_PLANT_B']",
        'export const said = `set MERCURY_PLANT_A=1 to turn it on`',
        "export const literal = { MERCURY_PLANT_A: '1' }",
        'export const label = (name: string): string => name',
        "export const labelled = label('MERCURY_PLANT_A')",
        'function lookup(table: Record<string, string>, name: string): string | undefined { return table[name] }',
        "export const looked = lookup({}, 'MERCURY_PLANT_A')",
      ],
      named: [],
    },
    { file: 'src/@S@/@M@.ts', lines: ['export const flagEnv = (name: string): string | undefined => process.env[name]', 'export const direct = process.env.MERCURY_PLANT_A'], named: [] },
    { file: 'src/@S@/flags/core.ts', lines: ["export const rows = [{ env: 'MERCURY_PLANT_A' }]", 'export const direct = process.env.MERCURY_PLANT_A'], named: [] },
  ].map(p => ({ ...p, file: spell(p.file) }))
  for (const { file, lines } of planted) {
    mkdirSync(dirname(join(estate, file)), { recursive: true })
    writeFileSync(join(estate, file), spell(lines.join('\n') + '\n'))
  }
  const got = flagPlaces(estate, planted.map(p => p.file), new Set(['MERCURY_PLANT_A', 'MERCURY_PLANT_B']))
  rmSync(estate, { recursive: true, force: true })
  const seen = got.places.map(p => `${p.file}:${p.line}`).join(' ')
  const want = planted.flatMap(p => p.named.map(n => `${p.file}:${n}`)).join(' ')
  const at = (line: number): Place | undefined => got.places.find(p => p.file === FORMS && p.line === line)
  const forms = (lines: number[], form: string): boolean => lines.every(line => at(line)?.form === form)
  check('a read by member, by key, through a constant of the file, through a constant another file exports and through that export renamed is named, each with its flag', forms([3], 'member') && forms([4, 5, 6, 7], 'key') && [3, 4, 5, 6].every(line => at(line)?.flag === 'MERCURY_PLANT_A') && at(7)?.flag === 'MERCURY_PLANT_B', `seen ${seen}`)
  check('a read through a constant that holds the environment, a parameter that defaults to it, a typed parameter, a member of an object, an optional chain and globalThis is named', forms([9, 10, 12, 13, 14], 'member') && forms([11], 'key'), `seen ${seen}`)
  check('a destructure (plain, renamed, in a parameter), an in test, a write (plain and compound), a delete (by member and by key), a reflection (three spellings) and a helper that reads by the name it is handed are named', forms([15, 16, 17], 'destructure') && forms([18], 'in') && forms([19, 20], 'write') && forms([21, 22], 'delete') && forms([23, 24, 25], 'reflection') && forms([27], 'helper'), `seen ${seen}`)
  check('each planted place is named with its line and nothing else is: a .tsx file and a payload are read too, and the door, a row file, a read through the door, a flag with no row, a platform variable, a name in a list, a sentence, the key of an object literal, a label and a lookup of a table are not named', seen === want, `seen ${seen} · want ${want}`)
  check(
    'each place is told the verb that fits: flagEnv with the name, and with the environment where it is not the process, setFlagEnv, stampFlagEnv or stampFlagOnEnv for a write, deleteFlagEnv or flagSpellings for a delete',
    at(3)?.say === "read it with flagEnv('MERCURY_PLANT_A')" &&
      at(10)?.say === "read it with flagEnv('MERCURY_PLANT_B', env)" &&
      at(12)?.say === "read it with flagEnv('MERCURY_PLANT_A', opts.env)" &&
      at(18)?.say === "test it with flagEnv('MERCURY_PLANT_A') !== undefined" &&
      at(19)?.say === "write it with setFlagEnv('MERCURY_PLANT_A', value), or with stampFlagEnv('MERCURY_PLANT_A', value) where the write is not the session's own stamp" &&
      at(20)?.say === "write it with stampFlagOnEnv(env, 'MERCURY_PLANT_B', value)" &&
      at(21)?.say === "delete it with deleteFlagEnv('MERCURY_PLANT_A')" &&
      at(22)?.say === "delete it with for (const spelling of flagSpellings('MERCURY_PLANT_A')) delete env[spelling]" &&
      (at(27)?.say ?? '').startsWith('read reads the environment by the name it is handed'),
    got.places.filter(p => p.file === FORMS).map(p => `${p.line} ${p.say}`).join(' | '),
  )
  const payload = 'src/planted/payload.mjs'
  const screen = 'src/planted/Screen.tsx'
  const judged = judgeKept(got.places, [
    { file: payload, flag: 'MERCURY_PLANT_A', places: 1, why: 'a payload' },
    { file: screen, flag: 'MERCURY_PLANT_A', places: 2, why: 'one above what stands' },
    { file: FORMS, flag: 'MERCURY_PLANT_B', places: 1, why: 'one of six' },
  ])
  check(
    'a kept row excuses its places and no more, and a row above what stands is told to fall',
    !judged.unlisted.some(p => p.file === payload || p.file === screen) && judged.unlisted.length === got.places.length - 3 && judged.unlisted.filter(p => p.file === FORMS && p.flag === 'MERCURY_PLANT_B').length === 5 && judged.stale.length === 1 && (judged.stale[0] ?? '').startsWith(`${screen} MERCURY_PLANT_A: the row keeps 2 and 1 stand`),
    `unlisted ${judged.unlisted.length} of ${got.places.length} · stale ${judged.stale.join(' | ')}`,
  )
}

section('§4 the estate: no file under src but the door and the row files names a registered flag at the environment')
{
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'src'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean)
  const flags = new Set(FLAG_REGISTRY.map(row => row.env))
  const got = flagPlaces(ROOT, files, flags)
  const { unlisted, stale } = judgeKept(got.places, KEPT)
  const keptPlaces = KEPT.reduce((n, row) => n + row.places, 0)
  console.log(`  ${files.length} files under src · ${got.read} code files read (the door and its row files aside) · ${flags.size} registered flags · ${got.places.length} places name one at the environment past the door · ${got.places.length - unlisted.length} kept, each with its reason · ${unlisted.length} unlisted`)
  for (const row of KEPT) console.log(`    kept: ${row.file} ${row.flag} × ${row.places} — ${row.why}`)
  if (process.argv.includes('--list')) for (const p of got.places) console.log(['place', p.file, p.line, p.form, p.flag, p.say].join('\t'))
  check(
    `no file under src names a registered flag at the environment past the door (0 unlisted; out of reach: ${PAST_REACH})`,
    unlisted.length === 0,
    `${unlisted.length} found — ${THE_VERBS}; the kept list only falls:` + told(unlisted),
  )
  check('every kept row still holds its places (a row above what stands is lowered, and the count below with it)', stale.length === 0, stale.join(' · '))
  check(`the kept list holds ${KEPT_PLACES} places, each row once and with its reason`, keptPlaces === KEPT_PLACES && KEPT.every(row => row.why.trim().length > 0 && row.places > 0) && new Set(KEPT.map(row => `${row.file}\t${row.flag}`)).size === KEPT.length, `places ${keptPlaces}`)
}

console.log(failures === 0 ? '\nprove-flag-registry-readers: green' : `\nprove-flag-registry-readers: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
