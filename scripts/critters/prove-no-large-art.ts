import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import React from 'react'
import { CRITTERS, critterDefForKey, miniArtFor } from '../../src/utils/cockpit/critterData.js'
import { syntaxShape } from '../lib/codeText.ts'

const root = join(import.meta.dir, '..', '..')
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
let failures = 0
const check = (label: string, okay: boolean): void => {
  console.log(`${okay ? 'PASS' : 'FAIL'} ${label}`)
  if (!okay) failures++
}
const forbidden = {
  grids: /\b(?:CRAB|OCTOPUS|JELLYFISH|CLAM)_ART(?:_SLEEP)?\b/,
  form: /['"]art['"]/,
  fallback: /\bdef\.art\b/,
}
const data = read('src/utils/cockpit/critterData.ts')
const ast = ts.createSourceFile('critterData.ts', data, ts.ScriptTarget.Latest, true)
const forms = ast.statements.filter(ts.isTypeAliasDeclaration).filter(node => ['ArtForm', 'CoreArtForm'].includes(node.name.text))
check('no large grid declarations or bindings remain', !forbidden.grids.test(data))
check('the form types contain only current forms', forms.length === 2 && forms.every(node => {
  const members = ts.isUnionTypeNode(node.type) ? node.type.types : [node.type]
  const values = members.map(member => ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : '')
  const expected = node.name.text === 'ArtForm' ? ['mini', 'square'] : ['mini']
  return JSON.stringify(values) === JSON.stringify(expected)
}))
for (const path of ['src/components/mercury-ui/CritterArt.tsx', 'src/components/mercury-ui/AnimatedCritterArt.tsx']) {
  const source = read(path)
  check(`${path}: no retired form or grid fallback`, !forbidden.form.test(source) && !forbidden.fallback.test(source))
}
const snapshot = JSON.parse(read('scripts/critters/fixtures/retained-critter-grids.json')) as {
  base: string
  critters: Array<{ name: string; mini: string[]; squareDock: string[]; sleep: unknown }>
  dockPainterSha256: string
  dockEyeProofSha256: string
}
check('the retained-grid fixture names the verified base', snapshot.base === '5f210214fa7eddf68146fdbdeb9fefdf8ee15e96')
check('the retained-grid roster is complete', JSON.stringify(CRITTERS.map(d => d.name)) === JSON.stringify(snapshot.critters.map(d => d.name)))
for (const before of snapshot.critters) {
  const def = critterDefForKey(before.name)
  check(`${before.name}: dock unchanged cell for cell`, JSON.stringify(def.squareDock) === JSON.stringify(before.squareDock))
  check(`${before.name}: mini and its sleep pose unchanged cell for cell`, JSON.stringify(def.mini) === JSON.stringify(before.mini) && JSON.stringify(def.sleep.mini) === JSON.stringify(before.sleep))
}
const painter = read('src/components/mercury-ui/CritterArt.tsx')
check('the dock painter, eye fix and bottom-edge rule are token-identical', hash(syntaxShape('CritterArt.tsx', painter.slice(painter.indexOf('  const lines: React.ReactNode[] = []')))) === snapshot.dockPainterSha256)
const eye = read('scripts/critters/prove-critter-eye-ground.ts')
const largeSection = eye.indexOf("section('§3b")
const dockProof = largeSection < 0 ? eye : eye.slice(0, largeSection) + eye.slice(eye.indexOf("section('§4"))
check('every dock eye-ground proof section is byte-identical', hash(dockProof) === snapshot.dockEyeProofSha256)

const onboarding = read('src/components/Onboarding.tsx')
const source = ts.createSourceFile('Onboarding.tsx', onboarding, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const fitting = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'FittingMascot')
if (!fitting) throw new Error('FittingMascot declaration missing')
const body = ts.transpileModule(fitting.getText(source), { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const AnimatedCritterArt = () => null
for (const def of CRITTERS) {
  const mascot = new Function('React', 'useSessionAccent', 'critterDefForKey', 'miniArtFor', 'AnimatedCritterArt', `${body}; return FittingMascot`)(
    { ...React, useMemo: (factory: () => unknown) => factory() },
    () => ({ key: def.name }),
    critterDefForKey,
    miniArtFor,
    AnimatedCritterArt,
  ) as (props: { rows: number }) => React.ReactElement<{ specimen?: boolean; def: { name: string } }> | null
  for (const rows of [24, 29, 31, 32, 40, 51]) {
    const frame = mascot({ rows })
    check(`${def.name}: fitting at ${rows} rows ${rows < 29 ? 'keeps the lockup-only branch' : 'uses the mini specimen'}`,
      rows < 29 ? frame === null : frame?.type === AnimatedCritterArt && frame.props.specimen === true && frame.props.def.name === def.name)
  }
}
const scratch = mkdtempSync(join(tmpdir(), 'critter-fixture-recording-'))
try {
  const out = join(scratch, 'frames.json')
  const kept = ['mini', 'square'].map(form => ({ form, grid: ['historical-cells'], marker: 'keep historical provenance' }))
  const existing = { base: 'historical-base', frames: [...kept, { form: 'unknown-fixture-form', grid: ['discard'] }] }
  writeFileSync(out, JSON.stringify(existing))
  execFileSync(process.execPath, [join(root, 'scripts/critters/gen-zzz-frames.ts'), root, out], { cwd: root, env: process.env, stdio: 'pipe', windowsHide: true })
  check('the recorder prunes unknown forms without recomposing surviving rows or provenance',
    JSON.stringify(JSON.parse(readFileSync(out, 'utf8'))) === JSON.stringify({ ...existing, frames: kept }))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`NO-LARGE-ART ${failures === 0 ? 'GREEN' : 'RED'} — ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
