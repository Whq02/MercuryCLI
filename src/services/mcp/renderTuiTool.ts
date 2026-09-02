/* ============================================================================
   renderTuiTool — the body behind the coordination server's `render_tui` tool.
   ----------------------------------------------------------------------------
   Shells out to the `scripts/ui/render-tui.ts` CLI (Task 3 tooling: synthetic
   session → pyte PTY capture → PNG), reads the resulting PNG, and returns it as
   an MCP **image content block** so the calling agent SEES the render inline
   (the "verify by RENDERING, not asserting" floor, but agent-reachable).

   Tooling-only: invoked solely via MCP; adds no new runtime deps (it spawns the
   already-present bun CLI). Read-only — it captures, it does not mutate the repo.
   ============================================================================ */

import { spawnSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallToolResult } from './sdk.js'

/** Run the render-tui CLI and return the captured TUI as an MCP image block. */
export function renderTui(opts: {
  scenario?: string
  cols?: number
  rows?: number
}): CallToolResult {
  const repo = process.cwd()
  const cols = opts.cols ?? 120
  const rows = opts.rows ?? 44
  // C2: platform-honest paths — /tmp and HOME! crashed
  // this tool on win32 (tmpdir/homedir are the owners).
  const out = join(tmpdir(), `render-tui-mcp-${cols}.png`)
  rmSync(out, { force: true }) // never return a stale PNG from a prior call
  const res = spawnSync(
    join(homedir(), '.bun/bin/bun'),
    [
      'run',
      join(repo, 'scripts/ui/render-tui.ts'),
      '--scenario',
      opts.scenario ?? 'resume-2turn',
      '--cols',
      String(cols),
      '--rows',
      String(rows),
      '--out',
      out,
    ],
    { windowsHide: true, encoding: 'utf-8', timeout: 45000, env: { ...subprocessEnv() } },
  )
  if (res.error || res.status !== 0 || !existsSync(out)) {
    return {
      isError: true,
      content: [
        // C2: surface the SPAWN error too — on win32 a missing bun/ENOENT
        // must not read as a bare 'no PNG' with the real cause swallowed.
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
