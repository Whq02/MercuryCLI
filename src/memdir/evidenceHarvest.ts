


import { execFile } from 'node:child_process'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { readFile } from 'node:fs/promises'
import { getInvocationTracePath } from '../utils/observability/invocationTrace.js'

const SHA_RE = /^[0-9a-f]{7,40}$/i
const TRACE_WINDOW_MS = 6 * 60 * 60 * 1000
const TRACE_TAIL_LINES = 200

function execGit(args: string[], cwd: string): Promise<string | null> {
  return new Promise(resolve => {
    try {
      execFile(
        'git',
        args,
        { windowsHide: true, cwd, timeout: 3_000, maxBuffer: 256 * 1024, env: { ...subprocessEnv() } },
        (err, stdout) => resolve(err ? null : String(stdout)),
      )
    } catch {
      resolve(null)
    }
  })
}

export async function harvestCommitEvidence(
  sourceRefs: readonly string[],
  cwd: string,
): Promise<string | null> {
  const sha = sourceRefs
    .flatMap(r => String(r ?? '').split(/[\s,;]+/))
    .find(tok => SHA_RE.test(tok))
  if (!sha) return null
  const out = await execGit(['show', '--stat', '--format=%h %s', sha], cwd)
  if (!out) return null
  const lines = out.split('\n').filter(Boolean)
  const head = lines[0]?.trim()
  if (!head) return null
  const statLine = lines.findLast(l => /files? changed/.test(l))?.trim()
  const paths = lines
    .filter(l => l.includes('|'))
    .slice(0, 4)
    .map(l => l.split('|')[0]!.trim())
  const pathNote = paths.length ? ` — ${paths.join(', ')}${lines.filter(l => l.includes('|')).length > 4 ? ', …' : ''}` : ''
  return `commit ${head}${statLine ? ` (${statLine})` : ''}${pathNote}`
}

export async function harvestTraceEvidence(
  opts: { tracePath?: string; nowMs?: number } = {},
): Promise<string | null> {
  const path = opts.tracePath ?? getInvocationTracePath()
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return null
  }
  const now = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now()
  const counts = new Map<string, { n: number; fail: number }>()
  let total = 0
  for (const line of raw.split('\n').filter(Boolean).slice(-TRACE_TAIL_LINES)) {
    let rec: { ts?: string; tool?: string; ok?: boolean }
    try {
      rec = JSON.parse(line) as typeof rec
    } catch {
      continue
    }
    if (typeof rec?.tool !== 'string' || !rec.tool) continue
    const ts = Date.parse(String(rec.ts ?? ''))
    if (!Number.isFinite(ts) || now - ts > TRACE_WINDOW_MS) continue
    const c = counts.get(rec.tool) ?? { n: 0, fail: 0 }
    c.n++
    if (rec.ok === false) c.fail++
    counts.set(rec.tool, c)
    total++
  }
  if (total === 0) return null
  const parts = [...counts.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 6)
    .map(([tool, c]) => `${tool} ×${c.n}${c.fail ? ` (${c.fail} fail)` : ''}`)
  return `trace tail (host-wide, ≤6h): ${parts.join(' · ')}`
}

export async function harvestCardEvidence(opts: {
  sourceRefs: readonly string[]
  cwd: string
  tracePath?: string
  nowMs?: number
}): Promise<string[]> {
  const [commit, trace] = await Promise.all([
    harvestCommitEvidence(opts.sourceRefs, opts.cwd).catch(() => null),
    harvestTraceEvidence({ tracePath: opts.tracePath, nowMs: opts.nowMs }).catch(() => null),
  ])
  return [commit, trace].filter((l): l is string => typeof l === 'string' && l.length > 0)
}
