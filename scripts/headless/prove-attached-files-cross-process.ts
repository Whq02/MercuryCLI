#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { startFixtureApi, handoffTurn } from '../lib/fixtureApi.ts'
import { seedFirstRun, FIXTURE_API_KEY } from '../lib/firstRunSeed.ts'
import { hostRunner } from '../lib/runnerHost.ts'

const repo = join(import.meta.dir, '../..')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'attached-cross-process-')))
const driver = join(scratch, 'window.ts')
const node = Bun.which('node') ?? 'node'
let passed = 0
let failed = 0
const check = (label: string, ok: boolean): void => { ok ? passed++ : failed++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`) }
writeFileSync(driver, `
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
if (homedir() !== process.env.DRV_HOME) throw new Error('the home folder is not the scratch home of this proof')
globalThis.MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import(${JSON.stringify(join(repo, 'src/utils/config.ts'))})
enableConfigs()
const { readTranscriptChainSince } = await import(${JSON.stringify(join(repo, 'src/utils/sessionStorage/transcriptReader.ts'))})
const { deserializeLiveMessages } = await import(${JSON.stringify(join(repo, 'src/utils/conversationRecovery.ts'))})
const listing = await import(${JSON.stringify(join(repo, 'src/services/instructions/listing.ts'))})
const attached = await import(${JSON.stringify(join(repo, 'src/services/instructions/attachedText.ts'))})
const selector = await import(${JSON.stringify(join(repo, 'src/components/memory/memoryCentreLayout.ts'))})
const sample = Array.from({ length: 7 }, (_, index) => ({ label: './sub/' + index + '.md', value: String(index), description: 'Gemini · loaded with its folder' }))
const roomy = selector.memoryFileListLayout?.(sample, 88, 24, 0)
const crowded = selector.memoryFileListLayout?.(sample, 88, 3, 0)
const long = [{ label: './.cursor/rules/' + 'long-folder-name/'.repeat(5) + 'x.mdc', value: 'long', description: 'Cursor · loaded with src/**' }, ...sample]
const narrow = selector.memoryFileListLayout?.(long, 74, 26, 0)
const plan = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const messages = deserializeLiveMessages((await readTranscriptChainSince(plan.transcript, null)).rows)
const visible = attached.instructionsInMessages?.(messages) ?? []
const known = new Set(visible.map(entry => entry.path))
const held = path => known.has(path)
const files = await listing.getInstructionListing()
const nested = listing.attachedRows(held, files.map(row => row.path), visible)
const rows = [...files, ...nested].map(row => listing.listingRowWords(row, row.path, held, held))
writeFileSync(process.argv[3], JSON.stringify({ rows, visible, layout: { roomy, crowded, narrow }, concise: files.map(row => listing.listingRowWords(row, '', held, held)), boundaries: messages.filter(row => row.type === 'system' && row.subtype === 'compact_boundary').length, messages: messages.filter(row => row.type === 'attachment' && row.attachment.type === 'nested_memory').map(row => row.attachment.path) }))
`)
const findTranscript = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? findTranscript(join(dir, entry.name)) : entry.name.endsWith('.jsonl') ? [join(dir, entry.name)] : [])
try {
  for (const kind of ['oculus', 'headless'] as const) {
    const world = join(scratch, kind)
    const home = join(world, 'home')
    const config = join(home, '.mercury')
    const project = join(world, 'project')
    mkdirSync(project, { recursive: true })
    mkdirSync(home, { recursive: true })
    const sources = ['.cursor/rules/x.mdc', 'sub/GEMINI.md', 'own/MERCURY.md']
    for (const [file, text] of Object.entries({
      '.cursor/rules/x.mdc': '---\nglobs: src/**\n---\nscoped-rule-needle\n', 'src/a.ts': 'source\n',
      'sub/GEMINI.md': 'nested-guide-needle\n', 'sub/a.ts': 'source\n',
      'own/MERCURY.md': 'nested-native-needle\n', 'own/a.ts': 'source\n',
    })) {
      mkdirSync(dirname(join(project, file)), { recursive: true })
      writeFileSync(join(project, file), text)
    }
    seedFirstRun(config, [project])
    const api = await startFixtureApi([
      ...['src/a.ts', 'sub/a.ts', 'own/a.ts'].map(file => ({ kind: 'tool_use' as const, name: 'Read', input: { file_path: join(project, file) } })),
      { kind: 'text', text: 'All three sources were read.\n' + Array.from({ length: 1024 }, (_, index) => createHash('sha256').update(String(index)).digest('hex')).join('\n'), usage: { input_tokens: 35000, output_tokens: 24000 } },
      { kind: 'text', text: 'The three files were read. The requested work is still open; preserve the operator instructions and verify changes before reporting completion.', usage: { input_tokens: 59000, output_tokens: 40 } },
      handoffTurn(),
    ])
    const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, DRV_HOME: home, MERCURY_CONFIG_DIR: config, MERCURY_TMPDIR: join(home, 'tmp'), MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file', MERCURY_LOCAL_PROBE_TARGETS: 'none', MERCURY_SESSION_KIND: kind, MERCURY_COMPACT_KEEP_TAIL: '0', ANTHROPIC_API_KEY: FIXTURE_API_KEY, ANTHROPIC_BASE_URL: api.url }
    const host = hostRunner({ dist: join(repo, 'dist/mercury.mjs'), node, cwd: project, home, env, argv: ['--model', 'claude-opus-4-8'] })
    host.onAsk(() => ({ outcome: 'allow' }) as never)
    const view = (): { rows: string[]; visible: Array<{ path: string }>; boundaries: number; messages: string[]; concise: string[]; layout: Record<'roomy' | 'crowded' | 'narrow', { visibleOptionCount: number; layout: string } | undefined> } => {
      const sessionId = host.rows.find(row => row.type === 'session')?.session_id
      const transcripts = findTranscript(join(config, 'projects')).filter(path => path.endsWith(`/${sessionId}.jsonl`) || path.endsWith(`\\${sessionId}.jsonl`))
      if (transcripts.length !== 1) throw new Error(`expected one transcript, got ${transcripts.length}`)
      const plan = join(world, 'plan.json')
      const result = join(world, 'view.json')
      writeFileSync(plan, JSON.stringify({ transcript: transcripts[0] }))
      const run = spawnSync(process.execPath, ['run', driver, plan, result], { cwd: project, env, encoding: 'utf8', timeout: 60000 })
      if (run.status !== 0) throw new Error(`window exited ${run.status}: ${run.stderr}`)
      return JSON.parse(readFileSync(result, 'utf8'))
    }
    try {
      await host.initialize()
      await host.prompt('Read the three files.')
      await host.waitFor('read turn ended', row => row.type === 'outcome' && row.turn === 1)
      const loaded = view()
      check(`${kind}: the detail does not repeat the path that labels its row`, loaded.concise.includes('Cursor · loaded with src/**'))
      check(`${kind}: seven rows fit instead of stopping at five, and overflow uses the actual space`, loaded.layout.roomy?.visibleOptionCount === 7 && loaded.layout.crowded?.visibleOptionCount === 3)
      check(`${kind}: a long path wraps above its when-words at narrow widths`, loaded.layout.narrow?.layout === 'compact-vertical' && loaded.layout.narrow.visibleOptionCount === 8)
      check(`${kind}: all three attachment records reach the other process`, sources.every(file => loaded.messages.includes(join(project, file))))
      check(`${kind}: the scoped row says loaded without that process owning the runner cache`, loaded.rows.some(row => row.includes('.cursor/rules/x.mdc') && row.endsWith('loaded with src/**')))
      check(`${kind}: the other tool and native nested guides have loaded rows`, ['sub/GEMINI.md', 'own/MERCURY.md'].every(file => loaded.rows.some(row => row.includes(file) && row.endsWith('loaded with its folder'))))
      await host.prompt('/compact')
      await host.waitFor('fold turn ended', row => row.type === 'outcome' && row.turn === 2)
      const folded = view()
      check(`${kind}: the real fold drops every attachment from the visible segment`, loaded.boundaries === 0 && folded.boundaries > 0 && folded.visible.length === 0)
      check(`${kind}: after the fold the scoped row says loads and neither nested guide is listed`, folded.rows.some(row => row.includes('.cursor/rules/x.mdc') && row.endsWith('loads with src/**')) && ['sub/GEMINI.md', 'own/MERCURY.md'].every(file => !folded.rows.some(row => row.includes(file))))
    } finally {
      await host.stop()
      await api.close()
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`attached-files-cross-process: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
