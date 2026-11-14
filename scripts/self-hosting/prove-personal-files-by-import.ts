#!/usr/bin/env bun
import { join } from 'node:path'
import { checker, count, governs, openWorld } from './instructionWorld.ts'

const world = openWorld('personal-import')
const { check, section, close } = checker()
const personal = (path: string, body: string): string => `Contents of ${path} (user's private global instructions for all projects):\n\n${body}`

try {
  const home = world.project({
    '.gemini/GEMINI.md': 'personal-gemini-needle\n',
    '.codex/AGENTS.md': 'personal-codex-needle\n',
    '.config/opencode/AGENTS.md': 'personal-opencode-needle\n',
    '.codeium/windsurf/memories/global_rules.md': 'personal-windsurf-needle\n',
    '.copilot/copilot-instructions.md': 'personal-copilot-needle\n',
    '.cursor/rules/always.mdc': '---\nalwaysApply: true\n---\npersonal-always-needle\n',
    '.cursor/rules/scoped.mdc': '---\nglobs: "**/*.ts"\nalwaysApply: false\n---\npersonal-scoped-needle\n',
    'shared/rules/.cursor/rules/python.mdc': '---\nglobs: src/**/*.py\nalwaysApply: false\n---\nelsewhere-scoped-needle\n',
    'work/proj/AGENTS.md': 'project-agents-needle\n',
    'work/proj/src/a.ts': '\n',
    'work/proj/src/b.py': '\n',
    'work/proj/README.md': 'x\n',
  })
  const project = join(home, 'work/proj')
  const NEEDLES = ['personal-gemini-needle', 'personal-codex-needle', 'personal-opencode-needle', 'personal-windsurf-needle', 'personal-copilot-needle', 'personal-always-needle', 'personal-scoped-needle', 'elsewhere-scoped-needle']

  section('by themselves the personal files of other tools are never read')
  const alone = world.drive(project, { home, trust: home, personal: 'my-own-needle\n', touch: [join(project, 'src/a.ts'), join(project, 'src/b.py')] })
  check("the user's own MERCURY.md and the project's AGENTS.md load, and none of the personal files", alone.first.includes('my-own-needle') && alone.first.includes('project-agents-needle') && NEEDLES.every(needle => !alone.first.includes(needle)), NEEDLES.filter(needle => alone.first.includes(needle)).join(', '))
  check('reading a file attaches none of them', alone.touched.every(touch => touch.attached.length === 0), JSON.stringify(alone.touched))

  section("an @~/ line in the user's own MERCURY.md brings one in")
  const lines = ['@~/.gemini/GEMINI.md', '@~/.codex/AGENTS.md', '@~/.config/opencode/AGENTS.md', '@~/.codeium/windsurf/memories/global_rules.md', '@~/.copilot/copilot-instructions.md', '@~/.cursor/rules', '@~/shared/rules/.cursor/rules', 'my-own-needle'].join('\n')
  const d = world.drive(project, { home, trust: home, personal: `${lines}\n`, touch: [join(project, 'README.md'), join(project, 'src/a.ts'), join(project, 'src/b.py')] })
  const guides = ['personal-gemini-needle', 'personal-codex-needle', 'personal-opencode-needle', 'personal-windsurf-needle', 'personal-copilot-needle']
  check('each personal guide reaches the first request once', guides.every(needle => count(d.first, needle) === 1), guides.map(needle => `${needle} ${count(d.first, needle)}`).join(', '))
  check("each is told as the user's own instructions for all projects", d.first.includes(personal(join(home, '.gemini/GEMINI.md'), 'personal-gemini-needle')), d.first.slice(0, 600))
  check("each rides the user's own MERCURY.md", d.entries.filter(entry => guides.some(needle => entry.path.includes(needle.split('-')[1]!))).every(entry => entry.type === 'User' && entry.parent !== undefined), JSON.stringify(d.entries.filter(entry => entry.parent !== undefined).map(entry => [entry.path, entry.type])))
  check("the project's own files still load: a personal MERCURY.md decides nothing", d.first.includes('project-agents-needle') && d.fallbackComposed, d.paths.join(', '))
  check('an always rule of an imported personal rules folder reaches the first request', count(d.first, 'personal-always-needle') === 1, String(count(d.first, 'personal-always-needle')))
  check('its scoped rules do not', !d.first.includes('personal-scoped-needle') && !d.first.includes('elsewhere-scoped-needle'))
  check('a file no pattern names attaches nothing', d.touched[0]!.attached.length === 0, JSON.stringify(d.touched[0]))
  check('a scoped rule of the home folder is matched from the home folder', d.touched[1]!.attached.length === 1 && d.touched[1]!.attached[0]!.told.includes(governs(join(home, '.cursor/rules/scoped.mdc'), '**/*.ts', 'personal-scoped-needle')), JSON.stringify(d.touched[1]))
  check('a scoped rule of a folder that does not hold the working directory is matched from the working directory', d.touched[2]!.attached.length === 1 && d.touched[2]!.attached[0]!.told.includes(governs(join(home, 'shared/rules/.cursor/rules/python.mdc'), 'src/**/*.py', 'elsewhere-scoped-needle')), JSON.stringify(d.touched[2]))
  check('nothing is reported as a fault', d.diagnostics.filter(diagnostic => diagnostic.kind !== 'duplicate-content').length === 0, JSON.stringify(d.diagnostics))
} finally {
  world.close()
}
close('personal-files-by-import')
