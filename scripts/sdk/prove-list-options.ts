import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { Command, Option } from 'commander'
import { argvOf } from '../../sdk/src/client.ts'
import { MercuryError } from '../../sdk/src/errors.ts'
import { RUN_OPTIONS } from '../../sdk/src/door.ts'
import { PYTHON } from './runtime.ts'
import { makeTally } from '../daemon/dupline-world.ts'

const tally = makeTally('prove-list-options')
type Row = { name: string; values: string[]; args?: string[]; error?: string }
const rows: Row[] = []
for (const name of ['allowedTools', 'blockTools', 'toolset', 'mcp', 'providerPreview']) {
  for (const values of [['--sovereign'], ['Read', '--sovereign'], ['-d'], ['Read', 'Bash(git --version)']]) {
    try { rows.push({ name, values, args: argvOf({ mercury: ['fixture'], prompt: 'hello', [name]: values }).args }) }
    catch (error) {
      if (!(error instanceof MercuryError)) throw error
      rows.push({ name, values, error: error.message })
    }
  }
}
const python = spawnSync(PYTHON, [join(import.meta.dir, 'python-list-options.py')], { encoding: 'utf8', env: { ...process.env, PYTHONPATH: join(import.meta.dir, '../../sdk-py/src'), PYTHONDONTWRITEBYTECODE: '1' } })
tally.check('Python argv probe completes', python.status === 0, python.stderr)
const pythonRows: Row[] = python.status === 0 ? JSON.parse(python.stdout) : []
for (const [language, cases] of [['TypeScript', rows], ['Python', pythonRows]] as const) {
  for (const row of cases) {
    const malicious = row.values.some(value => value.startsWith('-'))
    const parser = new Command().name('fixture').exitOverride().argument('[prompt]')
    for (const entry of RUN_OPTIONS) parser.addOption(new Option(entry.flag + (entry.value === 'none' ? '' : entry.value === 'optional' ? ' [value]' : entry.value === 'variadic' ? ' <values...>' : ' <value>')))
    parser.configureOutput({ writeErr: () => {} })
    try { if (row.args) parser.parse(row.args.slice(1), { from: 'user' }) } catch {}
    const opts = parser.opts()
    console.log(JSON.stringify({ language, name: row.name, values: row.values, error: row.error, sovereign: opts.sovereign ?? false }))
    if (malicious) tally.check(`${language} ${row.name}: refuses flag-shaped list value`, row.args === undefined && row.error?.startsWith('error: option ') === true && row.error.endsWith(' is invalid.'))
    else {
      const key = row.name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      tally.check(`${language} ${row.name}: repeated values parse unchanged`, JSON.stringify(opts[key]) === JSON.stringify(row.values))
      tally.check(`${language} ${row.name}: values stay attached to their flags`, row.args?.filter(arg => arg.startsWith('--') && arg.includes('=')).length === row.values.length)
    }
  }
}
tally.finish()
