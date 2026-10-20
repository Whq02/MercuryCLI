import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mountOffscreen, waitFor } from '../lib/settingsPopupHarness.ts'
import { llmhostFixture } from '../providers/lib/llmhostFixture.ts'
import { gridToPng } from './gridToPng.ts'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
const at = process.argv.indexOf('--frames')
const frames = at < 0 ? undefined : process.argv[at + 1]
if (frames) mkdirSync(frames, { recursive: true })
const f = await llmhostFixture()
let failures = 0
const check = (name: string, ok: unknown) => { console.log((ok ? 'PASS ' : 'FAIL ') + name); if (!ok) failures++ }
try {
  const React = await import('react')
  const { Box } = await import('../../src/ink.ts')
  const { Commands } = await import('../../src/components/HelpV2/Commands.tsx')
  const { COMMAND_DOMAINS } = await import('../../src/components/HelpV2/commandDomains.ts')
  const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.tsx')
  const commands = await Promise.all(['llmhost', 'restart', 'mcp'].map(async name => (await import('../../src/commands/' + name + '/index.ts')).default))
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
  for (const command of commands) {
    check(command.name + ' is in exactly one help domain', COMMAND_DOMAINS.filter(domain => domain.names.includes(command.name)).length === 1)
    check(command.name + ' has an explanatory README command row', readme.split('\n').some(line => line.startsWith('| `/' + command.name + '` |') && line.length > command.name.length + 30))
  }
  check('MCP help names tool parameters', commands.find(command => command.name === 'mcp').description.includes('parameters'))
  for (const cols of [120, 80]) {
    const m = await mountOffscreen(React.createElement(ThemeProvider, {}, React.createElement(Box, { width: cols, height: 32, flexDirection: 'column' }, React.createElement(Commands, { commands, maxHeight: 32, columns: cols, title: 'Commands added or changed in this release', onCancel() {}, onPick() {} }))), cols, 32)
    try {
      assert.ok(await waitFor(() => m.screen().includes('/llmhost') && m.screen().includes('/restart') && m.screen().includes('/mcp'), 5000), m.screen())
      const words = m.screen().replace(/\s+/g, ' ')
      check(cols + ': each help description is readable without truncation', commands.every(command => words.includes(command.description)))
      if (frames) {
        writeFileSync(join(frames, 'help-' + cols + '.txt'), m.screen())
        const grid = m.lines().map((line, y) => Array.from(line.padEnd(cols)).map((c, x) => { const s = m.styleAt(x, y); return { c, bg: s?.bg ?? 'default', fg: s?.fg ?? 'default', bold: s?.bold ?? false, rev: s?.inverse ?? false } }))
        const path = join(frames, 'help-' + cols + '.json')
        writeFileSync(path, JSON.stringify({ grid, cols, rows: 32 }))
        await gridToPng(path, join(frames, 'help-' + cols + '.png'))
      }
    } finally { m.unmount() }
  }
  console.log('BETA40 HELP ' + (failures ? 'RED' : 'GREEN') + ' — ' + failures + ' failures')
  process.exitCode = failures ? 1 : 0
} finally { f.close() }
