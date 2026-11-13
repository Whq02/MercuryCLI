#!/usr/bin/env bun
import { join } from 'node:path'
import { checker, contentsOf, governs, openWorld, rulesBattery } from './instructionWorld.ts'

const world = openWorld('format-cline')
const { check, section, close } = checker()
const always = (body: string): string => body
const scoped = (patterns: string[], body: string): string => `---\npaths:\n${patterns.map(pattern => `  - "${pattern}"`).join('\n')}\n---\n${body}`

try {
  rulesBattery({ world, check, section, convention: 'cline', folder: '.clinerules', ext: '.md', always, scoped, nearestOnly: true })
  rulesBattery({ world, check, section, convention: 'cline', folder: '.cline/rules', ext: '.md', always, scoped, nearestOnly: true })

  section('.clinerules as one file')
  const p1 = world.project({ '.clinerules': 'single-file-needle\nSee @docs/x.md\n', 'docs/x.md': 'mentioned-needle\n', 'sub/.clinerules': 'nested-single-needle\n', 'sub/a.ts': '\n' })
  const single = join(p1, '.clinerules')
  const d1 = world.drive(p1, { classify: [single], touch: [join(p1, 'sub/a.ts')] })
  check('it reaches the first request whole, as written', d1.first === contentsOf(single, 'single-file-needle\nSee @docs/x.md'), d1.first)
  check('it names its format, classifies as an instruction file and counts as the guide of its folder', d1.entries.find(e => e.path === single)?.convention === 'cline' && d1.classified[single] === true && JSON.stringify(d1.guides) === JSON.stringify([single]), JSON.stringify(d1.entries))
  check('a plain file shown whole counts as read in full', d1.seeded.includes(single), d1.seeded.join(', '))
  check('one in a nested folder attaches with its folder', JSON.stringify(d1.touched[0]!.attached.map(a => a.path)) === JSON.stringify([join(p1, 'sub/.clinerules')]), JSON.stringify(d1.touched[0]))
  const p1b = world.project({ '.clinerules': '---\npaths:\n  - "api/**"\n---\nsingle-scoped-needle\n', 'api/h.go': '\n', 'web/a.ts': '\n' })
  const d1b = world.drive(p1b, { touch: [join(p1b, 'web/a.ts'), join(p1b, 'api/h.go')] })
  check('with paths the one file is scoped from the folder that holds it', d1b.first === '' && d1b.touched[0]!.attached.length === 0 && d1b.touched[1]!.attached.length === 1 && d1b.touched[1]!.attached[0]!.told.includes(governs(join(p1b, '.clinerules'), 'api/**', 'single-scoped-needle')), JSON.stringify(d1b.touched))
  const p1c = world.project({ 'MERCURY.md': 'native-needle\n', '.clinerules': 'single-file-needle\n' })
  check('MERCURY.md decides over it', world.drive(p1c).first === contentsOf(join(p1c, 'MERCURY.md'), 'native-needle'))

  section("Cline's own conditions")
  const p2 = world.project({
    '.clinerules/01-universal.md': 'universal-needle\n',
    '.clinerules/02-never.md': '---\npaths: []\n---\nnever-needle\n',
    '.clinerules/03-broken.md': '---\npaths:\n  - "src/**"\n - bad\n---\nbroken-header-needle\n',
    '.clinerules/04-other-keys.md': '---\ndescription: Not a Cline condition\nglobs: nowhere/**\nalwaysApply: false\n---\nother-keys-needle\n',
    '.clinerules/05-everything.md': '---\npaths:\n  - "**"\n---\neverything-needle\n',
    '.clinerules/06-odd.md': '---\npaths: 7\n---\nodd-needle\n',
    '.cline/rules/07-second-folder.md': 'second-folder-needle\n',
    'src/a.ts': '\n',
  })
  const rule = (name: string): string => join(p2, '.clinerules', name)
  const d2 = world.drive(p2, { touch: [join(p2, 'src/a.ts')] })
  const expected = [
    contentsOf(rule('01-universal.md'), 'universal-needle'),
    contentsOf(rule('03-broken.md'), '---\npaths:\n  - "src/**"\n - bad\n---\nbroken-header-needle'),
    contentsOf(rule('04-other-keys.md'), 'other-keys-needle'),
    contentsOf(rule('05-everything.md'), 'everything-needle'),
    contentsOf(join(p2, '.cline/rules/07-second-folder.md'), 'second-folder-needle'),
  ].join('\n\n')
  check('a rule with no header is always active, one whose header is not YAML loads whole, keys that are not conditions of Cline scope nothing, both folders load', d2.first === expected, d2.first)
  check('the unreadable header is reported', d2.diagnostics.some(d => d.kind === 'unreadable-rule-header' && d.path === rule('03-broken.md')), JSON.stringify(d2.diagnostics))
  check('paths: [] never activates', !d2.first.includes('never-needle') && d2.touched[0]!.attached.every(a => !a.told.includes('never-needle')), JSON.stringify(d2.touched[0]))
  check('a paths that holds no pattern keeps its rule out and is reported', !d2.first.includes('odd-needle') && d2.diagnostics.some(d => d.kind === 'unsupported-rule-activation' && d.path === rule('06-odd.md')), JSON.stringify(d2.diagnostics))

  section('the nearest one in the chain, both of its folders')
  const p3 = world.project({
    '.clinerules/outer.md': 'outer-needle\n',
    'packages/app/.clinerules': 'inner-file-needle\n',
    'packages/app/.cline/rules/inner.md': 'inner-folder-needle\n',
    'packages/app/a.ts': '\n',
  })
  const d3 = world.drive(join(p3, 'packages/app'), { trust: p3 })
  check('the file and the second folder of the nearest holder both load and the farther one does not', d3.first === [contentsOf(join(p3, 'packages/app/.clinerules'), 'inner-file-needle'), contentsOf(join(p3, 'packages/app/.cline/rules/inner.md'), 'inner-folder-needle')].join('\n\n'), d3.first)
} finally {
  world.close()
}
close('format-cline')
