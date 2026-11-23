import '../lib/hermetic.js'
import { strict as assert } from 'node:assert'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { proofHome } from '../lib/hermetic.js'
import { conventionsForProfile } from '../../src/sessions/instructions/instructionFiles.js'
import { adapterForProfile } from '../../src/sessions/instructions/adapters/index.js'
import { mercuryNativeConvention } from '../../src/sessions/instructions/nativeSource.js'
import { measureEffectiveProjectInstructionLines } from '../../src/sessions/instructions/effectiveSize.js'
import { captureProjectInstruction, followPointerLaw } from '../../src/sessions/instructions/projectInstructionWriter.js'

const ids = (profile: 'auto' | 'native') => conventionsForProfile(profile).map(convention => convention.id)
assert.deepEqual(ids('native'), ['mercury-native'], 'the native profile must compose mercury-native alone; fix conventionsForProfile in src/sessions/instructions/compositionOrder.ts')
assert.deepEqual(ids('auto'), ['mercury-native', 'agents-md', 'agent-folders', 'claude', 'gemini', 'copilot', 'cursor', 'windsurf', 'cline'], 'the auto profile must compose mercury-native first, then the other conventions in this order; fix conventionsForProfile in src/sessions/instructions/compositionOrder.ts')
for (const profile of ['native', 'auto'] as const) {
  assert.deepEqual(adapterForProfile().conventionsFor(profile), conventionsForProfile(profile), 'adapterForProfile().conventionsFor must return the same table as conventionsForProfile; fix src/sessions/instructions/adapters/index.ts')
}
console.log('[PASS] native composition is first and every original adapter entry point still reads the same table')

const root = join(proofHome, 'estate')
mkdirSync(root)
const entry = join(root, 'MERCURY.md')
const guide = join(root, 'GUIDE.md')
writeFileSync(entry, '# MERCURY.md\n@GUIDE.md\n')
writeFileSync(guide, '# Guide\n- Keep existing keys.\n')
const before = readFileSync(entry, 'utf8')
assert.equal(followPointerLaw(entry, root).targetPath, guide, 'followPointerLaw must resolve the @GUIDE.md pointer in MERCURY.md to GUIDE.md; fix followPointerLaw in src/sessions/instructions/projectInstructionWriter.ts')
const result = captureProjectInstruction({ cwd: root, rule: 'Keep existing words.' })
assert.equal(result.action, 'recorded', 'a new rule must be recorded; fix captureProjectInstruction in src/sessions/instructions/projectInstructionWriter.ts')
assert.equal(result.path, guide, 'the rule must be written to the pointed guide, not the entry; fix captureProjectInstruction in src/sessions/instructions/projectInstructionWriter.ts')
assert.equal(readFileSync(entry, 'utf8'), before, 'capture must leave the MERCURY.md entry bytes unchanged; fix captureProjectInstruction in src/sessions/instructions/projectInstructionWriter.ts')
assert.match(readFileSync(guide, 'utf8'), /- Keep existing words\./, 'the guide must gain the line - Keep existing words.; fix captureProjectInstruction in src/sessions/instructions/projectInstructionWriter.ts')
assert.equal(captureProjectInstruction({ cwd: root, rule: 'Keep existing words.' }).action, 'already-recorded', 'a rule already in the guide must report already-recorded; fix captureProjectInstruction in src/sessions/instructions/projectInstructionWriter.ts')
console.log('[PASS] capture follows the native pointer, preserves the entry bytes and deduplicates in the pointed guide')

assert.equal(measureEffectiveProjectInstructionLines([
  { path: entry, type: 'Project', content: before },
  { path: guide, type: 'Project', parent: entry, content: readFileSync(guide, 'utf8') },
  { path: join(root, '.mercury/rules/rule.md'), type: 'Project', content: 'A rule does not count as guide weight.' },
]), 5, 'the effective size must count the entry and its imported guide (5 lines) and not a .mercury/rules file; fix measureEffectiveProjectInstructionLines in src/sessions/instructions/effectiveSize.ts')
console.log('[PASS] effective size measures the native entry and its import closure, not a rules or state directory')

console.log('prove-native-entry-road: all green')
