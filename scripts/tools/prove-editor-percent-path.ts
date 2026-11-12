import { mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const arg = process.argv.indexOf('--source-root')
const root = arg < 0 ? resolve(dirname(fileURLToPath(import.meta.url)), '../..') : resolve(process.argv[arg + 1]!)

type SpawnOpts = { env?: Record<string, string>; shell?: boolean | string; windowsVerbatimArguments?: boolean }
type RecordedSpawn = {
  rawArgsLength: number
  file: string
  args: string[]
  env: Record<string, string>
  shell: boolean | string | undefined
  windowsVerbatimArguments: boolean
}

const childProcess = await import('node:child_process')
let spawned: RecordedSpawn | undefined
mock.module('node:child_process', () => ({
  ...childProcess,
  spawn: (first: string, second?: readonly string[] | SpawnOpts, third?: SpawnOpts) => {
    if (Array.isArray(second)) {
      const opts = third ?? {}
      spawned = {
        rawArgsLength: 3,
        file: first,
        args: [...second],
        env: (opts.env ?? {}) as Record<string, string>,
        shell: opts.shell,
        windowsVerbatimArguments: opts.windowsVerbatimArguments === true,
      }
    } else {
      const opts = (second ?? {}) as SpawnOpts
      const env = (opts.env ?? {}) as Record<string, string>
      if (process.platform === 'win32' && opts.shell) {
        const comSpec = typeof opts.shell === 'string' ? opts.shell : env.ComSpec || env.COMSPEC || 'cmd.exe'
        const isCmd = /(?:^|[\\/])cmd(?:\.exe)?$/i.test(comSpec)
        spawned = {
          rawArgsLength: 2,
          file: comSpec,
          args: isCmd ? ['/d', '/s', '/c', `"${first}"`] : ['-c', first],
          env,
          shell: opts.shell,
          windowsVerbatimArguments: isCmd,
        }
      } else {
        spawned = {
          rawArgsLength: 2,
          file: first,
          args: [],
          env,
          shell: opts.shell,
          windowsVerbatimArguments: opts.windowsVerbatimArguments === true,
        }
      }
    }
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('exit', 0))
    return child
  },
}))

const { editorCommandLine, editFileInEditor } = await import(`${root}/src/utils/promptEditor.ts`)
let checks = 0
let failures = 0
const check = (label: string, pass: boolean, actual: string): void => {
  checks++
  if (!pass) failures++
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${label}: ${actual}`)
}

const expandPercent = (line: string, env: Record<string, string>): string =>
  line.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? whole)

const expandDelayedBang = (line: string, env: Record<string, string>): string => {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (line[i] !== '!') {
      out += line[i]!
      i++
      continue
    }
    const close = line.indexOf('!', i + 1)
    if (close < 0) {
      i++
      continue
    }
    const name = line.slice(i + 1, close)
    if (name.length > 0) out += env[name] ?? ''
    i = close + 1
  }
  return out
}

function splitQuotedTokens(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQ = false
  let started = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (c === '"') {
      inQ = !inQ
      started = true
      continue
    }
    if (!inQ && (c === ' ' || c === '\t')) {
      if (started) {
        out.push(cur)
        cur = ''
        started = false
      }
      continue
    }
    cur += c
    started = true
  }
  if (started) out.push(cur)
  return out
}

function simulateWindowsInterpreter(
  rec: RecordedSpawn,
  opts: { registryDelayedExpansion: boolean },
): { ok: boolean; argv: string[]; detail: string } {
  const exeLower = rec.file.toLowerCase().replace(/^"+|"+$/g, '')
  if (/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/.test(exeLower)) {
    const cmdIdx = rec.args.findIndex(a => /^-c(?:ommand)?$/i.test(a))
    const script = cmdIdx >= 0 ? (rec.args[cmdIdx + 1] ?? '') : ''
    const trimmed = script.trim()
    if (!trimmed.startsWith('& ')) {
      return { ok: false, argv: [], detail: `PowerShell requires & call operator: ${script}` }
    }
    const rest = trimmed.slice(2).trim()
    const tokens: string[] = []
    let i = 0
    while (i < rest.length) {
      while (i < rest.length && /\s/.test(rest[i]!)) i++
      if (i >= rest.length) break
      if (rest[i] === "'") {
        i++
        let val = ''
        while (i < rest.length) {
          if (rest[i] === "'" && rest[i + 1] === "'") {
            val += "'"
            i += 2
          } else if (rest[i] === "'") {
            i++
            break
          } else {
            val += rest[i]!
            i++
          }
        }
        tokens.push(val)
      } else if (rest[i] === '"') {
        i++
        let val = ''
        while (i < rest.length) {
          if (rest[i] === '`' && i + 1 < rest.length) {
            const nxt = rest[i + 1]!
            val += nxt === 'n' ? '\n' : nxt === 't' ? '\t' : nxt === 'r' ? '\r' : nxt
            i += 2
          } else if (rest[i] === '"') {
            i++
            break
          } else {
            val += rest[i]!
            i++
          }
        }
        val = val
          .replace(/\$\(1\+1\)/g, '2')
          .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_w, k: string) => rec.env[k] ?? '')
          .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_w, k: string) => rec.env[k] ?? `/expanded-${k}`)
        tokens.push(val)
      } else {
        let rawTok = ''
        while (i < rest.length && !/\s/.test(rest[i]!)) {
          rawTok += rest[i]!
          i++
        }
        const envMatch = /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(rawTok)
        tokens.push(envMatch ? (rec.env[envMatch[1]!] ?? '') : rawTok)
      }
    }
    return { ok: true, argv: tokens, detail: JSON.stringify(tokens) }
  }

  const cIdx = rec.args.findIndex(a => a.toLowerCase() === '/c')
  const flags = cIdx >= 0 ? rec.args.slice(0, cIdx).map(a => a.toLowerCase()) : []
  let delayed = opts.registryDelayedExpansion
  for (const flag of flags) {
    if (flag === '/v:on' || flag === '/v') delayed = true
    if (flag === '/v:off') delayed = false
  }
  let body = cIdx >= 0 ? (rec.args[cIdx + 1] ?? '') : ''
  if (flags.includes('/s') && body.startsWith('"') && body.endsWith('"') && body.length >= 2) {
    body = body.slice(1, -1)
  }
  let expanded = expandPercent(body, rec.env)
  if (delayed) expanded = expandDelayedBang(expanded, rec.env)
  const argv = splitQuotedTokens(expanded)
  return { ok: true, argv, detail: JSON.stringify(argv) }
}

for (const filePath of [
  String.raw`C:\work\%NAME%\draft.md`,
  String.raw`C:\work dir\%NAME%-%OTHER%.md`,
  String.raw`C:\work\100% complete.md`,
  String.raw`C:\work\plain.md`,
]) {
  const line = editorCommandLine('editor.exe', ['--wait'], filePath, 'win32')
  const expanded = expandPercent(line, { NAME: 'wrong-directory', OTHER: 'wrong-file', MERCURY_EDITOR_FILE: filePath })
  const expected = `"editor.exe" "--wait" "${filePath}"`
  check(`Windows passes the literal draft path ${filePath}`, expanded === expected, expanded)
}
const path = String.raw`C:\work\%NAME%.md`
const configured = expandPercent(editorCommandLine('editor.exe', ['--profile', '%NAME%'], path, 'win32'), {
  NAME: 'work',
  MERCURY_EDITOR_FILE: path,
})
check('variables in the editor setting still expand, not variables inside the draft path', configured === `"editor.exe" "--profile" "work" "${path}"`, configured)
const posix = editorCommandLine('editor', [], '/work/%NAME%.md', 'linux')
check('the POSIX path quoting is unchanged', posix === '"editor" \'/work/%NAME%.md\'', posix)

const scratch = mkdtempSync(join(tmpdir(), 'editor-percent-'))
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const savedComSpec = process.env.ComSpec
const savedCOMSPEC = process.env.COMSPEC
const savedHome = process.env.HOME
const instances = (await import(`${root}/src/ink/instances.ts`)).default
const handback = await import(`${root}/src/utils/terminalHandback.ts`)
const { getExternalEditor } = await import(`${root}/src/utils/editor.ts`)
handback.setTerminalHandbackAddonForTest(null)
handback.setTerminalHandbackDescriptorForTest('none')
instances.set(
  process.stdout,
  new Proxy({}, { get: (_target, name) => (name === 'awaitTerminalQueries' ? async () => undefined : () => undefined) }),
)
try {
  const executable = join(scratch, 'proof-editor.exe')
  const draftPercent = join(scratch, 'draft-%NAME%.md')
  const draftBang = join(scratch, 'draft-!SECRET!-!gone!end.md')
  const draftPs = join(scratch, "draft-%NAME%-!SECRET!-it's-$HOME.md")
  writeFileSync(executable, '')
  chmodSync(executable, 0o755)
  writeFileSync(draftPercent, 'draft body\n')
  writeFileSync(draftBang, 'bang body\n')
  writeFileSync(draftPs, 'ps body\n')
  delete process.env.VISUAL
  delete process.env.ComSpec
  delete process.env.COMSPEC
  process.env.EDITOR = executable
  process.env.NAME = 'wrong-file'
  process.env.SECRET = 'expanded-secret'

  getExternalEditor.cache.clear?.()
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const result = await editFileInEditor(draftPercent)
  Object.defineProperty(process, 'platform', descriptor)
  check('the real handoff reaches the spawn seam and reads the draft back', result.content === 'draft body\n' && spawned !== undefined, JSON.stringify(result))
  check('the Windows child receives the literal draft path in its own environment', spawned?.env.MERCURY_EDITOR_FILE === draftPercent, spawned?.env.MERCURY_EDITOR_FILE ?? '(absent)')
  const cmdDefault = spawned ? simulateWindowsInterpreter(spawned, { registryDelayedExpansion: false }) : { ok: false, argv: [], detail: 'no spawn' }
  check('the Windows launch under default cmd.exe expands to the literal draft, not NAME', cmdDefault.ok && JSON.stringify(cmdDefault.argv) === JSON.stringify([executable, draftPercent]), cmdDefault.detail)

  getExternalEditor.cache.clear?.()
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const bangResult = await editFileInEditor(draftBang)
  Object.defineProperty(process, 'platform', descriptor)
  const cmdDelayed = spawned ? simulateWindowsInterpreter(spawned, { registryDelayedExpansion: true }) : { ok: false, argv: [], detail: 'no spawn' }
  check(
    'with cmd.exe DelayedExpansion on in the registry, /v:off keeps ! literal in the draft path',
    bangResult.content === 'bang body\n' &&
      spawned?.windowsVerbatimArguments === true &&
      cmdDelayed.ok &&
      JSON.stringify(cmdDelayed.argv) === JSON.stringify([executable, draftBang]),
    cmdDelayed.detail,
  )

  for (const comSpec of [
    String.raw`C:\Program Files\PowerShell\7\pwsh.exe`,
    String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
  ]) {
    process.env.ComSpec = comSpec
    process.env.EDITOR = `"${executable}" --wait`
    getExternalEditor.cache.clear?.()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const psResult = await editFileInEditor(draftPs)
    Object.defineProperty(process, 'platform', descriptor)
    const simPs = spawned ? simulateWindowsInterpreter(spawned, { registryDelayedExpansion: true }) : { ok: false, argv: [], detail: 'no spawn' }
    check(
      `ComSpec=${comSpec}: hands the editor the literal draft path via $env:MERCURY_EDITOR_FILE instead of %MERCURY_EDITOR_FILE%`,
      psResult.content === 'ps body\n' &&
        simPs.ok &&
        JSON.stringify(simPs.argv) === JSON.stringify([executable, '--wait', draftPs]),
      simPs.detail,
    )
  }

  {
    const literalArg = "echo $HOME $(1+1) `n it's"
    process.env.ComSpec = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`
    process.env.HOME = String.raw`C:\Users\wrong-home`
    process.env.EDITOR = `"${executable}" --cmd "${literalArg}"`
    getExternalEditor.cache.clear?.()
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const psArgResult = await editFileInEditor(draftPs)
    Object.defineProperty(process, 'platform', descriptor)
    const simPsArgs = spawned ? simulateWindowsInterpreter(spawned, { registryDelayedExpansion: true }) : { ok: false, argv: [], detail: 'no spawn' }
    check(
      'ComSpec=pwsh.exe single-quotes editor arguments so $HOME, $(1+1), backticks and apostrophes arrive byte for byte',
      psArgResult.content === 'ps body\n' &&
        simPsArgs.ok &&
        JSON.stringify(simPsArgs.argv) === JSON.stringify([executable, '--cmd', literalArg, draftPs]),
      simPsArgs.detail,
    )
  }

  delete process.env.ComSpec
  process.env.EDITOR = `"${executable}" --wait`
  Object.defineProperty(process, 'platform', { value: 'linux' })
  const linuxResult = await editFileInEditor(draftPercent)
  Object.defineProperty(process, 'platform', descriptor)
  check(
    'POSIX continues to spawn the single-quoted command line through shell: true',
    linuxResult.content === 'draft body\n' && spawned?.rawArgsLength === 2 && spawned.shell === true && spawned.env.MERCURY_EDITOR_FILE === undefined,
    JSON.stringify({ rawArgsLength: spawned?.rawArgsLength, shell: spawned?.shell }),
  )
} finally {
  Object.defineProperty(process, 'platform', descriptor)
  if (savedComSpec === undefined) delete process.env.ComSpec
  else process.env.ComSpec = savedComSpec
  if (savedCOMSPEC === undefined) delete process.env.COMSPEC
  else process.env.COMSPEC = savedCOMSPEC
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  instances.delete(process.stdout)
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`${checks - failures}/${checks} checks; ${failures} red`)
process.exit(failures === 0 ? 0 : 1)
