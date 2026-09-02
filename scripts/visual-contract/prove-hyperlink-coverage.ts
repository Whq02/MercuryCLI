#!/usr/bin/env bun
// ============================================================================
//  scripts/visual-contract/prove-hyperlink-coverage.ts — OSC 8 hyperlink laws
//
//
//  §1 EMISSION AT THE OWNERS (flow path) — with the capability live-leg
//     forced (TERM_PROGRAM=iTerm.app), the two string/component owners emit
//     COMPLETE OSC 8 links (opener with URL + closer): createHyperlink for
//     transcript markdown URLs, and FilePathLink (file://) for tool-card
//     paths, component-rendered through the staticRender flow path.
//
//  §2 DEGRADE — the WHOLE APP resumed on a plain terminal (no TERM_PROGRAM)
//     writes ZERO OSC 8 bytes: degradation is silent, never broken chrome.
//
//  §3 HERMETICITY — no stored grid baseline (design-system/live included)
//     carries an OSC 8 fragment: captures stay hermetic by the capability
//     gate, matching the kitty-CSI-u precedent.
//
//  KNOWN SEAM (measured, rowed in the record as a named
//  follow-on): the fullscreen frame writer's per-cell diff does NOT model
//  hyperlinks — a link painted through the cockpit's cell path loses its
//  opener (the raw tee shows only the dangling `]8;;` closer). Fixing that
//  is frame-writer work, explicitly outside scope boundary; this
//  prover pins the OWNER emission + the degrade/hermeticity laws that hold
//  regardless of the writer.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
// §1's component render mounts the ink wrapper's ThemeProvider, whose config
// read is guarded outside test.
process.env.NODE_ENV = 'test'

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sanitizePath } from '../../src/utils/sessionStoragePortable.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { checker } from '../engine-durability/harness.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const t = checker()
const BIN = 'dist/mercury.mjs'
const scratch = mkdtempSync(join(tmpdir(), 'contour-hyperlink-'))
const FIXTURE_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-fixture-links'

function seedHome(name: string): string {
  const home = join(scratch, name)
  spawnSync(process.execPath, ['run', 'scripts/lib/firstRunSeed.ts', home, process.cwd()], {
    env: { ...process.env, ANTHROPIC_API_KEY: FIXTURE_KEY },
  })
  return home
}

function seedSession(home: string): string {
  const cwd = process.cwd()
  const SID = `00000000-bbbb-cccc-dddd-${(process.pid % 0xffffff).toString(16).padStart(12, '0')}`
  const projects = join(home, 'projects', sanitizePath(cwd))
  mkdirSync(projects, { recursive: true })
  const base = (extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId: SID,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    ...extra,
  })
  const READ_PATH = join(cwd, 'README.md')
  const lines = [
    base({
      parentUuid: null,
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000011',
      message: { role: 'user', content: 'read the readme, then point me at the docs' },
      timestamp: '2026-07-30T12:00:01.000Z',
    }),
    base({
      parentUuid: '00000000-0000-4000-8000-000000000011',
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000012',
      requestId: 'req_link_1',
      message: {
        id: 'msg_link_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [
          { type: 'tool_use', id: 'toolu_link_read', name: 'Read', input: { file_path: READ_PATH } },
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      timestamp: '2026-07-30T12:00:02.000Z',
    }),
    base({
      parentUuid: '00000000-0000-4000-8000-000000000012',
      type: 'user',
      uuid: '00000000-0000-4000-8000-000000000013',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_link_read',
            content: [{ type: 'text', text: '# Mercury\n' }],
          },
        ],
      },
      timestamp: '2026-07-30T12:00:03.000Z',
    }),
    base({
      parentUuid: '00000000-0000-4000-8000-000000000013',
      type: 'assistant',
      uuid: '00000000-0000-4000-8000-000000000014',
      requestId: 'req_link_2',
      message: {
        id: 'msg_link_2',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-8',
        content: [
          { type: 'text', text: 'LINKANCHOR read it — see [the field guide](https://example.invalid/guide) LINKDONE' },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      timestamp: '2026-07-30T12:00:04.000Z',
    }),
  ]
  // The session file holds RECORD lines — the shape the product opens.
  writeFileSync(join(projects, `${SID}.jsonl`), encodeSeedTranscript(lines, SID))
  return SID
}

function runResume(name: string, extraEnv: Record<string, string>): { status: number | null; tee: string } {
  const home = seedHome(`home-${name}`)
  const SID = seedSession(home)
  const out = join(scratch, `${name}.json`)
  const tee = join(scratch, `${name}.tee`)
  const cfgPath = join(scratch, `${name}-cfg.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      cols: 110,
      rows: 35,
      total: 110,
      argv: ['node', BIN, '--resume', SID],
      cwd: process.cwd(),
      readyText: 'LINKDONE',
      readySettleTicks: 6,
      out,
    }),
  )
  const r = spawnSync('/usr/bin/python3', ['scripts/ui/vshot.py', cfgPath], {
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      MERCURY_CONFIG_DIR: home,
      ANTHROPIC_API_KEY: FIXTURE_KEY,
      MERCURY_BOOT_PREFLIGHT: '0',
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_DOCTOR_STATE_DIR: join(scratch, `doctor-${name}`),
      MERCURY_DAEMON_DIR: join(scratch, `daemon-${name}`),
      VSHOT_TEE: tee,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: vshotBudgetMs(240_000),
  })
  let teeRaw = ''
  try {
    teeRaw = readFileSync(tee).toString('latin1')
  } catch {
    /* reported by the checks */
  }
  if (r.status !== 0) console.log((r.stdout ?? '').slice(-1200) + (r.stderr ?? '').slice(-1200))
  return { status: r.status, tee: teeRaw }
}

if (!existsSync(BIN)) {
  t.check('dist exists (build first)', false, BIN)
  t.finish('prove-hyperlink-coverage')
}

t.section('§1 — the owners emit COMPLETE OSC 8 links on the flow path')
{
  process.env.TERM_PROGRAM = 'iTerm.app'
  const React = (await import('react')).default
  const { createHyperlink } = await import('../../src/utils/hyperlink.ts')
  const { FilePathLink } = await import('../../src/components/FilePathLink.tsx')
  const { renderToAnsiString } = await import('../../src/utils/staticRender.tsx')

  const md = createHyperlink('https://example.invalid/guide', 'the field guide')
  t.check(
    'createHyperlink (transcript markdown owner) emits opener+text+closer',
    md.startsWith('\x1b]8;;https://example.invalid/guide\x07') && md.endsWith('\x1b]8;;\x07'),
    JSON.stringify(md),
  )

  const ansi = await renderToAnsiString(
    React.createElement(FilePathLink, { filePath: `${process.cwd()}/README.md` }),
  )
  t.check(
    'FilePathLink (tool-card path owner) emits a complete file:// link',
    // The opener may carry an id= param (wrapped-line grouping); the law is
    // a COMPLETE opener holding the file URL, then the closer.
    /\x1b\]8;[^;\x07]*;file:\/\/[^\x07]*README\.md\x07/.test(ansi) && ansi.includes('\x1b]8;;\x07'),
    JSON.stringify(ansi.slice(0, 160)),
  )
  delete process.env.TERM_PROGRAM
}

t.section('§2 — an incapable terminal degrades SILENTLY')
{
  const r = runResume('plain', {})
  t.check('the resume completed (vshot exit 0)', r.status === 0, `exit=${r.status}`)
  t.check(
    'zero OSC 8 bytes on a plain terminal (silent degrade)',
    !r.tee.includes('\x1b]8;;'),
    'no ]8;; fragments in the raw tee',
  )
}

t.section('§3 — stored grid baselines stay hermetic')
{
  const roots = ['scripts/visual-contract/baselines', 'design-system/live/grids']
  let scanned = 0
  const dirty: string[] = []
  for (const root of roots) {
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.json')) {
          scanned++
          if (readFileSync(p, 'utf8').includes(']8;;')) dirty.push(p)
        }
      }
    }
    walk(root)
  }
  t.check(
    `no stored grid carries an OSC 8 fragment (${scanned} scanned)`,
    scanned > 0 && dirty.length === 0,
    dirty.join(', ') || 'clean',
  )
}

rmSync(scratch, { recursive: true, force: true })
t.finish('prove-hyperlink-coverage')
