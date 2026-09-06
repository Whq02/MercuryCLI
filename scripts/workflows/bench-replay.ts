#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

export type SuccessCheck =
  | { kind: 'cmd'; cmd: string }
  | { kind: 'grep'; file: string; pattern: string; flags?: string }
export type CorpusTask = {
  id: string
  title: string
  prompt: string
  baseRef: string
  timeboxMs: number
  successChecks: SuccessCheck[]
  tags: string[]
}
export const WORKSPACE_CONTAINMENT =
  'WORKSPACE CONTAINMENT: your workspace is exactly this repository checkout (your current working ' +
  'directory). Every path in the task is relative to it. Never read from, cd into, or modify any other ' +
  'checkout of this project — including the git origin this clone points at. Verify with `pwd` before ' +
  'running suite commands.'

const here = import.meta.dir
export const repoRoot = resolve(here, '..', '..')
const corpusDir = join(here, 'corpus')
export const CORPUS_TAG = 'bench-corpus-v1'
export const CORPUS_COMMIT = '7901eb241f265055a8ac7c31bee340c7c58751fa'

export function loadCorpus(): { tasks: CorpusTask[]; sha256: string } {
  const files = readdirSync(corpusDir).filter(f => f.endsWith('.json')).sort()
  const tasks: CorpusTask[] = []
  const h = createHash('sha256')
  for (const f of files) {
    const raw = readFileSync(join(corpusDir, f), 'utf-8')
    h.update(f).update('\0').update(raw)
    tasks.push(JSON.parse(raw) as CorpusTask)
  }
  return { tasks, sha256: h.digest('hex') }
}

export function judgeChecks(task: CorpusTask, cwd: string): { passed: number; total: number } {
  let passed = 0
  for (const c of task.successChecks) {
    try {
      if (c.kind === 'cmd') {
        execFileSync('bash', ['-lc', c.cmd], { cwd, stdio: 'pipe', timeout: 300_000 })
        passed++
      } else {
        const text = readFileSync(join(cwd, c.file), 'utf-8')
        if (new RegExp(c.pattern, c.flags).test(text)) passed++
      }
    } catch {
    }
  }
  return { passed, total: task.successChecks.length }
}

export function benchChildEnv(
  cfgDir: string,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (scrubbedEnvKey(k)) continue
    env[k] = v
  }
  env.MERCURY_CONFIG_DIR = cfgDir
  env.BROWSER = '/usr/bin/true'
  Object.assign(env, extra)
  return env
}
export function scrubbedEnvKey(k: string): boolean {
  if (/^(MERCURY_|HERMES_|TF_|CLAUDE_)/.test(k)) return true
  if (k === 'MERCURY_MODEL' || k === 'MERCURY_CONFIG_DIR') return true
  return false
}

export function cloneAtSha(dir: string, sha: string): void {
  execFileSync('git', ['clone', '--quiet', repoRoot, dir], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', sha], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'bench://neutered'], { stdio: 'pipe' })
  execFileSync('git', ['-C', dir, 'checkout', '--quiet', '--detach', sha], { stdio: 'pipe' })
  for (const name of ['node_modules', 'dist']) {
    const src = join(repoRoot, name)
    const dst = join(dir, name)
    if (!existsSync(src) || existsSync(dst)) continue
    try {
      execFileSync('cp', ['-c', '-R', src, dst], { stdio: 'pipe' })
    } catch {
      try {
        cpSync(src, dst, { recursive: true })
      } catch {
        symlinkSync(src, dst)
      }
    }
  }
}

export function readDefaultCredentialPayload(): string | null {
  if (process.platform !== 'darwin') return null
  const user = process.env.USER ?? ''
  for (const svc of [['Claude', 'Code-credentials'].join(' '), ['Claude', 'Code'].join(' ')]) {
    try {
      const out = execFileSync('security', ['find-generic-password', '-a', user, '-s', svc, '-w'], { stdio: 'pipe' })
        .toString()
        .trim()
      if (out.length > 0) return out
    } catch {
    }
  }
  return null
}
export function seedCredentials(cfgDir: string): void {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return
  const payload = readDefaultCredentialPayload()
  if (!payload) {
    throw new Error('no credentials to seed (no keychain payload, no ANTHROPIC_API_KEY) — children would all fail "Not logged in"')
  }
  const p = join(cfgDir, '.credentials.json')
  writeFileSync(p, payload, { mode: 0o600 })
}
export function scrubCredentials(cfgDir: string): void {
  try {
    rmSync(join(cfgDir, '.credentials.json'), { force: true })
  } catch {
  }
}

export function scrubLingeringBenchCredentials(): number {
  const benchRoot = join(repoRoot, '.claude', 'bench')
  let removed = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name === '.credentials.json') {
        try {
          rmSync(p, { force: true })
          removed++
        } catch {
        }
      }
    }
  }
  walk(benchRoot, 0)
  return removed
}
