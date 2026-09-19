#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT, makeTally } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type SeenResult } from '../lib/scriptedTurn.ts'

const tally = makeTally('prove-edit-byte-exact-matrix')
const KEEP = process.argv.includes('--keep')
const scratch = mkdtempSync(join(SCRATCH_ROOT, 'edit-byte-exact-'))
const work = join(scratch, 'work')
mkdirSync(work, { recursive: true })
console.log(`build under proof: ${DIST}`)
console.log(`world: ${scratch}`)

const RS = '’'
const LS = '‘'
const LD = '“'
const RD = '”'
const typed = (text: string): string => text.replaceAll(RS, "'").replaceAll(LS, "'").replaceAll(LD, '"').replaceAll(RD, '"')

type Kind = 'code' | 'unknown' | 'prose'
type Row = { kind: Kind; language: string; file: string; content: string; oldString: string; newString: string; expected: string }

const exact = (kind: Kind, language: string, file: string, content: string, oldActual: string, suffix: string): Row => {
  if (!content.includes(oldActual)) throw new Error(`${file}: the fixture does not carry its old string`)
  return { kind, language, file, content, oldString: typed(oldActual), newString: `${typed(oldActual)}${suffix}`, expected: content.replace(oldActual, `${oldActual}${suffix}`) }
}
const code = (language: string, file: string, line: string, oldActual: string, suffix: string): Row => exact('code', language, file, `${line}\n`, oldActual, suffix)
const unknown = (language: string, file: string, line: string, oldActual: string, suffix: string): Row => exact('unknown', language, file, `${line}\n`, oldActual, suffix)
const prose = (language: string, file: string): Row => ({
  kind: 'prose',
  language,
  file,
  content: `The daemon${RS}s runner stays warm, said the note.\n`,
  oldString: "The daemon's runner stays warm, said the note.",
  newString: `The daemon's runner stays "warm", said the note.`,
  expected: `The daemon${RS}s runner stays ${LD}warm${RD}, said the note.\n`,
})

const rows: Row[] = [
  code('TypeScript', 'rows.ts', `export const rows = [{ summary: 'the daemon${RS}s runner stays warm', off: 'stopped' }]`, `daemon${RS}s runner stays warm', off: 'stopped'`, ", on: 'running -- a — b … c ... d  e'"),
  code('JavaScript', 'rows.js', `const rows = [{ summary: 'the daemon${RS}s runner', off: 'stopped' }]`, `daemon${RS}s runner', off: 'stopped'`, ", on: 'running'"),
  code('Python', 'rows.py', `ROWS = [{"summary": "the daemon${RS}s runner", "off": "stopped"}]`, `daemon${RS}s runner", "off": "stopped"`, ', "on": "running"'),
  code('Rust', 'rows.rs', `const ROWS: &[(&str, &str)] = &[("the daemon${RS}s runner", "stopped")];`, `daemon${RS}s runner", "stopped")`, ', ("on", "running")'),
  code('Go', 'rows.go', `var rows = map[string]string{"summary": "the daemon${RS}s runner", "off": "stopped"}`, `daemon${RS}s runner", "off": "stopped"`, ', "on": "running"'),
  code('C', 'rows.c', `static const char *rows[] = {"the daemon${RS}s runner", "stopped"};`, `daemon${RS}s runner", "stopped"`, ', "running"'),
  code('shell', 'rows.sh', `summary='the daemon${RS}s runner'; off='stopped'`, `daemon${RS}s runner'; off='stopped'`, "; on='running'"),
  code('JSON', 'rows.json', `{"summary": "the daemon${RS}s runner", "off": "stopped"}`, `daemon${RS}s runner", "off": "stopped"`, ', "on": "running"'),
  code('YAML', 'rows.yaml', `rows: {summary: "the daemon${RS}s runner", off: "stopped"}`, `daemon${RS}s runner", off: "stopped"`, ', on: "running"'),
  code('TOML', 'rows.toml', `rows = { summary = "the daemon${RS}s runner", off = "stopped" }`, `daemon${RS}s runner", off = "stopped"`, ', on = "running"'),
  code('CSS', 'rows.css', `.row::after { content: 'the daemon${RS}s runner'; font-family: 'stopped'; }`, `daemon${RS}s runner'; font-family: 'stopped'`, ", 'running'"),
  code('HTML', 'rows.html', `<p title='the daemon${RS}s runner' data-off='stopped'>rows</p>`, `daemon${RS}s runner' data-off='stopped'`, " data-on='running'"),
  code('Dockerfile (a basename, no extension)', 'Dockerfile', `LABEL summary='the daemon${RS}s runner' off='stopped'`, `daemon${RS}s runner' off='stopped'`, " on='running'"),
  code('TypeScript, curly double quotes in the matched text', 'said.ts', `export const said = { text: 'she said ${LD}warm${RD}', off: 'stopped' }`, `said ${LD}warm${RD}', off: 'stopped'`, ', on: "running"'),
  code('TypeScript, a template literal', 'tpl.ts', `export const tpl = \`the daemon${RS}s runner: 'stopped'\``, `daemon${RS}s runner: 'stopped'`, ` and "on": 'running'`),
  code('a script whose kind only its first line names (bash)', 'run', `#!/usr/bin/env bash\nsummary='the daemon${RS}s runner'; off='stopped'`, `daemon${RS}s runner'; off='stopped'`, "; on='running'"),
  exact('code', 'TypeScript with a prose comment block', 'mixed.ts', `/**\n * The daemon${RS}s runner stays warm.\n */\nexport const rows = [{ summary: 'the runner', off: 'stopped' }]\n`, `The daemon${RS}s runner stays warm.`, ` It stays "warm", said the note.`),
  unknown('no extension', 'NOTES', `summary: the daemon${RS}s runner, off: 'stopped'`, `daemon${RS}s runner, off: 'stopped'`, ", on: 'running'"),
  unknown('a dotfile', '.editorconfig', `summary = 'the daemon${RS}s runner', off = 'stopped'`, `daemon${RS}s runner', off = 'stopped'`, ", on = 'running'"),
  unknown('a suffix outside the registry', 'rows.conf', `summary = "the daemon${RS}s runner", off = "stopped"`, `daemon${RS}s runner", off = "stopped"`, ', on = "running"'),
  unknown('a suffix outside the registry, curly double quotes in the matched text', 'said.conf', `text = "she said ${LD}warm${RD}", off = "stopped"`, `said ${LD}warm${RD}", off = "stopped"`, ', on = "running"'),
  unknown('a script whose first line names a shell the registry does not know (zsh)', 'tool', `#!/usr/bin/env zsh\nsummary='the daemon${RS}s runner'; off='stopped'`, `daemon${RS}s runner'; off='stopped'`, "; on='running'"),
  prose('Markdown', 'notes.md'),
  prose('plain text', 'notes.txt'),
]
for (const row of rows) writeFileSync(join(work, row.file), row.content)

const ASK = 'byte-exact-matrix'
const editResults: SeenResult[] = []
const fixture = await startScriptedFixture(req => {
  if (req.ask.trim() !== ASK) return [{ type: 'text', text: 'ok' }]
  switch (req.step) {
    case 0:
      return rows.map(row => ({ type: 'tool_use' as const, name: 'Read', input: { file_path: join(work, row.file) } }))
    case 1:
      return rows.map(row => ({ type: 'tool_use' as const, name: 'Edit', input: { file_path: join(work, row.file), old_string: row.oldString, new_string: row.newString } }))
    default:
      if (req.step === 2) editResults.push(...req.results)
      return [{ type: 'text', text: 'done' }]
  }
})

let turn: { exitCode: number | null; stderr: string } = { exitCode: null, stderr: '' }
try {
  turn = await runScriptedTurn({ runHome: join(scratch, 'home'), cwd: work, base: fixture.base, ask: ASK, timeoutMs: 120_000, extraArgv: ['--dangerously-bypass-permissions'] })
} finally {
  await fixture.close()
}

tally.section('A. the turn ran every edit through the built bundle')
tally.check('A1 the run settled', turn.exitCode === 0, `exit ${turn.exitCode ?? '?'}: ${turn.stderr.slice(-400)}`)
tally.check(`A2 one Edit result per row (${rows.length})`, editResults.length === rows.length, `results=${editResults.length}`)

const landed = (row: Row, label: string): string => {
  const result = editResults[rows.indexOf(row)]
  const after = readFileSync(join(work, row.file), 'utf8')
  tally.check(`${label} ${row.language}: the edit landed (the typed quotes found the file's typographic ones)`, result !== undefined && !result.isError && /has been updated successfully/.test(result.text), result?.text.slice(0, 200))
  return after
}

tally.section('B. code, configuration and data: the straightened match finds the old string and the new bytes land byte for byte')
for (const row of rows.filter(row => row.kind === 'code')) {
  const after = landed(row, 'B')
  tally.check(`B ${row.language}: the bytes read back with the straight quotes intact and the file's own typography kept outside the change`, after === row.expected, JSON.stringify(after))
}
const tsAfter = readFileSync(join(work, 'rows.ts'), 'utf8')
tally.check('B TypeScript: the dashes, the ellipsis, the three dots and the double space inside the new string land untouched', tsAfter.includes("on: 'running -- a — b … c ... d  e'"), JSON.stringify(tsAfter))
const mixedAfter = readFileSync(join(work, 'mixed.ts'), 'utf8')
tally.check('B TypeScript with a prose comment block: the code law wins inside the comment too (straight quotes stand, the apostrophe outside the change stands)', mixedAfter.includes(`The daemon${RS}s runner stays warm. It stays "warm", said the note.`), JSON.stringify(mixedAfter))

tally.section('U. a file the registry cannot name lands byte for byte like code')
for (const row of rows.filter(row => row.kind === 'unknown')) {
  const after = landed(row, 'U')
  tally.check(`U ${row.language}: the new quotes stay straight and the file's own typography stands outside the change`, after === row.expected, JSON.stringify(after))
}

tally.section("C. prose keeps today's behaviour: new quotes inside a typographic line take the file's style")
for (const row of rows.filter(row => row.kind === 'prose')) {
  const after = landed(row, 'C')
  tally.check(`C ${row.language}: the new quotes are typographic and the file's apostrophe stands`, after === row.expected, JSON.stringify(after))
}

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`\nworld kept: ${scratch}`)
tally.finish()
