


import { spawnSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CallToolResult } from './sdk.js'

export const RENDER_TUI_SCRIPT = join('scripts', 'ui', 'render-tui.ts')

const CHECKOUT_WALK_DEPTH = 6

export type RenderTuiPrerequisites =
  | { ready: true; root: string; bun: string }
  | { ready: false; reason: string }

export function renderTuiCheckoutRoot(from: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = from
  for (let depth = 0; depth < CHECKOUT_WALK_DEPTH; depth++) {
    if (existsSync(join(dir, RENDER_TUI_SCRIPT)) && existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function renderTuiRuntime(opts: { env?: NodeJS.ProcessEnv; home?: string } = {}): { bun: string } | { missing: string } {
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const pinned = (env.MERCURY_BUN ?? '').trim()
  if (pinned !== '') {
    return existsSync(pinned) ? { bun: pinned } : { missing: `the MERCURY_BUN pin ${pinned} does not exist` }
  }
  const exe = process.platform === 'win32' ? 'bun.exe' : 'bun'
  const userBun = join(home, '.bun', 'bin', exe)
  if (existsSync(userBun)) return { bun: userBun }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, exe)
    if (existsSync(candidate)) return { bun: candidate }
  }
  return { missing: `no bun runtime: set MERCURY_BUN=<path>, install bun at ${userBun}, or put bun on PATH` }
}

export function renderTuiPrerequisites(opts: { from?: string; env?: NodeJS.ProcessEnv; home?: string } = {}): RenderTuiPrerequisites {
  const root = renderTuiCheckoutRoot(opts.from)
  if (root === null) {
    return {
      ready: false,
      reason: `no Mercury source checkout beside this build (${RENDER_TUI_SCRIPT} not found above ${opts.from ?? dirname(fileURLToPath(import.meta.url))}) — the render script ships with the source tree, never with a release install`,
    }
  }
  const runtime = renderTuiRuntime({ ...(opts.env ? { env: opts.env } : {}), ...(opts.home ? { home: opts.home } : {}) })
  if ('missing' in runtime) return { ready: false, reason: runtime.missing }
  return { ready: true, root, bun: runtime.bun }
}

export function renderTui(opts: {
  scenario?: string
  cols?: number
  rows?: number
}): CallToolResult {
  const prerequisites = renderTuiPrerequisites()
  if (!prerequisites.ready) {
    return {
      isError: true,
      content: [{ type: 'text', text: `render_tui unavailable: ${prerequisites.reason}` }],
    }
  }
  const { root, bun } = prerequisites
  const cols = opts.cols ?? 120
  const rows = opts.rows ?? 44
  const out = join(tmpdir(), `render-tui-mcp-${cols}.png`)
  rmSync(out, { force: true })
  const res = spawnSync(
    bun,
    [
      'run',
      join(root, RENDER_TUI_SCRIPT),
      '--scenario',
      opts.scenario ?? 'resume-2turn',
      '--cols',
      String(cols),
      '--rows',
      String(rows),
      '--out',
      out,
    ],
    { cwd: root, windowsHide: true, encoding: 'utf-8', timeout: 45000, env: { ...subprocessEnv() } },
  )
  if (res.error || res.status !== 0 || !existsSync(out)) {
    return {
      isError: true,
      content: [
        { type: 'text', text: `render_tui failed: ${res.error ? String(res.error) : res.stderr || 'no PNG'}` },
      ],
    }
  }
  return {
    content: [
      {
        type: 'image',
        data: readFileSync(out).toString('base64'),
        mimeType: 'image/png',
      },
    ],
  }
}
