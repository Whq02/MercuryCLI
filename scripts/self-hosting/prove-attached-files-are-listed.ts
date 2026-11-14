#!/usr/bin/env bun
import { join } from 'node:path'
import { checker, openWorld } from './instructionWorld.ts'

const world = openWorld('attached-listed')
const { check, section, close } = checker()
const same = (got: string[], want: string[]): boolean => JSON.stringify([...got].sort()) === JSON.stringify([...want].sort())

try {
  const project = world.project({
    'README.md': 'x\n',
    'sub/GEMINI.md': 'nested-gemini-needle\n',
    'sub/AGENTS.md': 'nested-agents-needle\n',
    'sub/a.ts': '\n',
    'own/MERCURY.md': 'nested-native-needle\n',
    'own/a.ts': '\n',
    'pkg/.cursor/rules/scoped.mdc': '---\nglobs: lib/**\nalwaysApply: false\n---\nnested-scoped-needle\n',
    'pkg/lib/a.ts': '\n',
    '.cursor/rules/top.mdc': '---\nglobs: src/**\nalwaysApply: false\n---\ntop-scoped-needle\n',
    'src/a.ts': '\n',
    'quiet/GEMINI.md': 'untouched-needle\n',
    'quiet/a.ts': '\n',
  })
  const touch = ['sub/a.ts', 'own/a.ts', 'pkg/lib/a.ts', 'src/a.ts'].map(file => join(project, file))
  const d = world.drive(project, { screens: true, drop: true, touch })
  const NESTED = [
    'Gemini · ./sub/GEMINI.md · loaded with its folder',
    'shared guide · ./sub/AGENTS.md · loaded with its folder',
    'Mercury-native · ./own/MERCURY.md · loaded with its folder',
    'Cursor · ./pkg/.cursor/rules/scoped.mdc · loaded with lib/**',
  ]

  section('before a file of its folder is read, a nested file is not listed')
  check('no attached row stands at the start, and no nested file is among the rows', d.attachedBefore.length === 0 && d.listedBefore.every(row => !row.includes('./sub/') && !row.includes('./own/') && !row.includes('./pkg/') && !row.includes('./quiet/')), JSON.stringify([d.attachedBefore, d.listedBefore]))
  check('a scoped rule of the working directory reads "loads with"', same(d.listedBefore, ['Cursor · ./.cursor/rules/top.mdc · loads with src/**']), JSON.stringify(d.listedBefore))

  section('once it has attached it is listed, whatever its format')
  check("another tool's nested guide is listed with its tool", d.attached.includes(NESTED[0]!), JSON.stringify(d.attached))
  check('a nested AGENTS.md is listed', d.attached.includes(NESTED[1]!), JSON.stringify(d.attached))
  check("Mercury's own nested MERCURY.md is listed", d.attached.includes(NESTED[2]!), JSON.stringify(d.attached))
  check('a scoped rule of a nested folder is listed with its patterns', d.attached.includes(NESTED[3]!), JSON.stringify(d.attached))
  check('those four rows are all of them: a folder nothing was read in adds none, and the scoped rule of the working directory keeps its own row', same(d.attached, NESTED) && same(d.listed, ['Cursor · ./.cursor/rules/top.mdc · loaded with src/**']), JSON.stringify([d.attached, d.listed]))

  section('the rows follow what the session still holds')
  check('after the session lets them go, no nested file is shown as loaded and the scoped rule reads "loads with" again', d.dropped.attached.length === 0 && same(d.dropped.listed, ['Cursor · ./.cursor/rules/top.mdc · loads with src/**']), JSON.stringify(d.dropped))
  check('read again, each attaches again and is listed again', same(d.returned.attached, NESTED) && same(d.returned.listed, ['Cursor · ./.cursor/rules/top.mdc · loaded with src/**']), JSON.stringify(d.returned))
} finally {
  world.close()
}
close('attached-files-are-listed')
