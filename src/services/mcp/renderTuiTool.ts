

import { spawnSync } from 'node:child_process'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CallToolResult } from './sdk.js'

export function renderTui(opts: {
  scenario?: string
  cols?: number
  rows?: number
}): CallToolResult {
  const repo = process.cwd()
  const cols = opts.cols ?? 120
  const rows = opts.rows ?? 44
  const out = join(tmpdir(), `render-tui-mcp-${cols}.png`)
  rmSync(out, { force: true })
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
