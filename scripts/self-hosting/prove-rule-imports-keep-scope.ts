#!/usr/bin/env bun
import { join } from 'node:path'
import { checker, contentsOf, count, governs, openWorld } from './instructionWorld.ts'

const world = openWorld('rule-imports')
const { check, section, close } = checker()
const offered = (lines: string[]): string => `Rule files offered by description (not loaded; Read one when its description fits the work):\n${lines.join('\n')}`
const rules = {
  '.cursor/rules/a-always.mdc': '---\nalwaysApply: true\n---\nalways-needle\n',
  '.cursor/rules/b-scoped.mdc': '---\nglobs: src/**/*.ts\nalwaysApply: false\n---\nscoped-needle\n',
  '.cursor/rules/c-offered.mdc': '---\ndescription: How migrations are written\nalwaysApply: false\n---\noffered-body-needle\n',
  '.cursor/rules/d-manual.mdc': '---\nalwaysApply: false\n---\nmanual-needle\n',
  'src/a.ts': '\n',
  'src/b.ts': '\n',
  'docs/a.md': '\n',
}

try {
  section('one imported rule file keeps the scope its own tool gave it')
  const p1 = world.project({ ...rules, 'MERCURY.md': 'native-needle\n@.cursor/rules/b-scoped.mdc\n@.cursor/rules/a-always.mdc\n@.cursor/rules/c-offered.mdc\n@.cursor/rules/d-manual.mdc\n' })
  const rule = (root: string, name: string): string => join(root, '.cursor/rules', name)
  const d1 = world.drive(p1, { touch: [join(p1, 'docs/a.md'), join(p1, 'src/a.ts'), join(p1, 'src/b.ts')] })
  const expected1 = [
    contentsOf(join(p1, 'MERCURY.md'), 'native-needle\n@.cursor/rules/b-scoped.mdc\n@.cursor/rules/a-always.mdc\n@.cursor/rules/c-offered.mdc\n@.cursor/rules/d-manual.mdc'),
    contentsOf(rule(p1, 'a-always.mdc'), 'always-needle'),
    contentsOf(rule(p1, 'd-manual.mdc'), 'manual-needle'),
    offered([`- ${rule(p1, 'c-offered.mdc')}: How migrations are written`]),
  ].join('\n\n')
  check('an always rule and a manual rule named by an import come in whole, an offered one as its pointer, a scoped one not at all', d1.first === expected1, d1.first)
  check('the imported entries ride the import chain of MERCURY.md', d1.entries.filter(e => e.path !== join(p1, 'MERCURY.md')).every(e => e.parent === join(p1, 'MERCURY.md')), JSON.stringify(d1.entries))
  check('a file its patterns do not name attaches nothing', d1.touched[0]!.attached.length === 0, JSON.stringify(d1.touched[0]))
  check('a matching file attaches the scoped rule, saying what it governs', d1.touched[1]!.attached.length === 1 && d1.touched[1]!.attached[0]!.told.includes(governs(rule(p1, 'b-scoped.mdc'), 'src/**/*.ts', 'scoped-needle')), JSON.stringify(d1.touched[1]))
  check('and once', d1.touched[2]!.attached.length === 0, JSON.stringify(d1.touched[2]))

  section('a rules folder named by one import: every rule in it keeps its own scope')
  const p2 = world.project({ ...rules, 'MERCURY.md': 'native-needle\n@.cursor/rules\n' })
  const d2 = world.drive(p2, { touch: [join(p2, 'docs/a.md'), join(p2, 'src/a.ts')] })
  const expected2 = [
    contentsOf(join(p2, 'MERCURY.md'), 'native-needle\n@.cursor/rules'),
    contentsOf(rule(p2, 'a-always.mdc'), 'always-needle'),
    offered([`- ${rule(p2, 'c-offered.mdc')}: How migrations are written`]),
  ].join('\n\n')
  check('the always rule comes in whole, the offered one as its pointer, the manual one stays manual', d2.first === expected2, d2.first)
  check('no directory complaint is raised for a rules folder', !d2.diagnostics.some(d => d.kind === 'import-target-is-directory'), JSON.stringify(d2.diagnostics))
  check('the scoped rule attaches on a matching file and not on another', d2.touched[0]!.attached.length === 0 && d2.touched[1]!.attached.length === 1 && d2.touched[1]!.attached[0]!.told.includes(governs(rule(p2, 'b-scoped.mdc'), 'src/**/*.ts', 'scoped-needle')), JSON.stringify(d2.touched))
  const p2b = world.project({ ...rules, 'MERCURY.md': 'native-needle\n@.cursor/rules/\n' })
  check('the folder may be written with its closing slash', world.drive(p2b).first.includes(contentsOf(rule(p2b, 'a-always.mdc'), 'always-needle')))

  section('the folders of the other tools and the files that stand alone import the same way')
  const p3 = world.project({
    'MERCURY.md': 'native-needle\n@.github/instructions\n@.clinerules\n@.windsurf/rules\n@.cursorrules\n@.github/copilot-instructions.md\n',
    '.github/instructions/py.instructions.md': '---\napplyTo: "**/*.py"\n---\ncopilot-scoped-needle\n',
    '.clinerules/general.md': 'cline-always-needle\n',
    '.clinerules/api.md': '---\npaths:\n  - "api/**"\n---\ncline-scoped-needle\n',
    '.windsurf/rules/style.md': '---\ntrigger: glob\nglobs: web/**\n---\nwindsurf-scoped-needle\n',
    '.cursorrules': 'legacy-needle\n',
    '.github/copilot-instructions.md': 'repository-guide-needle\n',
    'tool/run.py': '\n',
    'api/h.go': '\n',
    'web/a.css': '\n',
  })
  const d3 = world.drive(p3, { touch: [join(p3, 'tool/run.py'), join(p3, 'api/h.go'), join(p3, 'web/a.css')] })
  check('the always rule, the legacy file and the guide come in whole', ['cline-always-needle', 'legacy-needle', 'repository-guide-needle'].every(needle => count(d3.first, needle) === 1), d3.first)
  check('no scoped rule is in the first request', !/copilot-scoped-needle|cline-scoped-needle|windsurf-scoped-needle/.test(d3.first), d3.first)
  check('each scoped rule attaches on its own files, matched from the folder that owns its tool folder', d3.touched[0]!.attached.map(a => a.path).join() === join(p3, '.github/instructions/py.instructions.md') && d3.touched[1]!.attached.map(a => a.path).join() === join(p3, '.clinerules/api.md') && d3.touched[2]!.attached.map(a => a.path).join() === join(p3, '.windsurf/rules/style.md'), JSON.stringify(d3.touched))

  section('what stays as it is')
  const p4 = world.project({
    'MERCURY.md': 'native-needle\n@docs\n@notes/scoped.md\n',
    'docs/readme.md': 'docs-needle\n',
    'notes/scoped.md': '---\npaths: src/**\n---\nnative-shaped-needle\n',
  })
  const d4 = world.drive(p4)
  check('a folder no adapter knows as a rules folder keeps the directory line', d4.diagnostics.some(d => d.kind === 'import-target-is-directory' && d.path === join(p4, 'docs')), JSON.stringify(d4.diagnostics))
  check('an imported file that is no rule of another tool comes in whole, as before', d4.first.includes('native-shaped-needle'), d4.first)
  const p4b = world.project({ ...rules, 'app/MERCURY.md': 'nested-native-needle\n@../.cursor/rules/b-scoped.mdc\n', 'app/x.go': '\n', 'README.md': 'x\n' })
  const d4b = world.drive(p4b, { touch: [join(p4b, 'app/x.go'), join(p4b, 'src/a.ts')] })
  check('a nested guide that imports a scoped rule brings the guide in and not the rule, for a file the rule does not name', JSON.stringify(d4b.touched[0]!.attached.map(a => a.path)) === JSON.stringify([join(p4b, 'app/MERCURY.md')]), JSON.stringify(d4b.touched[0]))
} finally {
  world.close()
}
close('rule-imports-keep-scope')
