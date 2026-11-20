import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join as nativeJoin, relative as nativeRelative, resolve as nativeResolve } from 'node:path'

export const join: typeof nativeJoin = process.platform === 'win32' ? (...parts) => nativeJoin(...parts).replace(/\\/g, '/') : nativeJoin
export const relative: typeof nativeRelative = process.platform === 'win32' ? (from, to) => nativeRelative(from, to).replace(/\\/g, '/') : nativeRelative
export const resolve: typeof nativeResolve = process.platform === 'win32' ? (...parts) => nativeResolve(...parts).replace(/\\/g, '/') : nativeResolve

export type Ext = 'ts' | 'tsx' | 'mjs' | 'js' | 'py' | 'sh'
export const EXT_RE = /\.(ts|tsx|mjs|js|py|sh)$/
export const extOf = (p: string): Ext | null => (EXT_RE.exec(p)?.[1] as Ext | undefined) ?? null

export const PREFLIGHT = '--preflight'
const SHELL_FILE_TEST = /(?:\[\[?|\btest)\s+(?:!\s+)?-[a-zA-Z]\s+(?:"[^"]*"|'[^']*'|\S+)(?:\s+\]\]?)?/g
const ENV_GATED = /\$\{[A-Z_]+:-0\}"?\s*=\s*"1"/
const SHELL_WORDS = /^\s*(?:say|echo|printf)\s[^;&|`$]*$/
const COMPLEMENT = /cat\s+(?:scripts\/|"\$here"\/\.\.\/)([A-Za-z0-9_-]+)-\*\/members\.txt/

export function codeLines(path: string): string[] {
  const ext = extOf(path)
  const out: string[] = []
  let block = false
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const t = raw.trim()
    if (ext === 'py' || ext === 'sh') {
      if (t.startsWith('#')) continue
      out.push(raw.replace(/\s#\s.*$/, ''))
      continue
    }
    if (block) {
      if (t.includes('*/')) block = false
      continue
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) block = true
      continue
    }
    if (t.startsWith('//') || t.startsWith('*')) continue
    out.push(raw.replace(/\s\/\/\s.*$/, ''))
  }
  return out
}

export function isFile(p: string): boolean {
  return existsSync(p) && statSync(p).isFile()
}

function globDir(dir: string, pattern: string): string[] {
  if (!existsSync(dir)) return []
  const re = new RegExp(`^${pattern.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return readdirSync(dir).filter(n => re.test(n)).map(n => join(dir, n)).filter(isFile)
}

export function shellTargets(root: string, file: string): Set<string> {
  const scriptsDir = join(root, 'scripts')
  const dir = dirname(file)
  const out = new Set<string>()
  let gated = false
  for (const raw of codeLines(file)) {
    if (gated) {
      if (/^\s*fi\b/.test(raw)) gated = false
      continue
    }
    if (/^\s*if\b/.test(raw) && ENV_GATED.test(raw)) {
      gated = true
      continue
    }
    if (ENV_GATED.test(raw)) continue
    const loop = /^\s*for\s+\w+\s+in\s+((?:prove-[A-Za-z0-9_-]+\s+)*prove-[A-Za-z0-9_-]+)\s*;/.exec(raw)
    if (loop) {
      for (const n of loop[1]!.split(/\s+/)) {
        const p = join(dir, `${n}.ts`)
        if (isFile(p)) out.add(p)
      }
    }
    if (raw.includes(PREFLIGHT)) continue
    if (SHELL_WORDS.test(raw)) continue
    const line = raw
      .replace(SHELL_FILE_TEST, ' ')
      .replace(/"\$\(dirname "\$0"\)"/g, dir)
      .replace(/"?\$\{?(?:here|HERE|DIR|dir|SUITE_DIR)\}?"?(?=\/)/g, dir)
      .replace(/"?\$\{?(?:root|ROOT|REPO|repo|repo_root|REPO_ROOT)\}?"?(?=\/)/g, root)
    const tokens = process.platform === 'win32'
      ? line.match(/(?:[A-Za-z]:)?[A-Za-z0-9_./*-]+\.(?:ts|tsx|mjs|js|py|sh)\b/g)
      : line.match(/[A-Za-z0-9_./*-]+\.(?:ts|tsx|mjs|js|py|sh)\b/g)
    for (const tok of tokens ?? []) {
      let p = tok.startsWith('/') || (process.platform === 'win32' && /^[A-Za-z]:\//.test(tok)) ? tok : tok.startsWith('scripts/') ? join(root, tok) : join(dir, tok)
      p = resolve(p)
      if (!p.startsWith(`${scriptsDir}/`)) continue
      if (p.includes('*')) for (const g of globDir(dirname(p), basename(p))) out.add(g)
      else if (isFile(p)) out.add(p)
    }
  }
  return out
}

export function runnerLaunches(root: string): Array<{ suite: string; launched: string[] }> {
  const scriptsDir = join(root, 'scripts')
  const suites = readdirSync(scriptsDir)
    .filter(d => isFile(join(scriptsDir, d, 'run-all.sh')))
    .sort()
  const members = new Map<string, Set<string>>()
  for (const s of suites) {
    const mf = join(scriptsDir, s, 'members.txt')
    if (!isFile(mf)) continue
    const parent = /scripts\/([A-Za-z0-9_-]+)\/\$name/.exec(readFileSync(join(scriptsDir, s, 'run-all.sh'), 'utf8'))?.[1]
    if (!parent) continue
    const set = new Set<string>()
    for (const line of readFileSync(mf, 'utf8').split('\n')) {
      const n = line.split('#')[0]!.trim().split(/\s+/)[0]!
      const f = n.startsWith('scripts/') ? join(root, n) : join(scriptsDir, parent, n)
      if (n && isFile(f)) set.add(f)
    }
    members.set(s, set)
  }
  return suites.map(s => {
    const runner = join(scriptsDir, s, 'run-all.sh')
    const start = new Set<string>([...shellTargets(root, runner), ...(members.get(s) ?? [])])
    const complement = COMPLEMENT.exec(readFileSync(runner, 'utf8'))?.[1]
    if (complement) for (const [sib, set] of members) if (sib.startsWith(`${complement}-`)) for (const f of set) start.delete(f)
    start.delete(runner)
    return { suite: s, launched: [...start].sort().map(f => relative(root, f)) }
  })
}
