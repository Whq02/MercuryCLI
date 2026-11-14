#!/usr/bin/env bun
import { join } from 'node:path'
import { checker, contentsOf, governs, openWorld, rulesBattery } from './instructionWorld.ts'

const world = openWorld('format-cursor')
const { check, section, close } = checker()
const always = (body: string): string => `---\ndescription: A rule that always applies\nglobs:\nalwaysApply: true\n---\n${body}`
const scoped = (patterns: string[], body: string): string => `---\ndescription:\nglobs: ${patterns.join(', ')}\nalwaysApply: false\n---\n${body}`

try {
  rulesBattery({ world, check, section, convention: 'cursor', folder: '.cursor/rules', ext: '.mdc', always, scoped })

  section('the three fields, as Cursor reads them')
  const p1 = world.project({
    '.cursor/rules/a-always-wins.mdc': '---\ndescription: described\nglobs: src/**\nalwaysApply: true\n---\nalways-wins-needle\n',
    '.cursor/rules/b-quoted-true.mdc': '---\nalwaysApply: "true"\n---\nquoted-true-needle\n',
    '.cursor/rules/c-manual.mdc': '---\nalwaysApply: false\n---\nmanual-needle\n',
    '.cursor/rules/d-no-header.mdc': 'no-header-needle\n',
    '.cursor/rules/e-list.mdc': '---\nglobs:\n  - "lib/**/*.ts"\n  - "lib/**/*.tsx"\nalwaysApply: false\n---\nlist-needle\n',
    '.cursor/rules/f-everything.mdc': '---\nglobs: "**/*"\nalwaysApply: false\n---\neverything-needle\n',
    '.cursor/rules/g-markdown.md': '---\nglobs: docs/**\n---\nmarkdown-scoped-needle\n',
    '.cursor/rules/h-plain.md': 'plain-markdown-needle\n',
    '.cursor/rules/i-broken.mdc': '---\ndescription: x\nglobs:\n  - a\n - b\nalwaysApply: true\n---\nbroken-header-needle\n',
    '.cursor/rules/j-body.mdc': '---\nalwaysApply: true\n---\nSee @templates/service.ts first.\n<!-- kept as written -->\n',
    'templates/service.ts': 'template-body-needle\n',
    'src/a.ts': '\n',
    'lib/ui/b.tsx': '\n',
    'docs/c.md': '\n',
  })
  const rules = (name: string): string => join(p1, '.cursor/rules', name)
  const d1 = world.drive(p1, { touch: [join(p1, 'src/a.ts'), join(p1, 'lib/ui/b.tsx'), join(p1, 'docs/c.md')] })
  check('alwaysApply: true wins over globs and a description: the rule is in the first request', d1.first.includes(contentsOf(rules('a-always-wins.mdc'), 'always-wins-needle')), d1.first)
  check('a quoted "true" is not the Boolean: with no other field the rule is manual and is not sent', !d1.first.includes('quoted-true-needle'), d1.first)
  check('alwaysApply: false with no globs and no description is a manual rule: not sent', !d1.first.includes('manual-needle'))
  check('a rule file with no header is a manual rule: not sent', !d1.first.includes('no-header-needle'))
  check('a pattern that names every file makes the rule always apply', d1.first.includes(contentsOf(rules('f-everything.mdc'), 'everything-needle')), d1.first)
  check('a YAML list of patterns scopes the rule to each', d1.touched[1]!.attached.some(a => a.told.includes(governs(rules('e-list.mdc'), 'lib/**/*.ts, lib/**/*.tsx', 'list-needle'))), JSON.stringify(d1.touched[1]))
  check('a .md file there is read by the same three fields', d1.touched[2]!.attached.some(a => a.told.includes(governs(rules('g-markdown.md'), 'docs/**', 'markdown-scoped-needle'))), JSON.stringify(d1.touched[2]))
  check('a plain .md there is a manual rule: not sent', !d1.first.includes('plain-markdown-needle'))
  check('a header that is not YAML keeps its rule out and is reported', !d1.first.includes('broken-header-needle') && d1.diagnostics.some(d => d.kind === 'unreadable-rule-header' && d.path === rules('i-broken.mdc')), JSON.stringify(d1.diagnostics))
  check('a rule body is sent as written: a file it mentions is not pulled in and a comment stays', d1.first.includes(contentsOf(rules('j-body.mdc'), 'See @templates/service.ts first.\n<!-- kept as written -->')) && !d1.first.includes('template-body-needle'), d1.first)
  check('no manual rule attaches when files are touched', d1.touched.every(touch => touch.attached.every(a => !/manual-needle|no-header-needle|quoted-true-needle|plain-markdown-needle|broken-header-needle/.test(a.told))), JSON.stringify(d1.touched))

  section('the legacy .cursorrules file')
  const p2 = world.project({ '.cursorrules': 'legacy-needle\nSee @docs/x.md\n', 'docs/x.md': 'mentioned-needle\n', 'sub/.cursorrules': 'nested-legacy-needle\n', 'sub/a.ts': '\n' })
  const legacy = join(p2, '.cursorrules')
  const d2 = world.drive(p2, { classify: [legacy], touch: [join(p2, 'sub/a.ts')] })
  check('it reaches the first request whole, as written', d2.first === contentsOf(legacy, 'legacy-needle\nSee @docs/x.md'), d2.first)
  check('it names its format and classifies as an instruction file', d2.entries.find(e => e.path === legacy)?.convention === 'cursor' && d2.classified[legacy] === true, JSON.stringify(d2.entries))
  check('it counts as the guide of its folder', JSON.stringify(d2.guides) === JSON.stringify([legacy]), JSON.stringify(d2.guides))
  check('a plain file shown whole counts as read in full', d2.seeded.includes(legacy), d2.seeded.join(', '))
  check('one in a nested folder attaches with its folder', JSON.stringify(d2.touched[0]!.attached.map(a => a.path)) === JSON.stringify([join(p2, 'sub/.cursorrules')]), JSON.stringify(d2.touched[0]))
  const p2b = world.project({ 'MERCURY.md': 'native-needle\n', '.cursorrules': 'legacy-needle\n' })
  check('MERCURY.md decides over it', world.drive(p2b).first === contentsOf(join(p2b, 'MERCURY.md'), 'native-needle'))

  section('beside AGENTS.md and with a rule of the same name in another folder')
  const p3 = world.project({
    'AGENTS.md': 'agents-needle\n',
    '.cursor/rules/style.mdc': always('root-style-needle\n'),
    '.cursor/rules/web/style.mdc': always('web-style-needle\n'),
  })
  const d3 = world.drive(p3)
  check('the guide and both rules of one name compose, AGENTS.md first', JSON.stringify(d3.paths) === JSON.stringify([join(p3, 'AGENTS.md'), join(p3, '.cursor/rules/style.mdc'), join(p3, '.cursor/rules/web/style.mdc')]), d3.paths.join(', '))

  section('a rule offered by its description: one pointer line, its body only when the model reads the file')
  const p4 = world.project({
    '.cursor/rules/a-always.mdc': always('always-needle\n'),
    '.cursor/rules/b-migrations.mdc': '---\ndescription: How to write and run database migrations\nalwaysApply: false\n---\noffered-body-needle\n',
    '.cursor/rules/c-services.mdc': '---\ndescription: |\n  Conventions for the RPC services\n  of the backend\nglobs:\nalwaysApply: false\n---\nsecond-offered-body-needle\n',
    'MERCURY.local.md': 'local-needle\n',
    'db/001.sql': '\n',
    'sub/.cursor/rules/nested.mdc': '---\ndescription: Nested folder conventions\n---\nnested-offered-body-needle\n',
    'sub/a.ts': '\n',
    'sub/b.ts': '\n',
  })
  const offered = (lines: string[]): string => `Rule files offered by description (not loaded; Read one when its description fits the work):\n${lines.join('\n')}`
  const inRules = (name: string): string => join(p4, '.cursor/rules', name)
  const d4 = world.drive(p4, { touch: [join(p4, 'db/001.sql'), join(p4, 'sub/a.ts'), join(p4, 'sub/b.ts')] })
  const expected = [
    contentsOf(inRules('a-always.mdc'), 'always-needle'),
    `Contents of ${join(p4, 'MERCURY.local.md')} (user's private project instructions, not checked in):\n\nlocal-needle`,
    offered([`- ${inRules('b-migrations.mdc')}: How to write and run database migrations`, `- ${inRules('c-services.mdc')}: Conventions for the RPC services of the backend`]),
  ].join('\n\n')
  check('the first request ends with one pointer line for each offered rule, below every loaded file', d4.first === expected, d4.first)
  check('no offered body is in the first request', !d4.first.includes('offered-body-needle'))
  check('an offered rule is not counted as read', !d4.seeded.includes(inRules('b-migrations.mdc')), d4.seeded.join(', '))
  check('touching a file attaches no offered rule of the working directory', d4.touched[0]!.attached.length === 0, JSON.stringify(d4.touched[0]))
  const nestedRule = join(p4, 'sub/.cursor/rules/nested.mdc')
  check('an offered rule of a nested folder is pointed to when a file there is touched, in the same words', d4.touched[1]!.attached.length === 1 && d4.touched[1]!.attached[0]!.told.includes(offered([`- ${nestedRule}: Nested folder conventions`])) && !d4.touched[1]!.attached[0]!.told.includes('nested-offered-body-needle'), JSON.stringify(d4.touched[1]))
  check('and once', d4.touched[2]!.attached.length === 0, JSON.stringify(d4.touched[2]))
  const p4b = world.project({ 'MERCURY.md': 'native-needle\n', '.cursor/rules/b-migrations.mdc': '---\ndescription: How to write and run database migrations\n---\noffered-body-needle\n' })
  check('under a MERCURY.md no rule is offered', world.drive(p4b).first === contentsOf(join(p4b, 'MERCURY.md'), 'native-needle'))
} finally {
  world.close()
}
close('format-cursor')
