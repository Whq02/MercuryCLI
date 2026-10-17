import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { armScratch, check, cleanup, finish, openToolDoor, TS_SIDECAR_ENTRY, writeProject } from './lspProofDoor.ts'

const scratch = armScratch('lsp-implicit-project')
process.env.MERCURY_LSP_SIDECAR_ENTRY = TS_SIDECAR_ENTRY

const ESM: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'plain-js', private: true, type: 'module' }),
  'src/math.js': 'export function add(a, b) {\n  return a + b\n}\nexport function sub(a, b) {\n  return a - b\n}\n',
  'src/report.js': "import { add, sub } from './math.js'\nexport function buildTotalReport(items) {\n  return items.reduce((t, i) => add(t, i), 0) - sub(1, 1)\n}\n",
  'src/format.js': 'export function format(n) {\n  return `total: ${n}`\n}\n',
  'test/math.test.js': "import { sub } from '../src/math.js'\nif (sub(3, 1) !== 2) process.exit(1)\n",
  'node_modules/dep/index.js': "import { sub } from '../../src/math.js'\nexport const dep = sub\n",
}
const CJS: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'plain-cjs', private: true }),
  'src/math.js': 'function add(a, b) {\n  return a + b\n}\nfunction sub(a, b) {\n  return a - b\n}\nmodule.exports = { add, sub }\n',
  'src/report.js': "const { add, sub } = require('./math')\nfunction buildTotalReport(items) {\n  return items.reduce((t, i) => add(t, i), 0) - sub(1, 1)\n}\nmodule.exports = { buildTotalReport }\n",
  'test/math.test.js': "const { sub } = require('../src/math')\nif (sub(3, 1) !== 2) process.exit(1)\n",
}
const MONO: Record<string, string> = {
  'app/package.json': JSON.stringify({ name: 'app', private: true, type: 'module' }),
  'app/src/a.js': 'export function tally(rows) {\n  return rows.length\n}\n',
  'app/src/b.js': "import { tally } from './a.js'\nexport const count = tally([])\n",
  'other/c.js': 'export function tally(rows) {\n  return rows.length * 2\n}\n',
  'other/d.js': "import { tally } from './c.js'\nexport const twice = tally([])\n",
}

function positionOf(text: string, needle: string, occurrence = 0): { line: number; character: number } {
  let index = -1
  for (let i = 0; i <= occurrence; i++) index = text.indexOf(needle, index + 1)
  if (index === -1) throw new Error(`fixture drift: ${needle}`)
  const before = text.slice(0, index)
  return { line: before.split('\n').length, character: index - (before.lastIndexOf('\n') + 1) + 1 }
}
const files = (data: { edits?: Array<{ file: string; after: string }> } | null): string[] => [...new Set((data?.edits ?? []).map(edit => edit.file))].sort()
const runs = (script: string): boolean => {
  try {
    execFileSync(process.execPath, [script], { stdio: 'pipe', windowsHide: true })
    return true
  } catch {
    return false
  }
}

console.log('§1 a plain-JS project without a jsconfig: the rename reaches every importer, and the program still runs')
const project = writeProject(scratch, 'plain-js', ESM)
let door = await openToolDoor(project)
const math = join(project, 'src/math.js')
try {
  const rename = { filePath: math, ...positionOf(ESM['src/math.js']!, 'sub'), newName: 'subtract' }
  const preview = await door.driveNamed('LspRename', rename)
  check('the preview lists src/math.js, src/report.js and test/math.test.js (5 edits across 3 files)', !preview.isError && preview.data?.fileCount === 3 && preview.data?.edits?.length === 5 && /5 edits across 3 files/.test(preview.text), preview.text)
  check('the preview names the importer and the test by path', JSON.stringify(files(preview.data)) === JSON.stringify(['src/math.js', 'src/report.js', 'test/math.test.js']), JSON.stringify(files(preview.data)))
  check('node_modules is never part of the project', !files(preview.data).some(file => file.includes('node_modules')), JSON.stringify(files(preview.data)))
  const applied = await door.driveNamed('LspRename', { ...rename, apply: true, plan: preview.data?.plan })
  const texts = ['src/math.js', 'src/report.js', 'test/math.test.js'].map(rel => readFileSync(join(project, rel), 'utf8'))
  check('the apply edits all three files', !applied.isError && applied.data?.applied === true && texts.every(text => text.includes('subtract') && !/\bsub\b/.test(text)), applied.text)
  check('the renamed program still links (the test script exits 0)', runs(join(project, 'test/math.test.js')))
  check('src/format.js, which never named the symbol, is untouched', readFileSync(join(project, 'src/format.js'), 'utf8') === ESM['src/format.js'])

  console.log('§2 a file written after the project was listed joins it after the relist window (30 s)')
  writeFileSync(join(project, 'src/late.js'), "import { subtract } from './math.js'\nexport const late = subtract(2, 1)\n")
  const again = { filePath: math, ...positionOf(readFileSync(math, 'utf8'), 'subtract'), newName: 'minus' }
  const early = await door.driveNamed('LspRename', again)
  console.log(`        before the window the preview covers ${early.data?.fileCount ?? '?'} file(s)`)
  await new Promise(resolve => setTimeout(resolve, 31_000))
  const later = await door.driveNamed('LspRename', again)
  check('after the window the preview covers src/late.js too', !later.isError && files(later.data).includes('src/late.js') && later.data?.fileCount === 4, later.text)
} finally {
  await door.close()
}

console.log('§3 a CommonJS project: the export keeps its name from the declaration side; an importer-side rename renames the whole chain')
const cjs = writeProject(scratch, 'plain-cjs', CJS)
door = await openToolDoor(cjs)
try {
  const report = join(cjs, 'src/report.js')
  const chain = await door.driveNamed('LspRename', { filePath: report, ...positionOf(CJS['src/report.js']!, 'sub'), newName: 'subtract' })
  check('from the importer, the preview renames math.js, report.js and the test plainly (6 edits across 3 files)', !chain.isError && chain.data?.fileCount === 3 && chain.data?.edits?.length === 6 && (chain.data?.edits ?? []).every(edit => edit.after === 'subtract'), chain.text)
  const cjsMath = join(cjs, 'src/math.js')
  const local = { filePath: cjsMath, ...positionOf(CJS['src/math.js']!, 'sub'), newName: 'subtract' }
  const preview = await door.driveNamed('LspRename', local)
  const shorthand = (preview.data?.edits ?? []).find(edit => edit.after !== 'subtract')
  check('from the declaration, the shorthand export keeps its key: `{ add, sub: subtract }`', !preview.isError && preview.data?.fileCount === 1 && preview.data?.edits?.length === 2 && shorthand?.after === 'sub: subtract', preview.text)
  const applied = await door.driveNamed('LspRename', { ...local, apply: true, plan: preview.data?.plan })
  check('the apply leaves the importers as they were and the program still links', !applied.isError && readFileSync(cjsMath, 'utf8').includes('module.exports = { add, sub: subtract }') && readFileSync(report, 'utf8') === CJS['src/report.js'] && runs(join(cjs, 'test/math.test.js')), applied.text)
} finally {
  await door.close()
}

console.log('§4 the implicit root is the nearest package.json folder, never above the starting folder')
const mono = writeProject(scratch, 'mono', MONO)
writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'above-the-start', private: true, type: 'module' }))
writeFileSync(join(scratch, 'e.js'), "import { tally } from './mono/other/c.js'\nexport const outside = tally([])\n")
door = await openToolDoor(mono)
try {
  const a = join(mono, 'app/src/a.js')
  const inApp = await door.driveNamed('LspRename', { filePath: a, ...positionOf(MONO['app/src/a.js']!, 'tally'), newName: 'countRows' })
  check('a file under app/ (package.json) renames across app/ only', !inApp.isError && JSON.stringify(files(inApp.data)) === JSON.stringify(['app/src/a.js', 'app/src/b.js']), inApp.text)
  const c = join(mono, 'other/c.js')
  const atRoot = await door.driveNamed('LspRename', { filePath: c, ...positionOf(MONO['other/c.js']!, 'tally'), newName: 'countRows' })
  check('a file with no package.json below the starting folder renames across the starting folder, never the folder above it', !atRoot.isError && JSON.stringify(files(atRoot.data)) === JSON.stringify(['other/c.js', 'other/d.js']) && existsSync(join(scratch, 'e.js')), atRoot.text)
} finally {
  await door.close()
}

console.log('§5 a rename started at a consumer of a shorthand property moves the key and keeps the value (`{ subtract: sub }`); started at the declaration it keeps the key (`{ sub: subtract }`); the program runs either way')
const SHORTHAND: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'shorthand', private: true, type: 'module' }),
  'src/math.js': 'function sub(a, b) {\n  return a - b\n}\nexport const math = { sub }\n',
  'src/access.js': "import { math } from './math.js'\nexport const viaAccess = math.sub(3, 1)\n",
  'src/destructure.js': "import { math } from './math.js'\nconst { sub } = math\nexport const viaBinding = sub(3, 1)\n",
  'check.js': "import { viaAccess } from './src/access.js'\nimport { viaBinding } from './src/destructure.js'\nif (viaAccess !== 2 || viaBinding !== 2) process.exit(1)\n",
}
const consumers = join(scratch, 'consumers')
for (const name of ['a', 'b', 'c']) writeProject(consumers, name, SHORTHAND)
door = await openToolDoor(consumers)
try {
  const afterOf = (data: { edits?: Array<{ file: string; after: string }> } | null, file: string): string[] => (data?.edits ?? []).filter(edit => edit.file === file).map(edit => edit.after)
  const starts = [
    ['a', 'src/access.js', 'sub', 'a property access (math.sub)'],
    ['b', 'src/destructure.js', 'sub', 'a destructuring (const { sub } = math)'],
  ] as const
  for (const [name, rel, needle, label] of starts) {
    const root = join(consumers, name)
    const rename = { filePath: join(root, rel), ...positionOf(SHORTHAND[rel]!, needle), newName: 'subtract' }
    const preview = await door.driveNamed('LspRename', rename)
    check(`${label}: the shorthand declaration becomes \`subtract: sub\` — the key moves, the value stays`, !preview.isError && JSON.stringify(afterOf(preview.data, `${name}/src/math.js`)) === JSON.stringify(['subtract: sub']), preview.text)
    check(`${label}: both consumers follow the key (math.subtract; const { subtract } = math and its use)`, JSON.stringify(afterOf(preview.data, `${name}/src/access.js`)) === JSON.stringify(['subtract']) && JSON.stringify(afterOf(preview.data, `${name}/src/destructure.js`)) === JSON.stringify(['subtract', 'subtract']), preview.text)
    const applied = await door.driveNamed('LspRename', { ...rename, apply: true, plan: preview.data?.plan })
    const math = readFileSync(join(root, 'src/math.js'), 'utf8')
    check(`${label}: after the apply the function keeps its name and the program runs (no undeclared subtract)`, !applied.isError && /function sub\(/.test(math) && /export const math = \{ subtract: sub \}/.test(math) && runs(join(root, 'check.js')), `${applied.text}\n${math}`)
  }
  const decl = join(consumers, 'c')
  const fromDecl = { filePath: join(decl, 'src/math.js'), ...positionOf(SHORTHAND['src/math.js']!, 'sub'), newName: 'subtract' }
  const preview = await door.driveNamed('LspRename', fromDecl)
  check('the declaration-started control: the shorthand becomes `sub: subtract`, the consumers are untouched', !preview.isError && preview.data?.fileCount === 1 && JSON.stringify(afterOf(preview.data, 'c/src/math.js')) === JSON.stringify(['subtract', 'sub: subtract']), preview.text)
  const applied = await door.driveNamed('LspRename', { ...fromDecl, apply: true, plan: preview.data?.plan })
  check('the declaration-started control: the program runs after the apply', !applied.isError && /export const math = \{ sub: subtract \}/.test(readFileSync(join(decl, 'src/math.js'), 'utf8')) && runs(join(decl, 'check.js')), applied.text)
} finally {
  await door.close()
}

console.log('§6 a file in a sibling folder of the starting folder never roots its implicit project above the starting folder')
const ws = join(scratch, 'ws')
const app = writeProject(ws, 'app', { 'package.json': JSON.stringify({ name: 'app', private: true, type: 'module' }), 'index.js': 'export const app = 1\n' })
writeProject(ws, 'other', { 'c.js': 'export function tally(rows) {\n  return rows.length * 2\n}\n', 'd.js': "import { tally } from './c.js'\nexport const twice = tally([])\n" })
writeFileSync(join(ws, 'package.json'), JSON.stringify({ name: 'above-the-start', private: true, type: 'module' }))
writeFileSync(join(ws, 'e.js'), "import { tally } from './other/c.js'\nexport const outside = tally([])\n")
door = await openToolDoor(app)
try {
  const c = join(ws, 'other/c.js')
  const sibling = await door.driveNamed('LspRename', { filePath: c, ...positionOf('export function tally(rows) {\n  return rows.length * 2\n}\n', 'tally'), newName: 'countRows' })
  check('the rename from other/c.js covers other/ only — never the package.json folder that encloses the starting folder', !sibling.isError && JSON.stringify(files(sibling.data)) === JSON.stringify([join(ws, 'other/c.js'), join(ws, 'other/d.js')]), sibling.text)
} finally {
  await door.close()
  cleanup(scratch)
}
finish('prove-lsp-implicit-project')
