#!/usr/bin/env bun
import { execSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRIPTS = join(ROOT, 'scripts')
const BUN = process.env.BUN ?? process.execPath
const OWNER_MODEL = 'local/qwen3.5:27b'

let fail = 0
function check(ok: boolean, words: string, detail = ''): void {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${words}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}
function section(title: string): void {
  console.log(`\n── ${title}`)
}

const tracked = (patterns: string[]): string[] =>
  execSync(`git ls-files ${patterns.map(p => `'${p}'`).join(' ')}`, { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

const sources = new Map<string, string>()
function read(file: string): string {
  const abs = resolve(ROOT, file)
  if (!sources.has(abs)) sources.set(abs, readFileSync(abs, 'utf8'))
  return sources.get(abs)!
}
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/
function code(file: string): string {
  return read(file)
    .split('\n')
    .map(line => (COMMENT_LINE.test(line) ? '' : line))
    .join('\n')
}

section('the product spells its config home once')
{
  const SPELLING = /(homedir\(\)|process\.env\.HOME\b|process\.env\.USERPROFILE\b|\$\{?HOME\}?)[^\n]*['"`]\.mercury['"`]|['"`]\.mercury['"`][^\n]*(homedir\(\)|process\.env\.HOME\b)/
  const offenders: string[] = []
  for (const file of tracked(['src/**/*.ts', 'src/**/*.tsx'])) {
    if (file === 'src/utils/envUtils.ts') continue
    code(file)
      .split('\n')
      .forEach((line, i) => {
        if (SPELLING.test(line)) offenders.push(`${file}:${i + 1}`)
      })
  }
  check(
    /homedir\(\), '\.mercury'/.test(code('src/utils/envUtils.ts')),
    'src/utils/envUtils.ts derives the default home from homedir() (the one resolver)',
  )
  check(offenders.length === 0, 'no other product module joins the operator home with .mercury (settings, model choice and session facts ride getMercuryHome)', offenders.join(', '))
}

const PRODUCT_LINE = /mercury\.mjs|render-tui\.ts/
const NOT_A_BOOT_LINE = /readFileSync|existsSync|statSync|readFile\(|console\.|throw |\[SKIP\]|\.log\(|import |grep /
const SPAWN_CALL = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|Bun\.spawn|fork)\s*\(/g

function balanced(text: string, open: number, o: string, c: string): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === o) depth++
    else if (text[i] === c) {
      depth--
      if (depth === 0) return i
    }
  }
  return text.length - 1
}

interface SpawnEnv {
  kind: 'inherit' | 'literal' | 'ident'
  text: string
  call: string
}

function spawnEnvs(text: string): SpawnEnv[] {
  const out: SpawnEnv[] = []
  for (const m of text.matchAll(SPAWN_CALL)) {
    const open = m.index + m[0].length - 1
    const close = balanced(text, open, '(', ')')
    const args = text.slice(open + 1, close)
    const env = /[{,]\s*env\s*:\s*/.exec(args)
    if (!env) {
      out.push({ kind: 'inherit', text: '', call: args })
      continue
    }
    const after = args.slice(env.index + env[0].length)
    if (after.startsWith('{')) {
      out.push({ kind: 'literal', text: after.slice(0, balanced(after, 0, '{', '}') + 1), call: args })
      continue
    }
    const ident = /^[A-Za-z_$][\w$.]*/.exec(after)?.[0] ?? ''
    out.push({ kind: ident === 'process.env' ? 'inherit' : 'ident', text: ident, call: args })
  }
  return out
}

function identLiterals(text: string, ident: string): string[] | null {
  if (ident.includes('.')) {
    const out: string[] = []
    for (const m of text.matchAll(/\benv\s*:\s*\{/g)) {
      const open = m.index + m[0].length - 1
      const literal = text.slice(open, balanced(text, open, '{', '}') + 1)
      if (/\bPATH\b|\bHOME\b|MERCURY_|\.\.\./.test(literal)) out.push(literal)
    }
    return out.length > 0 ? out : null
  }
  const m = new RegExp(`\\b(?:const|let|var)\\s+${ident.replace(/\$/g, '\\$')}\\b[^\\n]*`).exec(text)
  if (!m) return null
  const line = m[0]
  const arrow = line.indexOf('=>')
  const from = arrow >= 0 ? arrow + 2 : line.indexOf('=') + 1
  const brace = line.indexOf('{', from)
  if (from <= 0 || brace < 0) return null
  const open = m.index + brace
  return [text.slice(open, balanced(text, open, '{', '}') + 1)]
}

const INHERITS = /\.\.\.\(?\s*process\.env\b/

function imports(file: string): string[] {
  const out: string[] = []
  for (const m of read(file).matchAll(/(?:from\s+|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const spec = resolve(dirname(resolve(ROOT, file)), m[1]!)
    for (const cand of [spec, `${spec}.ts`, `${spec}.tsx`, `${spec}.mjs`, join(spec, 'index.ts')]) {
      if (existsSync(cand) && cand.startsWith(SCRIPTS + sep)) {
        out.push(cand)
        break
      }
    }
  }
  return out
}

function closureNames(file: string, needle: RegExp, memo: Map<string, boolean>, seen = new Set<string>()): boolean {
  const abs = resolve(ROOT, file)
  if (memo.has(abs)) return memo.get(abs)!
  if (seen.has(abs)) return false
  seen.add(abs)
  let ok = needle.test(code(abs))
  if (!ok) for (const dep of imports(abs)) if (closureNames(dep, needle, memo, seen)) { ok = true; break }
  memo.set(abs, ok)
  return ok
}

const bootingFiles = tracked(['scripts/**/*.ts', 'scripts/**/*.tsx', 'scripts/**/*.mjs']).filter(file => {
  const lines = code(file).split('\n')
  return lines.some(line => PRODUCT_LINE.test(line) && !NOT_A_BOOT_LINE.test(line)) && SPAWN_CALL.test(code(file))
})

function censusOfSpawnEnvs(
  law: RegExp,
  memo: Map<string, boolean>,
): { checked: number; offenders: string[] } {
  let checked = 0
  const offenders: string[] = []
  for (const file of bootingFiles) {
    const text = code(file)
    for (const env of spawnEnvs(text)) {
      if (env.kind === 'inherit') continue
      checked++
      const literals = env.kind === 'literal' ? [env.text] : identLiterals(text, env.text)
      if (literals === null) {
        if (!closureNames(file, law, memo)) offenders.push(`${file} (env ${env.text})`)
        continue
      }
      for (const literal of literals) {
        if (INHERITS.test(literal)) continue
        if (law.test(literal)) continue
        if (/\.\.\./.test(literal) && closureNames(file, law, memo)) continue
        offenders.push(`${file} :: ${literal.replace(/\s+/g, ' ').slice(0, 100)}`)
      }
    }
  }
  return { checked, offenders }
}

section('every proof child boots on a scratch config home')
{
  const { checked, offenders } = censusOfSpawnEnvs(/MERCURY_CONFIG_DIR|\bHOME\b|resolveProofHome/, new Map())
  check(bootingFiles.length > 300 && checked > 300, `the census read the estate (${bootingFiles.length} files boot the product, ${checked} curated child environments)`)
  check(offenders.length === 0, 'every curated child environment names MERCURY_CONFIG_DIR or a scratch HOME, or inherits the proof process environment the preload and the suite guard keep scratch', offenders.join('\n      '))
}

section('every proof child boots with the local-server probe off')
{
  const { checked, offenders } = censusOfSpawnEnvs(/MERCURY_LOCAL_PROBE_TARGETS/, new Map())
  check(checked > 100, `the census read the estate (${checked} curated child environments)`)
  check(offenders.length === 0, 'every curated child environment  names MERCURY_LOCAL_PROBE_TARGETS, or inherits the proof process environment', offenders.join('\n      '))
  const vshot = readFileSync(join(ROOT, 'scripts', 'ui', 'vshot.py'), 'utf8')
  const ptydrive = readFileSync(join(ROOT, 'scripts', 'streaming', 'ptydrive.py'), 'utf8')
  const SETDEFAULT = /os\.environ\.setdefault\("MERCURY_LOCAL_PROBE_TARGETS", "none"\)/
  check(SETDEFAULT.test(vshot) && vshot.indexOf('setdefault("MERCURY_LOCAL_PROBE_TARGETS"') < vshot.indexOf('os.execvp(argv[0], argv)'), 'scripts/ui/vshot.py pins the probe off in the child before it becomes the product')
  check(SETDEFAULT.test(ptydrive) && ptydrive.indexOf('setdefault("MERCURY_LOCAL_PROBE_TARGETS"') < ptydrive.indexOf('os.execvp(cmd[0], cmd)'), 'scripts/streaming/ptydrive.py pins the probe off in the child before it becomes the product')
  check(/MERCURY_LOCAL_PROBE_TARGETS \?\?= 'none'/.test(code('scripts/lib/proofHome.ts')), 'scripts/lib/proofHome.ts pins the probe off beside the file credential store')
  check(/MERCURY_LOCAL_PROBE_TARGETS \?\?= 'none'/.test(code('scripts/lib/proofHomePreload.ts')), 'scripts/lib/proofHomePreload.ts pins the probe off for every scripts/ entry')
  const guard = read('scripts/lib/suite-env.sh')
  check(/export MERCURY_LOCAL_PROBE_TARGETS="\$\{MERCURY_LOCAL_PROBE_TARGETS:-none\}"/.test(guard), 'scripts/lib/suite-env.sh exports the probe off for every suite it guards')
  check(/MERCURY_LOCAL_PROBE_TARGETS\) \[ "\$\{MERCURY_LOCAL_PROBE_TARGETS:-\}" = none \] && continue ;;/.test(guard), "scripts/lib/suite-env.sh admits the value 'none' alone as not foreign")
  check(/preload = \["\.\/scripts\/lib\/proofHomePreload\.ts"\]/.test(read('bunfig.toml')), 'bunfig.toml names the proof-home preload')
}

section("the roads at run time: the launcher's own pin, the operator's settings line, a suite")
const scratch = mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'proof-machine-census-'))
try {
  const home = join(scratch, 'home')
  mkdirSync(join(home, '.mercury'), { recursive: true })
  writeFileSync(join(home, '.mercury', 'settings.json'), JSON.stringify({ model: OWNER_MODEL }))
  const before = readdirSync(join(home, '.mercury')).sort().join(',')
  const clean = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: scratch,
    ...extra,
  })
  const preload = spawnSync(BUN, ['scripts/lib/proofHomePreload.ts'], {
    cwd: ROOT,
    env: clean({ MERCURY_CONFIG_DIR: join(home, '.mercury') }),
    encoding: 'utf8',
  })
  const [pinnedHome = '', probe = ''] = preload.stdout.split('\n')
  check(preload.status === 0 && pinnedHome !== '' && !pinnedHome.startsWith(home) && pinnedHome.startsWith(scratch), "a scripts/ entry launched with MERCURY_CONFIG_DIR at the operator's own $HOME/.mercury runs on a scratch home", `rc=${preload.status} home=${pinnedHome} ${preload.stderr.trim()}`)
  check(probe === 'none', 'that entry runs with the local-server probe off', `probe=${JSON.stringify(probe)}`)
  check(readdirSync(join(home, '.mercury')).sort().join(',') === before, "the operator's own .mercury is untouched (no seed, no write)", readdirSync(join(home, '.mercury')).join(','))
  check(JSON.parse(readFileSync(join(home, '.mercury', 'settings.json'), 'utf8')).model === OWNER_MODEL, 'its settings.json still carries the model line, unread and unwritten')

  const guardProbe = (env: NodeJS.ProcessEnv): { rc: number | null; out: string } => {
    const r = spawnSync('bash', ['-c', '. "$1" || exit 78; suite_env_guard "$2"; printf "%s\\n" "${MERCURY_LOCAL_PROBE_TARGETS:-}"', '_', join(ROOT, 'scripts', 'lib', 'suite-env.sh'), join(ROOT, 'scripts', 'gate', 'run-all.sh')], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
    })
    return { rc: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const unset = guardProbe(clean({ MERCURY_CONFIG_DIR: join(scratch, 'suite-home'), BUN: '/usr/bin/false' }))
  check(unset.rc === 0 && unset.out.trim().split('\n').pop() === 'none', 'a suite guarded with no probe target named runs with the probe off', `rc=${unset.rc} ${unset.out.trim()}`)
  const inherited = guardProbe(clean({ MERCURY_CONFIG_DIR: join(scratch, 'suite-home'), BUN: '/usr/bin/false', MERCURY_LOCAL_PROBE_TARGETS: 'none' }))
  check(inherited.rc === 0, "a suite launched by a proof already pinned to 'none' is not refused", `rc=${inherited.rc} ${inherited.out.trim()}`)
  const foreign = guardProbe(clean({ MERCURY_CONFIG_DIR: join(scratch, 'suite-home'), BUN: '/usr/bin/false', MERCURY_LOCAL_PROBE_TARGETS: 'ollama=http://127.0.0.1:1' }))
  check(foreign.rc === 78, 'a suite launched with a server named in the environment is refused as foreign', `rc=${foreign.rc} ${foreign.out.trim()}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(fail === 0 ? '\n✅ proof-machine census GREEN' : '\n❌ proof-machine census RED')
process.exit(fail)
