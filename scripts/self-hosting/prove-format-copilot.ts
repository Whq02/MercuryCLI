#!/usr/bin/env bun
import { join } from 'node:path'
import { checker, contentsOf, governs, guideBattery, openWorld, rulesBattery } from './instructionWorld.ts'

const world = openWorld('format-copilot')
const { check, section, close } = checker()

try {
  guideBattery({ world, check, section, file: '.github/copilot-instructions.md', convention: 'copilot' })

  section('a copilot-instructions.md outside .github is an ordinary file')
  const stray = world.project({ 'docs/copilot-instructions.md': 'stray-needle\n', 'copilot-instructions.md': 'stray-needle\n' })
  const d1 = world.drive(stray, { classify: [join(stray, 'docs/copilot-instructions.md'), join(stray, 'copilot-instructions.md')] })
  check('nothing composes', d1.first === '', d1.first)
  check('neither classifies as an instruction file', d1.classified[join(stray, 'docs/copilot-instructions.md')] === false && d1.classified[join(stray, 'copilot-instructions.md')] === false)

  rulesBattery({
    world,
    check,
    section,
    convention: 'copilot',
    folder: '.github/instructions',
    ext: '.instructions.md',
    always: body => `---\napplyTo: "**"\n---\n${body}`,
    scoped: (patterns, body) => `---\napplyTo: "${patterns.join(',')}"\n---\n${body}`,
  })

  section('applyTo, as GitHub reads it')
  const p2 = world.project({
    '.github/copilot-instructions.md': 'repository-guide-needle\n',
    '.github/instructions/a-universal.instructions.md': '---\napplyTo: "**/*"\n---\nuniversal-needle\n',
    '.github/instructions/b-root-files.instructions.md': '---\napplyTo: "*"\n---\nroot-files-needle\n',
    '.github/instructions/c-list.instructions.md': '---\napplyTo:\n  - "app/models/**/*.rb"\n  - "lib/**/*.rb"\n---\nlist-needle\n',
    '.github/instructions/d-described.instructions.md': '---\ndescription: Conventions for the build scripts\n---\ndescribed-body-needle\n',
    '.github/instructions/e-bare.instructions.md': 'bare-needle\n',
    '.github/instructions/f-odd.instructions.md': '---\napplyTo: 42\n---\nodd-needle\n',
    '.github/instructions/g-review-only.instructions.md': '---\napplyTo: "**"\nexcludeAgent: "code-review"\n---\nexclude-agent-needle\n',
    '.github/instructions/notes.md': '---\napplyTo: "**"\n---\nplain-markdown-needle\n',
    'Makefile': '\n',
    'app/models/user.rb': '\n',
    'src/x.ts': '\n',
  })
  const rule = (name: string): string => join(p2, '.github/instructions', name)
  const d2 = world.drive(p2, { touch: [join(p2, 'src/x.ts'), join(p2, 'Makefile'), join(p2, 'app/models/user.rb')] })
  const expected = [
    contentsOf(join(p2, '.github/copilot-instructions.md'), 'repository-guide-needle'),
    contentsOf(rule('a-universal.instructions.md'), 'universal-needle'),
    contentsOf(rule('g-review-only.instructions.md'), 'exclude-agent-needle'),
    `Rule files offered by description (not loaded; Read one when its description fits the work):\n- ${rule('d-described.instructions.md')}: Conventions for the build scripts`,
  ].join('\n\n')
  check('the guide, the rules that name every file, and one pointer for the described rule make the first request', d2.first === expected, d2.first)
  check('a file below the root attaches no rule of "*"', d2.touched[0]!.attached.length === 0, JSON.stringify(d2.touched[0]))
  check('"*" governs the files of the root, not every file', d2.touched[1]!.attached.length === 1 && d2.touched[1]!.attached[0]!.told.includes(governs(rule('b-root-files.instructions.md'), '*', 'root-files-needle')), JSON.stringify(d2.touched[1]))
  check('a list of patterns scopes the rule to each', d2.touched[2]!.attached.length === 1 && d2.touched[2]!.attached[0]!.told.includes(governs(rule('c-list.instructions.md'), 'app/models/**/*.rb, lib/**/*.rb', 'list-needle')), JSON.stringify(d2.touched[2]))
  check('a file with no applyTo and no description is manual: never sent', !d2.first.includes('bare-needle') && d2.touched.every(touch => touch.attached.every(a => !a.told.includes('bare-needle'))))
  check('an applyTo that is no pattern keeps its rule out and is reported', !d2.first.includes('odd-needle') && d2.diagnostics.some(d => d.kind === 'unsupported-rule-activation' && d.path === rule('f-odd.instructions.md')), JSON.stringify(d2.diagnostics))
  check('a Markdown file there without the instructions suffix is not a rule', !d2.first.includes('plain-markdown-needle'))
} finally {
  world.close()
}
close('format-copilot')
