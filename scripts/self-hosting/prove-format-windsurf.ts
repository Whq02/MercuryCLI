#!/usr/bin/env bun
import { join } from 'node:path'
import { checker, contentsOf, count, governs, openWorld, rulesBattery } from './instructionWorld.ts'

const world = openWorld('format-windsurf')
const { check, section, close } = checker()
const always = (body: string): string => `---\ntrigger: always_on\n---\n${body}`
const scoped = (patterns: string[], body: string): string => `---\ntrigger: glob\nglobs: ${patterns.join(',')}\n---\n${body}`
const offered = (lines: string[]): string => `Rule files offered by description (not loaded; Read one when its description fits the work):\n${lines.join('\n')}`

try {
  rulesBattery({ world, check, section, convention: 'windsurf', folder: '.windsurf/rules', ext: '.md', always, scoped })
  rulesBattery({ world, check, section, convention: 'windsurf', folder: '.devin/rules', ext: '.md', always, scoped })

  section("the vendor's own trigger words")
  const p1 = world.project({
    '.windsurf/rules/a-plain.md': 'plain-rule-needle\n',
    '.windsurf/rules/b-decision.md': '---\ntrigger: model_decision\ndescription: API design rules\n---\ndecision-body-needle\n',
    '.windsurf/rules/c-agent.md': '---\ntrigger: agent\ndescription: Release checklist\n---\nagent-body-needle\n',
    '.windsurf/rules/d-manual.md': '---\ntrigger: manual\n---\nmanual-needle\n',
    '.windsurf/rules/e-unknown.md': '---\ntrigger: sometimes\n---\nunknown-trigger-needle\n',
    '.windsurf/rules/f-glob-without.md': '---\ntrigger: glob\n---\nglob-without-needle\n',
    '.windsurf/rules/g-decision-without.md': '---\ntrigger: model_decision\n---\ndecision-without-needle\n',
    '.windsurf/rules/h-fields.md': '---\nglobs: web/**\nalwaysApply: false\n---\nfields-scoped-needle\n',
    '.windsurf/rules/i-fields-always.md': '---\nalwaysApply: true\n---\nfields-always-needle\n',
    '.windsurf/rules/j-described-on.md': '---\ntrigger: always_on\ndescription: A described rule that is always on\n---\ndescribed-on-needle\n',
    'web/a.css': '\n',
  })
  const rule = (name: string): string => join(p1, '.windsurf/rules', name)
  const d1 = world.drive(p1, { touch: [join(p1, 'web/a.css')] })
  const expected = [
    contentsOf(rule('a-plain.md'), 'plain-rule-needle'),
    contentsOf(rule('i-fields-always.md'), 'fields-always-needle'),
    contentsOf(rule('j-described-on.md'), 'described-on-needle'),
    offered([`- ${rule('b-decision.md')}: API design rules`, `- ${rule('c-agent.md')}: Release checklist`]),
  ].join('\n\n')
  check('a rule with no header is always on, always_on wins over a description, and model_decision and agent are offered', d1.first === expected, d1.first)
  check('a manual rule is never sent', !d1.first.includes('manual-needle'))
  check('a trigger word Mercury does not know keeps its rule out and is reported', !d1.first.includes('unknown-trigger-needle') && d1.diagnostics.some(d => d.kind === 'unsupported-rule-activation' && d.path === rule('e-unknown.md')), JSON.stringify(d1.diagnostics))
  check('trigger: glob with no globs is reported, not widened', !d1.first.includes('glob-without-needle') && d1.diagnostics.some(d => d.kind === 'unsupported-rule-activation' && d.path === rule('f-glob-without.md')), JSON.stringify(d1.diagnostics))
  check('trigger: model_decision with no description is reported, not widened', !d1.first.includes('decision-without-needle') && d1.diagnostics.some(d => d.kind === 'unsupported-rule-activation' && d.path === rule('g-decision-without.md')), JSON.stringify(d1.diagnostics))
  check('with no trigger the three shared fields are read', d1.touched[0]!.attached.length === 1 && d1.touched[0]!.attached[0]!.told.includes(governs(rule('h-fields.md'), 'web/**', 'fields-scoped-needle')), JSON.stringify(d1.touched[0]))

  section('the files that stand alone: .windsurfrules and global_rules.md')
  const p2 = world.project({
    '.windsurfrules': 'legacy-needle\nSee @docs/x.md\n',
    '.windsurf/global_rules.md': 'project-global-needle\n',
    'docs/x.md': 'mentioned-needle\n',
    'sub/.windsurfrules': 'nested-legacy-needle\n',
    'sub/a.ts': '\n',
  })
  const d2 = world.drive(p2, { classify: [join(p2, '.windsurfrules'), join(p2, '.windsurf/global_rules.md')], touch: [join(p2, 'sub/a.ts')] })
  check('both reach the first request whole, as written, the legacy file first', d2.first === [contentsOf(join(p2, '.windsurfrules'), 'legacy-needle\nSee @docs/x.md'), contentsOf(join(p2, '.windsurf/global_rules.md'), 'project-global-needle')].join('\n\n'), d2.first)
  check('both name their format and classify as instruction files', d2.entries.every(e => e.convention === 'windsurf') && d2.classified[join(p2, '.windsurfrules')] === true && d2.classified[join(p2, '.windsurf/global_rules.md')] === true, JSON.stringify(d2.entries))
  check('the legacy file counts as the guide of its folder', d2.guides.includes(join(p2, '.windsurfrules')), JSON.stringify(d2.guides))
  check('a legacy file in a nested folder attaches with its folder', JSON.stringify(d2.touched[0]!.attached.map(a => a.path)) === JSON.stringify([join(p2, 'sub/.windsurfrules')]), JSON.stringify(d2.touched[0]))
  const p2b = world.project({ 'MERCURY.md': 'native-needle\n', '.windsurfrules': 'legacy-needle\n', '.windsurf/global_rules.md': 'project-global-needle\n' })
  check('MERCURY.md decides over them', world.drive(p2b).first === contentsOf(join(p2b, 'MERCURY.md'), 'native-needle'))

  section("the same grammar under the vendor's new folder")
  const p3 = world.project({
    '.windsurf/global_rules.md': 'old-global-needle\n',
    '.devin/global_rules.md': 'new-global-needle\n',
    '.windsurf/rules/style.md': always('old-folder-needle\n'),
    '.devin/rules/style.md': always('new-folder-needle\n'),
    '.devin/rules/same.md': always('same-text-needle\n'),
    '.windsurf/rules/same.md': always('same-text-needle\n'),
  })
  const d3 = world.drive(p3)
  check('with both global files only the one of the new folder loads', d3.first.includes('new-global-needle') && !d3.first.includes('old-global-needle'), d3.first)
  check('the rules folders of both load', d3.first.includes('old-folder-needle') && d3.first.includes('new-folder-needle'), d3.first)
  check('a rule of identical text in both loads once', count(d3.first, 'same-text-needle') === 1, d3.first)
  const p3b = world.project({ '.windsurf/global_rules.md': 'old-global-needle\n' })
  check('alone, the old global file loads', world.drive(p3b).first === contentsOf(join(p3b, '.windsurf/global_rules.md'), 'old-global-needle'))
} finally {
  world.close()
}
close('format-windsurf')
