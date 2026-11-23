#!/usr/bin/env bun
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { flagEnv } from '../../src/platform/substrate/flagRegistry.ts'

const ROOT = resolve(import.meta.dir, '..', '..')
const NAME = 'MERCURY_SESSION_HOME'
const J = (...parts: string[]): string => parts.join('')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  const doorFixHint = ' | fix: the door is the flagEnv signature and body in the flag registry (FLAG_REGISTRY) (its optional environment parameter is a one-element tuple, and an environment handed in must be read instead of the process); the section 2 checks read the compiler diagnostics on a planted file that calls it'
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? `${detail ? ` — ${detail}` : ''}${doorFixHint}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

section('§1 at run time: the door reads the environment it is handed, and only that one')
{
  const held = process.env[NAME]
  process.env[NAME] = 'of-the-process'
  const forced = flagEnv as (name: string, from: unknown) => string | undefined
  check('flagEnv(name) reads the process', flagEnv(NAME) === 'of-the-process', String(flagEnv(NAME)))
  check('flagEnv(name, env) reads the environment handed in', flagEnv(NAME, { [NAME]: 'of-the-holder' }) === 'of-the-holder')
  check('an environment that holds no such name reads nothing, whatever the process holds', flagEnv(NAME, {}) === undefined)
  check('an environment that is handed in and undefined reads as empty, never as the process', forced(NAME, undefined) === undefined, String(forced(NAME, undefined)))
  check('the spelling for an optional holder reads nothing when the holder is absent', flagEnv(NAME, (undefined as Record<string, string> | undefined) ?? {}) === undefined)
  if (held === undefined) delete process.env[NAME]
  else process.env[NAME] = held
}

section('§2 at the typecheck: an environment that may be undefined is refused, and ?? {} is taken')
{
  const planted = join(ROOT, 'src', 'planted-optional-holder.ts')
  const lines = [
    `import { flagEnv } from './platform/${J('sub', 'strate')}/${J('flag', 'Registry')}.js'`,
    'const spec: { extraEnv?: Record<string, string> } = {}',
    `export const atTheProcess = flagEnv('${NAME}')`,
    `export const holder = flagEnv('${NAME}', { PATH: '/usr/bin' })`,
    `export const optional = flagEnv('${NAME}', spec.extraEnv)`,
    `export const taken = flagEnv('${NAME}', spec.extraEnv ?? {})`,
    `export const explicit = flagEnv('${NAME}', undefined)`,
    `export const pointFree = ['${NAME}'].map(flagEnv)`,
  ]
  const text = lines.join('\n') + '\n'
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile).config, ts.sys, ROOT)
  const options = { ...parsed.options, noEmit: true, incremental: false }
  const host = ts.createCompilerHost(options)
  const fileExists = host.fileExists.bind(host)
  const readFile = host.readFile.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  host.fileExists = file => file === planted || fileExists(file)
  host.readFile = file => (file === planted ? text : readFile(file))
  host.getSourceFile = (file, version, onError, fresh) => (file === planted ? ts.createSourceFile(file, text, version, true) : getSourceFile(file, version, onError, fresh))
  const program = ts.createProgram([planted], options, host)
  const source = program.getSourceFile(planted)
  const red = source === undefined ? [] : [...new Set(program.getSemanticDiagnostics(source).map(d => source.getLineAndCharacterOfPosition(d.start ?? 0).line + 1))].sort((a, b) => a - b)
  check('the planted file was read by the compiler with the project options', source !== undefined)
  check('a read at the process, at an environment and at an optional holder with ?? {} compile (lines 3, 4 and 6)', ![3, 4, 6].some(line => red.includes(line)), `red lines ${red.join(' ')}`)
  check('an optional holder handed bare is refused by the compiler (line 5)', red.includes(5), `red lines ${red.join(' ')}`)
  check('an explicit undefined is refused by the compiler (line 7)', red.includes(7), `red lines ${red.join(' ')}`)
  check('the door handed to map, which would take the index as its environment, is refused by the compiler (line 8)', red.includes(8), `red lines ${red.join(' ')}`)
}

console.log(failures === 0 ? '\nprove-flag-door-environment: green' : `\nprove-flag-door-environment: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
