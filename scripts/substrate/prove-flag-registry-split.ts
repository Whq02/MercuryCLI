#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { flagRegistryFiles, isFlagRegistryFile } from '../lib/flagRegistrySource.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const SELF = relative(ROOT, import.meta.path).replaceAll('\\', '/')
const DOOR = flagRegistryFiles(ROOT)[0] ?? ''
const ROWS = `${posix.dirname(DOOR)}/flags`
const TYPES = `${ROWS}/spec.ts`
const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/
const NAMED = new RegExp(`['"\`/\\\\]${posix.basename(ROWS)}['"\`/\\\\]`)

const AREAS: Record<string, string> = {
  'src/cli/handlers/auth.ts': 'accounts.ts',
  'src/commands/login/': 'accounts.ts',
  'src/commands/logout/': 'accounts.ts',
  'src/constants/oauth.ts': 'accounts.ts',
  'src/services/oauth/': 'accounts.ts',
  'src/utils/auth.ts': 'accounts.ts',
  'src/utils/authFileDescriptor.ts': 'accounts.ts',
  'src/utils/secureStorage/': 'accounts.ts',
  'src/query/': 'api.ts',
  'src/services/anthropicLimits.ts': 'api.ts',
  'src/services/api/': 'api.ts',
  'src/services/capFailover.ts': 'api.ts',
  'src/services/mockRateLimits.ts': 'api.ts',
  'src/services/vcr.ts': 'api.ts',
  'src/utils/cache/': 'api.ts',
  'src/utils/envValidation.ts': 'api.ts',
  'src/utils/http.ts': 'api.ts',
  'src/utils/mtls.ts': 'api.ts',
  'src/utils/proxy.ts': 'api.ts',
  'assets/splash/': 'boot.ts',
  'scripts/release/': 'boot.ts',
  'src/bootstrap/': 'boot.ts',
  'src/main.tsx': 'boot.ts',
  'src/services/privateChannel/': 'boot.ts',
  'src/substrate/durablePublish.ts': 'boot.ts',
  'src/substrate/envStamps.ts': 'boot.ts',
  'src/substrate/identity/': 'boot.ts',
  'src/substrate/splashHandover.ts': 'boot.ts',
  'src/substrate/startupMenu.ts': 'boot.ts',
  'src/utils/envUtils.ts': 'boot.ts',
  'src/services/agentNeedsYou.ts': 'cockpit.ts',
  'src/utils/cockpit/': 'cockpit.ts',
  'src/constants/localPromptProfile.ts': 'context.ts',
  'src/prompt/': 'context.ts',
  'src/rows/': 'context.ts',
  'src/services/compact/': 'context.ts',
  'src/services/instructions/': 'context.ts',
  'src/services/run/': 'context.ts',
  'src/utils/antiSycophancy.ts': 'context.ts',
  'src/commands/daemon/': 'daemon.ts',
  'src/daemon/': 'daemon.ts',
  'src/services/engine-connector/': 'daemon.ts',
  'src/services/saturn/': 'daemon.ts',
  'src/services/switchboard/': 'daemon.ts',
  'src/utils/daemonBreaker.ts': 'daemon.ts',
  'src/services/browser/': 'desktop.ts',
  'src/services/desktop/': 'desktop.ts',
  'src/services/voice/': 'desktop.ts',
  'src/tools/BrowserTool/': 'desktop.ts',
  'src/tools/ComputerTool/': 'desktop.ts',
  'src/commands/feedback/': 'health.ts',
  'src/commands/health/': 'health.ts',
  'src/utils/flux/': 'health.ts',
  'src/utils/healthFix.ts': 'health.ts',
  'src/utils/healthPreflight.ts': 'health.ts',
  'src/utils/healthReport.ts': 'health.ts',
  'src/utils/log.ts': 'health.ts',
  'src/utils/observability/': 'health.ts',
  'src/utils/startupProfiler.ts': 'health.ts',
  'src/utils/submitTrace.ts': 'health.ts',
  'assets/vulcan/': 'ide.ts',
  'src/services/aseprite/': 'ide.ts',
  'src/services/dap/': 'ide.ts',
  'src/services/ide/': 'ide.ts',
  'src/services/lsp/': 'ide.ts',
  'src/services/vulcan/': 'ide.ts',
  'src/utils/blender/': 'ide.ts',
  'src/utils/unity/': 'ide.ts',
  'src/utils/vulcan/': 'ide.ts',
  'src/extensions/': 'mcp.ts',
  'src/services/mcp/': 'mcp.ts',
  'src/skills/': 'mcp.ts',
  'src/utils/hooks/': 'mcp.ts',
  'src/utils/mcpValidation.ts': 'mcp.ts',
  'src/services/capacity/': 'model.ts',
  'src/utils/effort.ts': 'model.ts',
  'src/utils/model/': 'model.ts',
  'src/utils/thinking.ts': 'model.ts',
  'src/guards/': 'permissions.ts',
  'src/utils/permissions/': 'permissions.ts',
  'src/utils/privacyLevel.ts': 'permissions.ts',
  'src/utils/spawnLedger.ts': 'permissions.ts',
  'src/utils/subprocessEnv.ts': 'permissions.ts',
  'src/services/changeTransaction/': 'project.ts',
  'src/services/crew/': 'project.ts',
  'src/services/gitGraph/': 'project.ts',
  'src/services/journeys/': 'project.ts',
  'src/services/mission/': 'project.ts',
  'src/services/projectIntel/': 'project.ts',
  'src/services/projectServices/': 'project.ts',
  'src/services/repoHost/': 'project.ts',
  'src/services/resources/': 'project.ts',
  'src/services/samples/': 'project.ts',
  'src/services/structure/': 'project.ts',
  'src/services/workbench/': 'project.ts',
  'src/utils/artifacts/': 'project.ts',
  'src/utils/verification/': 'project.ts',
  'src/utils/worktreeClone.ts': 'project.ts',
  'scripts/': 'proofs.ts',
  'src/utils/proofHomeGuard.ts': 'proofs.ts',
  'src/services/host/': 'providers.ts',
  'src/services/providers/': 'providers.ts',
  'src/components/': 'screen.ts',
  'src/constants/spinnerVerbs.ts': 'screen.ts',
  'src/context/': 'screen.ts',
  'src/ink/': 'screen.ts',
  'src/interactiveHelpers.tsx': 'screen.ts',
  'src/screens/': 'screen.ts',
  'src/services/visual/': 'screen.ts',
  'src/utils/clipboardFile.ts': 'screen.ts',
  'src/utils/fullscreen.ts': 'screen.ts',
  'src/utils/imagePaste.ts': 'screen.ts',
  'src/utils/logoV2Utils.ts': 'screen.ts',
  'src/utils/mercuryTokens.ts': 'screen.ts',
  'src/utils/promptEditor.ts': 'screen.ts',
  'src/utils/runtime/': 'screen.ts',
  'src/utils/terminalHandback.ts': 'screen.ts',
  'src/utils/theme.ts': 'screen.ts',
  'src/': 'session.ts',
  'src/services/eval/': 'tools.ts',
  'src/services/jev/': 'tools.ts',
  'src/services/search/': 'tools.ts',
  'src/tools.ts': 'tools.ts',
  'src/tools/': 'tools.ts',
  'src/utils/glob.ts': 'tools.ts',
  'src/utils/ripgrep.ts': 'tools.ts',
  'src/utils/shell/': 'tools.ts',
  'src/utils/timeouts.ts': 'tools.ts',
  'src/utils/toolSearch.ts': 'tools.ts',
  'src/utils/windowsPaths.ts': 'tools.ts',
}

type Row = { env: string; consumer: string }
type Kind = 'tree' | 'exports' | 'door-row' | 'not-gathered' | 'file-order' | 'two-files' | 'no-prefix' | 'wrong-file' | 'registry-order' | 'outside-import'
type Fault = { kind: Kind; text: string }
type Reading = { faults: Fault[]; rows: number; files: [string, number][]; walked: number; parsed: number }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

const isRows = (value: unknown): value is Row[] =>
  Array.isArray(value) && value.every(row => typeof row === 'object' && row !== null && typeof (row as Row).env === 'string' && typeof (row as Row).consumer === 'string')
const underRows = (rel: string): boolean => rel === ROWS || (rel !== DOOR && isFlagRegistryFile(rel))
const holds = (path: string, folder: string): boolean => `/${path}/`.includes(`/${folder}/`)

function walk(root: string, rel: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(root, `${rel}/${entry.name}`, out)
    } else if (entry.isFile() && CODE.test(entry.name)) out.push(`${rel}/${entry.name}`)
  }
}

function written(file: string, spec: string): string | null {
  const path = spec.replaceAll('\\', '/')
  if (path.startsWith('.')) {
    const target = posix.normalize(posix.join(posix.dirname(file), path))
    return underRows(target) ? target : null
  }
  return holds(posix.normalize(path), ROWS) ? path : null
}

function computed(file: string, at: ts.Node): string | null {
  const parts: string[] = []
  const gather = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) parts.push(node.text.replaceAll('\\', '/'))
    ts.forEachChild(node, gather)
  }
  gather(at)
  const below = ROWS.slice(ROWS.indexOf('/') + 1)
  for (const part of [...parts, parts.join('/')]) {
    if (part.startsWith('.') && underRows(posix.normalize(posix.join(posix.dirname(file), part)))) return `a path built from '${part}'`
    const path = posix.normalize(part)
    if (holds(path, ROWS) || holds(path, below)) return `a path built from '${part}'`
  }
  return null
}

function rowImports(file: string, text: string): { line: number; what: string }[] {
  const kind = /\.(?:tsx|jsx)$/.test(file) ? ts.ScriptKind.TSX : /\.(?:js|mjs|cjs)$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind)
  const out: { line: number; what: string }[] = []
  const site = (at: ts.Node): void => {
    const what = ts.isStringLiteralLike(at) ? written(file, at.text) : computed(file, at)
    if (what !== null) out.push({ line: source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1, what })
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) site(node.moduleSpecifier)
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) site(node.moduleReference.expression)
    else if (ts.isImportTypeNode(node)) site(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : node.argument)
    else if (ts.isCallExpression(node) && node.arguments[0] !== undefined && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) site(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

async function judge(root: string, areas: Record<string, string>): Promise<Reading> {
  const faults: Fault[] = []
  const fault = (kind: Kind, text: string): void => {
    faults.push({ kind, text })
  }
  const load = async (rel: string): Promise<Record<string, unknown> | null> => {
    try {
      return (await import(pathToFileURL(join(root, rel)).href)) as Record<string, unknown>
    } catch (error) {
      fault('tree', `${rel} does not load: ${(error instanceof Error ? error.message : String(error)).split('\n')[0]}`)
      return null
    }
  }

  const listed = flagRegistryFiles(root)
  let registry: Row[] = []
  if (!listed.includes(DOOR)) fault('tree', `${DOOR} is missing`)
  else {
    const door = await load(DOOR)
    if (door !== null && isRows(door['FLAG_REGISTRY'])) registry = door['FLAG_REGISTRY']
    else if (door !== null) fault('tree', `${DOOR} exports no FLAG_REGISTRY array of rows`)
  }

  const held: { file: string; rows: Row[] }[] = []
  for (const file of listed) {
    if (file === DOOR) continue
    if (posix.basename(file).startsWith('.') || !CODE.test(file)) continue
    const mod = await load(file)
    if (mod === null) continue
    const names = Object.keys(mod)
    if (file === TYPES) {
      if (names.length > 0) fault('exports', `${file} exports ${names.join(', ')}: it holds the types and exports no value`)
      continue
    }
    const arrays = names.map(name => mod[name]).filter(isRows)
    if (names.length !== 1 || arrays.length !== 1) fault('exports', `${file} has ${names.length} exports${names.length > 0 ? ` (${names.join(', ')})` : ''}: a file under ${ROWS} has one export, an array of rows`)
    held.push({ file, rows: arrays.flat() })
  }

  const exported = new Set(held.flatMap(h => h.rows))
  const gathered = new Set(registry)
  for (const row of registry) {
    if (!exported.has(row)) fault('door-row', `${row.env} is a row of the registry and of no file under ${ROWS}: write it in the file its consumer maps to, not in ${DOOR}`)
  }
  for (const { file, rows } of held) {
    const loose = rows.filter(row => !gathered.has(row))
    if (loose.length > 0) fault('not-gathered', `${file} exports ${loose.length === 1 ? 'a row' : `${loose.length} rows`} the registry does not hold (${loose.slice(0, 3).map(row => row.env).join(', ')}${loose.length > 3 ? ', …' : ''}): gather its array in ${DOOR}`)
  }

  const table = Object.entries(areas)
  const stands = new Map<string, string>()
  for (const { file, rows } of held) {
    rows.forEach((row, i) => {
      const before = rows[i - 1]
      if (before !== undefined && !(before.env < row.env)) fault('file-order', `${file}: ${row.env} stands after ${before.env}: the rows of a file ascend by env`)
      const other = stands.get(row.env)
      if (other !== undefined && other !== file) fault('two-files', `${row.env} stands in ${other} and in ${file}: an env has one row, in the file its consumer maps to`)
      stands.set(row.env, file)
      let best: [string, string] | undefined
      for (const entry of table) if (row.consumer.startsWith(entry[0]) && (best === undefined || entry[0].length > best[0].length)) best = entry
      if (best === undefined) fault('no-prefix', `${row.env} in ${file}: no prefix of AREAS in ${SELF} covers its consumer '${row.consumer}': add the prefix there, beside the file that holds the row`)
      else if (`${ROWS}/${best[1]}` !== file) fault('wrong-file', `${row.env} sits in ${file}: its consumer '${row.consumer}' maps to ${ROWS}/${best[1]} by the prefix '${best[0]}' of AREAS in ${SELF}: move the row there`)
    })
  }

  registry.forEach((row, i) => {
    const before = registry[i - 1]
    if (before !== undefined && !(before.env < row.env)) fault('registry-order', `FLAG_REGISTRY: ${row.env} stands after ${before.env}: ${DOOR} sorts the gathered rows by env`)
  })

  const files: string[] = []
  walk(root, 'src', files)
  walk(root, 'scripts', files)
  let parsed = 0
  for (const file of files) {
    if (file === SELF || isFlagRegistryFile(file)) continue
    const text = readFileSync(join(root, file), 'utf8')
    if (!NAMED.test(text)) continue
    parsed++
    for (const hit of rowImports(file, text)) fault('outside-import', `${file}:${hit.line} imports ${hit.what}: import from ${DOOR}`)
  }

  return { faults, rows: registry.length, files: held.map(h => [h.file, h.rows.length]), walked: files.length, parsed }
}

const kinds = (faults: Fault[]): string => faults.map(f => f.kind).join(' ')
const texts = (faults: Fault[]): string => faults.map(f => f.text).join(' | ')
const say = (faults: Fault[]): string => `${faults.length} found:` + faults.slice(0, 12).map(f => `\n      ${f.text}`).join('') + (faults.length > 12 ? `\n      … and ${faults.length - 12} more` : '')

section('§0 the checks on a planted tree: a tree with nothing wrong reads clean, and each fault is named')
{
  const A = `${ROWS}/a.ts`
  const B = `${ROWS}/b.ts`
  const C = `${ROWS}/c.ts`
  const PLANTED: Record<string, string> = { 'src/a/': 'a.ts', 'src/a/deep/': 'b.ts', 'src/b/': 'b.ts', 'src/c/': 'c.ts' }
  const spec = (from: string, to: string): string => {
    const path = posix.relative(posix.dirname(from), to)
    return path.startsWith('.') ? path : `./${path}`
  }
  const js = (file: string): string => file.replace(/\.ts$/, '.js')
  const rowsFile = (name: string, rows: [string, string][]): string =>
    [`import type { FlagSpec } from '${spec(A, js(TYPES))}'`, '', `export const ${name}: readonly FlagSpec[] = [`, ...rows.map(([env, consumer]) => `  { env: '${env}', consumer: '${consumer}' },`), ']', ''].join('\n')
  const doorFile = (names: string[], more = '', sorted = true): string =>
    [
      ...names.map(name => `import { ${name.toUpperCase()}_FLAGS } from '${spec(DOOR, `${ROWS}/${name}.js`)}'`),
      '',
      `export const FLAG_REGISTRY = [${names.map(name => `...${name.toUpperCase()}_FLAGS`).join(', ')}${more}]${sorted ? '.sort((a, b) => (a.env < b.env ? -1 : a.env > b.env ? 1 : 0))' : ''}`,
      '',
    ].join('\n')
  const CLEAN: Record<string, string> = {
    [DOOR]: doorFile(['a', 'b']),
    [TYPES]: 'export interface FlagSpec {\n  env: string\n  consumer: string\n}\n',
    [A]: rowsFile('A_FLAGS', [['ALPHA_ONE', 'src/a/one.ts'], ['ALPHA_TWO', 'src/a/two.ts (and a note)']]),
    [B]: rowsFile('B_FLAGS', [['BETA_ONE', 'src/b/one.ts'], ['BETA_TWO', 'src/a/deep/two.ts']]),
    'src/a/reader.ts': `import { FLAG_REGISTRY } from '${spec('src/a/reader.ts', js(DOOR))}'\nexport const count = FLAG_REGISTRY.length\n`,
    'src/a/flags/local.ts': 'export const local = 1\n',
    'src/a/user.ts': `import { local } from './flags/local.js'\nexport const twice = local * 2\n`,
    [SELF]: `const rows = await import('${spec(SELF, A)}')\nexport const seen = rows\n`,
    [`${ROWS}/.DS_Store`]: 'a leftover of the file manager\n',
    [`${ROWS}/notes.md`]: 'a note\n',
  }
  const planted = async (change: Record<string, string> = {}): Promise<Fault[]> => {
    const root = mkdtempSync(join(tmpdir(), 'flag-registry-split-'))
    try {
      for (const [rel, body] of Object.entries({ ...CLEAN, ...change })) {
        mkdirSync(dirname(join(root, rel)), { recursive: true })
        writeFileSync(join(root, rel), body)
      }
      return (await judge(root, PLANTED)).faults
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  check(`the helper lists the door and takes a file under ${ROWS} as a registry file`, DOOR !== '' && isFlagRegistryFile(TYPES) && !isFlagRegistryFile(`${ROWS}.ts`), `door '${DOOR}'`)

  const none = await planted()
  check('a tree with nothing wrong reads clean: the door, a file of the folder, this proof, an import of the door, a folder of the same name elsewhere and a leftover in the folder that is no code are let through', none.length === 0, texts(none))

  const doorRow = await planted({ [DOOR]: doorFile(['a', 'b'], `, { env: 'DOOR_ROW', consumer: 'src/a/late.ts' }`) })
  const BESIDE = `${posix.dirname(DOOR)}/more.ts`
  const beside = await planted({
    [BESIDE]: `export const MORE_FLAGS = [{ env: 'DELTA_ONE', consumer: 'src/a/more.ts' }]\n`,
    [DOOR]: `import { MORE_FLAGS } from '${spec(DOOR, js(BESIDE))}'\n${doorFile(['a', 'b'], ', ...MORE_FLAGS')}`,
  })
  check('a row written in the door is named, and so is a row the door gathers from a file beside the folder', kinds(doorRow) === 'door-row' && doorRow[0]!.text.startsWith('DOOR_ROW ') && kinds(beside) === 'door-row' && beside[0]!.text.startsWith('DELTA_ONE '), texts([...doorRow, ...beside]))

  const loose = await planted({ [C]: rowsFile('C_FLAGS', [['GAMMA_ONE', 'src/c/one.ts']]) })
  check('a file the door does not gather is named', kinds(loose) === 'not-gathered' && loose[0]!.text.startsWith(`${C} `) && loose[0]!.text.includes('GAMMA_ONE'), texts(loose))

  const from = (to: string): string => spec('src/a/forms.ts', to)
  const forms = [
    `import { A_FLAGS } from '${from(js(A))}'`,
    `import type { FlagSpec } from '${from(js(TYPES))}'`,
    `export { B_FLAGS } from '${from(js(B))}'`,
    `export * from '${from(js(B))}'`,
    `const late = await import('${from(js(A))}')`,
    `const old = require('${from(js(A))}')`,
    `type Spec = import('${from(js(TYPES))}').FlagSpec`,
    `import legacy = require('${from(js(A))}')`,
    `import whole from '${from(ROWS)}'`,
    `export const all: [FlagSpec?, Spec?] = [A_FLAGS, late, old, legacy, whole]`,
    '',
  ].join('\n')
  const built = [
    `import { join, resolve } from 'node:path'`,
    `const one = await import(join(ROOT, '${A}'))`,
    `const two = await import(join(SRC, '${ROWS.slice(ROWS.indexOf('/') + 1)}', 'b.ts'))`,
    `const three = await import(\`\${ROOT}/${ROWS}/\${name}.ts\`)`,
    `const four = require(resolve(ROOT, ${A.split('/').map(part => `'${part}'`).join(', ')}))`,
    `import { B_FLAGS } from '${js(B)}'`,
    `const door = await import(join(ROOT, '${DOOR}'))`,
    `const text = '${A}'`,
    `export const all = [one, two, three, four, B_FLAGS, door, text]`,
    '',
  ].join('\n')
  const outside = await planted({ 'src/a/forms.ts': forms, 'scripts/b/prove-built.ts': built })
  const at = (file: string): string => outside.filter(f => f.text.startsWith(`${file}:`)).map(f => f.text.slice(file.length + 1).split(' ')[0]).join(' ')
  check(
    'an outside import is named with its file and line in every form: import, import type, export from, export *, import(), require(), the import() type, import = require and the folder itself',
    at('src/a/forms.ts') === '1 2 3 4 5 6 7 8 9',
    texts(outside),
  )
  check(
    'an import whose path is computed is read by its literal parts and a bare path from the root as one; an import of the door and a string that is no import are not named',
    at('scripts/b/prove-built.ts') === '2 3 4 5 6',
    texts(outside),
  )
  check(`nothing else is named, and every one of them says to import from ${DOOR}`, outside.length === 14 && outside.every(f => f.kind === 'outside-import' && f.text.endsWith(`: import from ${DOOR}`)), texts(outside))

  const order = await planted({ [A]: rowsFile('A_FLAGS', [['ALPHA_TWO', 'src/a/two.ts'], ['ALPHA_ONE', 'src/a/one.ts']]) })
  check('a row out of order in its file is named', kinds(order) === 'file-order' && order[0]!.text.startsWith(`${A}: ALPHA_ONE stands after ALPHA_TWO`), texts(order))

  const unsorted = await planted({ [DOOR]: doorFile(['b', 'a'], '', false) })
  check('a registry out of order is named', kinds(unsorted) === 'registry-order' && unsorted[0]!.text.startsWith('FLAG_REGISTRY: ALPHA_ONE stands after BETA_TWO'), texts(unsorted))

  const stray = await planted({ [A]: rowsFile('A_FLAGS', [['ALPHA_ONE', 'src/a/one.ts'], ['ALPHA_STRAY', 'src/a/deep/stray.ts'], ['ALPHA_TWO', 'src/a/two.ts']]) })
  check('a row in the wrong file is named with the file its consumer maps to, the longest prefix winning', kinds(stray) === 'wrong-file' && stray[0]!.text.startsWith(`ALPHA_STRAY sits in ${A}`) && stray[0]!.text.includes(`maps to ${B} by the prefix 'src/a/deep/'`), texts(stray))

  const lost = await planted({ [A]: rowsFile('A_FLAGS', [['ALPHA_LOST', 'docs/lost.md'], ['ALPHA_ONE', 'src/a/one.ts'], ['ALPHA_TWO', 'src/a/two.ts']]) })
  check('a consumer no prefix covers is named with its row and the table', kinds(lost) === 'no-prefix' && lost[0]!.text.startsWith(`ALPHA_LOST in ${A}`) && lost[0]!.text.includes(`AREAS in ${SELF}`), texts(lost))

  const twice = await planted({ [B]: rowsFile('B_FLAGS', [['ALPHA_ONE', 'src/b/again.ts'], ['BETA_ONE', 'src/b/one.ts'], ['BETA_TWO', 'src/a/deep/two.ts']]) })
  check('an env in two files is named with both', kinds(twice) === 'two-files registry-order' && twice[0]!.text.startsWith(`ALPHA_ONE stands in ${A} and in ${B}`), texts(twice))

  const second = await planted({ [A]: `${CLEAN[A]}export const MORE = 1\n` })
  const valued = await planted({ [TYPES]: `${CLEAN[TYPES]}export const VALUE = 1\n` })
  check('a file with a second export and a types file that exports a value are named', kinds(second) === 'exports' && second[0]!.text.startsWith(`${A} has 2 exports`) && kinds(valued) === 'exports' && valued[0]!.text.startsWith(`${TYPES} exports VALUE`), texts([...second, ...valued]))
}

const real = await judge(ROOT, AREAS)
const found = (...want: Kind[]): Fault[] => real.faults.filter(f => want.includes(f.kind))

section(`§1 the cut: a row is written in a file under ${ROWS}, never in the door`)
{
  console.log(`  ${real.rows} rows in the registry · ${real.files.length} row files · rows written in the door: ${found('door-row').length}`)
  check('the registry loads, it holds rows, and the folder holds row files', found('tree').length === 0 && real.rows > 0 && real.files.length > 0, found('tree').length > 0 ? say(found('tree')) : `${real.rows} rows, ${real.files.length} row files under ${ROWS}`)
  check(`no row is written in ${DOOR}: every row of FLAG_REGISTRY is the row a file under ${ROWS} exports (0 written in the door)`, found('door-row').length === 0, say(found('door-row')))
  check('every row a file exports is in the registry', found('not-gathered').length === 0, say(found('not-gathered')))
}

section(`§2 the door: the rows are reached through ${DOOR}`)
{
  check(`no file under src or scripts imports a file under ${ROWS}, except the door, the files of that folder and this proof (${real.walked} files, ${real.parsed} read to their imports)`, found('outside-import').length === 0, say(found('outside-import')))
}

section('§3 the files: one export each, rows in order, each row in the file of its consumer')
{
  if (real.files.length > 0) console.log(`  ${real.files.map(([file, rows]) => `${posix.basename(file)} ${rows}`).join(' · ')}`)
  check(`each file has one export, an array of rows, and ${TYPES} exports no value`, found('exports').length === 0, say(found('exports')))
  check('the rows of each file ascend by env', found('file-order').length === 0, say(found('file-order')))
  check('no env stands in two files', found('two-files').length === 0, say(found('two-files')))
  check('every consumer is covered by a prefix of AREAS', found('no-prefix').length === 0, say(found('no-prefix')))
  check('each row sits in the file its consumer maps to, the longest prefix winning', found('wrong-file').length === 0, say(found('wrong-file')))
}

section('§4 the registry: its order is the order of env')
{
  check('FLAG_REGISTRY ascends by env', found('registry-order').length === 0, say(found('registry-order')))
}

console.log(failures === 0 ? '\nprove-flag-registry-split: green' : `\nprove-flag-registry-split: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
