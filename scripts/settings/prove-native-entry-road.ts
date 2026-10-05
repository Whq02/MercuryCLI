import '../lib/hermetic.js'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { proofHome } from '../lib/hermetic.js'
import { conventionsForProfile } from '../../src/services/instructions/engine.js'
import { adapterForProfile } from '../../src/services/instructions/adapters/index.js'
import { mercuryNativeConvention } from '../../src/services/instructions/nativeSource.js'
import { measureEffectiveProjectInstructionLines } from '../../src/services/instructions/effectiveSize.js'
import { captureProjectInstruction, followPointerLaw } from '../../src/services/instructions/projectInstructionWriter.js'

const ids = (profile: 'auto' | 'native') => conventionsForProfile(profile).map(convention => convention.id)
assert.deepEqual(ids('native'), ['mercury-native'])
assert.deepEqual(ids('auto'), ['mercury-native', 'agents-md'])
for (const profile of ['native', 'auto'] as const) {
  assert.deepEqual(adapterForProfile().conventionsFor(profile), conventionsForProfile(profile))
}
console.log('[PASS] native composition is first and every original adapter entry point still reads the same table')

const root = join(proofHome, 'estate')
mkdirSync(root)
const entry = join(root, 'MERCURY.md')
const guide = join(root, 'GUIDE.md')
writeFileSync(entry, '# MERCURY.md\n@GUIDE.md\n')
writeFileSync(guide, '# Guide\n- Keep existing keys.\n')
const before = readFileSync(entry, 'utf8')
assert.equal(followPointerLaw(entry, root).targetPath, guide)
const result = captureProjectInstruction({ cwd: root, rule: 'Keep existing words.' })
assert.equal(result.action, 'recorded')
assert.equal(result.path, guide)
assert.equal(readFileSync(entry, 'utf8'), before)
assert.match(readFileSync(guide, 'utf8'), /- Keep existing words\./)
assert.equal(captureProjectInstruction({ cwd: root, rule: 'Keep existing words.' }).action, 'already-recorded')
console.log('[PASS] capture follows the native pointer, preserves the entry bytes and deduplicates in the pointed guide')

assert.equal(measureEffectiveProjectInstructionLines([
  { path: entry, type: 'Project', content: before },
  { path: guide, type: 'Project', parent: entry, content: readFileSync(guide, 'utf8') },
  { path: join(root, '.mercury/rules/rule.md'), type: 'Project', content: 'A rule does not count as guide weight.' },
]), 5)
console.log('[PASS] effective size measures the native entry and its import closure, not a rules or state directory')

const engine = readFileSync(join(import.meta.dir, '../../src/services/instructions/engine.ts'), 'utf8')
const writer = readFileSync(join(import.meta.dir, '../../src/services/instructions/projectInstructionWriter.ts'), 'utf8')
assert.match(engine, /import \{ conventionsForProfile \} from '\.\/compositionOrder\.js'/)
assert.match(writer, /import \{ mercuryNativeConvention \} from '\.\/nativeSource\.js'/)
console.log('[PASS] engine composition and convention capture use the native owner directly')
console.log('prove-native-entry-road: all green')
