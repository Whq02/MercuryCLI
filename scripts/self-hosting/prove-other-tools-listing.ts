#!/usr/bin/env bun
import { join } from 'node:path'
import { checker, openWorld, slashed } from './instructionWorld.ts'

const world = openWorld('other-tools-listing')
const { check, section, close } = checker()
const same = (got: string[], want: string[]): boolean => JSON.stringify(got) === JSON.stringify(want)

try {
  section('a project with no MERCURY.md: every file is named with its tool and with when it loads')
  const p1 = world.project({
    'AGENTS.md': 'agents-needle\n',
    'GEMINI.md': 'guide-needle\n',
    '.cursor/rules/a-always.mdc': '---\nalwaysApply: true\n---\nalways-needle\n',
    '.cursor/rules/b-scoped.mdc': '---\nglobs: src/**/*.ts\nalwaysApply: false\n---\nscoped-needle\n',
    '.cursor/rules/c-offered.mdc': '---\ndescription: How migrations are written\nalwaysApply: false\n---\noffered-needle\n',
    '.cursor/rules/d-manual.mdc': '---\nalwaysApply: false\n---\nmanual-needle\n',
    '.cursor/rules/e-broken.mdc': '---\ndescription: x\nglobs:\n  - a\n - b\n---\nbroken-needle\n',
    '.windsurf/rules/f-unknown.md': '---\ntrigger: sometimes\n---\nunknown-needle\n',
    '.windsurf/rules/g-glob-without.md': '---\ntrigger: glob\n---\nwithout-needle\n',
    '.clinerules/h-never.md': '---\npaths: []\n---\nnever-needle\n',
    'src/a.ts': '\n',
  })
  const d1 = world.drive(p1, { screens: true, touch: [join(p1, 'src/a.ts')] })
  check('the loaded rows name the tool of each file, AGENTS.md keeps its words, an offered rule says so', same(d1.rows, [
    'shared guide · ./AGENTS.md',
    'Gemini · ./GEMINI.md',
    'Cursor · ./.cursor/rules/a-always.mdc',
    'Cursor · ./.cursor/rules/c-offered.mdc · offered by its description',
  ]), JSON.stringify(d1.rows))
  const dormant = [
    'Cursor · ./.cursor/rules/d-manual.mdc · not loaded: manual, @-mention it',
    'Cursor · ./.cursor/rules/e-broken.mdc · not loaded: its header is not YAML',
    'Windsurf · ./.windsurf/rules/f-unknown.md · not loaded: its trigger "sometimes" is not one Mercury reads',
    'Windsurf · ./.windsurf/rules/g-glob-without.md · not loaded: its scope is not one Mercury reads',
    'Cline · ./.clinerules/h-never.md · not loaded: its paths list is empty',
  ]
  check('before any file is touched a scoped rule reads "loads with", and each rule that is not sent says why', same(d1.listedBefore, ['Cursor · ./.cursor/rules/b-scoped.mdc · loads with src/**/*.ts', ...dormant]), JSON.stringify(d1.listedBefore))
  check('once a matching file was touched it reads "loaded with"', same(d1.listed, ['Cursor · ./.cursor/rules/b-scoped.mdc · loaded with src/**/*.ts', ...dormant]), JSON.stringify(d1.listed))
  check('the footer of the list says what the auto profile reads and that a row says when its file loads', d1.words.footer === "profile auto: MERCURY.md, or other tools' files when there is none · a row says when its file loads", d1.words.footer)
  check('the row of the memory centre says the same of the profile', d1.words.centre === "MERCURY.md, or other tools' files when there is none · editor and the memory switch", d1.words.centre)

  check('the health note counts the sources by tool', d1.words.health === '4 source(s) from other tools (AGENTS.md 1 · Gemini 1 · Cursor 2): no MERCURY.md in or above the working directory', d1.words.health)
  const p1b = world.project({ 'AGENTS.md': 'agents-needle\n@docs/x.md\n', 'docs/x.md': 'imported-needle\n' })
  const d1b = world.drive(p1b, { screens: true })
  check('with AGENTS.md alone the health note keeps the words it had', d1b.words.health === '2 AGENTS.md source(s): no MERCURY.md in or above the working directory', d1b.words.health)

  section('under a MERCURY.md: what it imports is listed by its scope, the rest says what to do next')
  const p2 = world.project({
    'MERCURY.md': 'native-needle\n@.cursor/rules/b-scoped.mdc\n',
    'GEMINI.md': 'guide-needle\n',
    '.github/copilot-instructions.md': 'repository-needle\n',
    '.cursor/rules/a-always.mdc': '---\nalwaysApply: true\n---\nalways-needle\n',
    '.cursor/rules/b-scoped.mdc': '---\nglobs: src/**/*.ts\nalwaysApply: false\n---\nscoped-needle\n',
    'AGENTS.md': 'agents-needle\n',
  })
  const d2 = world.drive(p2, { screens: true })
  check('the loaded rows are those of Mercury itself', same(d2.rows, ['Mercury-native · ./MERCURY.md']), JSON.stringify(d2.rows))
  check('the imported rule keeps its scope and every switched-off file names its import line', same(d2.listed, [
    'Cursor · ./.cursor/rules/b-scoped.mdc · loads with src/**/*.ts',
    'Gemini · ./GEMINI.md · not loaded: MERCURY.md decides; import it with @GEMINI.md',
    'Copilot · ./.github/copilot-instructions.md · not loaded: MERCURY.md decides; import it with @.github/copilot-instructions.md',
    'Cursor · ./.cursor/rules/a-always.mdc · not loaded: MERCURY.md decides; import it with @.cursor/rules/a-always.mdc',
  ]), JSON.stringify(d2.listed))
  check('an AGENTS.md that does not load is not listed, as before', !d2.listed.some(row => row.includes('AGENTS.md')), JSON.stringify(d2.listed))
  check('with nothing shared in the request the health note says nothing', d2.words.health === '', d2.words.health)

  section('the nearest holder only, and the native profile')
  const p3 = world.project({ '.clinerules/outer.md': 'outer-needle\n', 'packages/app/.clinerules/inner.md': 'inner-needle\n', 'packages/app/a.ts': '\n' })
  const d3 = world.drive(join(p3, 'packages/app'), { trust: p3, screens: true })
  check('the rule of the farther folder says a nearer one is read', same(d3.listed, [`Cline · ${slashed(join(p3, '.clinerules/outer.md'))} · not loaded: a nearer .clinerules is read`]), JSON.stringify(d3.listed))
  const d4 = world.drive(p1, { screens: true, settings: { briefs: { profile: 'native' } } })
  check('under the native profile nothing of another tool is listed and the footer keeps its words', d4.listed.length === 0 && d4.rows.length === 0 && d4.words.footer === 'profile native: MERCURY.md only · every file here loads every session', JSON.stringify(d4))
} finally {
  world.close()
}
close('other-tools-listing')
