#!/usr/bin/env bun
import { join } from 'node:path'
import { checker, importLine, openWorld } from './instructionWorld.ts'

const world = openWorld('orient-keeps')
const { check, section, close } = checker()
const INSIDE = "Other tools' files that load here today — the first lines of MERCURY.md:"
const OUTSIDE_ONE = 'A file that is personal or stands outside this project loads here today — its line belongs in MERCURY.local.md, never in MERCURY.md:'
const p4 = (root: string): string => join(root, 'app')
const OUTSIDE_MANY = 'Files that are personal or stand outside this project load here today — their lines belong in MERCURY.local.md, never in MERCURY.md:'

try {
  section('the words of the prompt')
  const bare = world.project({ 'README.md': 'x\n', 'src/a.ts': '\n' })
  const d0 = world.drive(bare, { orient: true })
  check('it says what Mercury loads while a project has no MERCURY.md', d0.orient.includes('Mercury\nloads MERCURY.md first; while a project has no MERCURY.md it loads the instruction and rule\nfiles other tools left there; once MERCURY.md exists only MERCURY.md loads, and those files\ncome in only where it imports them.'), d0.orient.slice(0, 500))
  check('it tells the model to open MERCURY.md with the lines of what loads today', d0.orient.includes("- If other tools' files load here today (this message ends with their lines when they do), open\n  MERCURY.md with exactly those lines, one @ line each, so that what loads today keeps loading,\n  and keep only what is Mercury-specific below them — never duplicate their content. A rules\n  folder is one line; each rule in it keeps its own scope."), d0.orient)
  check('it tells the model to read what the repository holds so as not to repeat it', d0.orient.includes('- Read the README and the instruction files the repository already holds, so that the guide\n  neither repeats nor contradicts them.'), d0.orient)
  check('the law is that nothing of another tool loads on its own once MERCURY.md exists', d0.orient.includes("The explicit-import law (this is load-bearing): once MERCURY.md exists, Mercury loads no other\ntool's file on its own. Never copy such a file's content into MERCURY.md; an @ line composes it\ndeliberately, with source and digest provenance, visible in the health surface."), d0.orient)
  check('the old law and the old offer are gone', !d0.orient.includes('no other instruction file on its own') && !d0.orient.includes('OFFER') && !d0.orient.includes('loads AGENTS.md instead'), d0.orient)
  check('a project where nothing of another tool loads gets no lines', !d0.orient.includes(INSIDE) && !d0.orient.includes('MERCURY.local.md, never'), d0.orient.slice(-300))

  section('a project where files of other tools load: one line for each, a rules folder as one line')
  const p1 = world.project({
    'AGENTS.md': 'agents-needle\n',
    'GEMINI.md': 'guide-needle\n',
    '.github/copilot-instructions.md': 'repository-needle\n',
    '.github/instructions/py.instructions.md': '---\napplyTo: "**/*.py"\n---\npython-needle\n',
    '.cursor/rules/a.mdc': '---\nalwaysApply: true\n---\nalways-needle\n',
    '.cursor/rules/b.mdc': '---\nglobs: src/**\n---\nscoped-needle\n',
    '.cursorrules': 'legacy-needle\n',
    '.clinerules': 'cline-needle\n',
  })
  const d1 = world.drive(p1, { orient: true })
  const tail = d1.orient.slice(d1.orient.indexOf(INSIDE))
  check('the lines for MERCURY.md name every file inside the project, in the order they load, and nothing else is listed', tail === `${INSIDE}\n@AGENTS.md\n@GEMINI.md\n@.github/copilot-instructions.md\n@.github/instructions\n@.cursor/rules\n@.cursorrules\n@.clinerules\n`, tail)

  section('files above the project root: their lines belong in MERCURY.local.md')
  const p2 = world.project({
    '.cursor/rules/shared.mdc': '---\nalwaysApply: true\n---\nworkspace-needle\n',
    'GEMINI.md': 'workspace-guide-needle\n',
    'app/AGENTS.md': 'agents-needle\n',
    'app/src/a.ts': '\n',
  })
  const d2 = world.drive(join(p2, 'app'), { trust: p2, orient: true })
  const tail2 = d2.orient.slice(d2.orient.indexOf(INSIDE))
  check('the file of the project itself is a line of MERCURY.md and the two above it are lines of MERCURY.local.md, by relative path', tail2 === `${INSIDE}\n@AGENTS.md\n\n${OUTSIDE_MANY}\n@../GEMINI.md\n@../.cursor/rules\n`, tail2)

  const p2b = world.project({ 'GEMINI.md': 'workspace-guide-needle\n', 'app/README.md': 'x\n' })
  const d2b = world.drive(p4(p2b), { trust: p2b, orient: true })
  check('one file above the project and none inside: the one sentence, in the singular', d2b.orient.endsWith(`\n\n${OUTSIDE_ONE}\n@../GEMINI.md\n`) && !d2b.orient.includes(INSIDE), d2b.orient.slice(-300))

  section('a folder the Copilot variable names: its lines belong in MERCURY.local.md')
  const namedFolder = world.project({ 'AGENTS.md': 'named-needle\n', '.github/instructions/py.instructions.md': '---\napplyTo: "**/*.py"\n---\npython-needle\n' })
  const p5 = world.project({ 'AGENTS.md': 'agents-needle\n' })
  const d5 = world.drive(p5, { orient: true, env: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: namedFolder } })
  const tail5 = d5.orient.slice(d5.orient.indexOf(INSIDE))
  check('the file of the project is a line of MERCURY.md, and the guide and the instructions folder of the named folder are lines of MERCURY.local.md', tail5 === `${INSIDE}\n@AGENTS.md\n\n${OUTSIDE_MANY}\n${importLine(join(namedFolder, 'AGENTS.md'))}\n${importLine(join(namedFolder, '.github/instructions'))}\n`, tail5)

  section('nothing is offered where nothing of another tool loads')
  const p3 = world.project({ 'MERCURY.md': 'native-needle\n', 'GEMINI.md': 'guide-needle\n', '.cursor/rules/a.mdc': '---\nalwaysApply: true\n---\nalways-needle\n' })
  check('under an existing MERCURY.md no line is listed', !world.drive(p3, { orient: true }).orient.includes(INSIDE))
  check('under the native profile no line is listed', !world.drive(p1, { orient: true, settings: { briefs: { profile: 'native' } } }).orient.includes(INSIDE))
} finally {
  world.close()
}
close('orient-keeps-what-loads')
