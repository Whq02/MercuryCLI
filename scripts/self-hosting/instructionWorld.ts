import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const repo = join(import.meta.dir, '../..')

type WorldEntry = {
  path: string
  type: string
  family: string
  origin: string
  convention?: string
  parent?: string
  globs?: string[]
}

type WorldTouch = {
  file: string
  attached: Array<{ path: string; told: string }>
}

type WorldDrive = {
  paths: string[]
  first: string
  entries: WorldEntry[]
  fallbackComposed: boolean
  diagnostics: Array<{ kind: string; path: string; detail?: string }>
  touched: WorldTouch[]
  guides: string[]
  classified: Record<string, boolean>
}

type DriveOptions = {
  touch?: string[]
  settings?: object
  untrusted?: boolean
  trust?: string
  home?: string
  classify?: string[]
}

const DRIVER = `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const repo = ${JSON.stringify(repo)}
const { enableConfigs } = await import(join(repo, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { getEmptyToolPermissionContext } = await import(join(repo, 'src/Tool.ts'))
const { getInstructionFiles, getInstructionBundle, getInstructionCompositionState, isInstructionFilePath } = await import(join(repo, 'src/services/instructions/engine.ts'))
const { getUserContext } = await import(join(repo, 'src/context.ts'))
const { getNestedMemoryAttachmentsForFile } = await import(join(repo, 'src/utils/attachments/nestedMemory.ts'))
const { normalizeAttachmentForAPI } = await import(join(repo, 'src/utils/messages/attachmentText.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(repo, 'src/utils/fileStateCache.ts'))
const { composedGuideFilesAt } = await import(join(repo, 'src/services/instructions/adapters/index.ts'))
const plan = JSON.parse(process.env.DRV_PLAN ?? '{}')
const cwd = process.cwd()
const files = await getInstructionFiles()
const bundle = await getInstructionBundle()
const state = { toolPermissionContext: getEmptyToolPermissionContext() }
const context = { readFileState: createFileStateCacheWithSizeLimit(100), loadedNestedMemoryPaths: new Set(), nestedMemoryAttachmentTriggers: new Set(), getAppState: () => state }
const told = (attachment: unknown): string =>
  normalizeAttachmentForAPI(attachment as never)
    .map((message: any) => (typeof message.message.content === 'string' ? message.message.content : message.message.content.map((block: any) => block.text ?? '').join('')))
    .join('\\n')
const touched = []
for (const file of plan.touch ?? []) {
  const got = await getNestedMemoryAttachmentsForFile(file, context as never, state)
  touched.push({ file, attached: got.map((a: any) => ({ path: a.path, told: told(a) })) })
}
writeFileSync(process.argv[2]!, JSON.stringify({
  paths: files.map((f: any) => f.path),
  first: (await getUserContext()).instructions ?? '',
  entries: bundle.entries.map((e: any) => ({ path: e.path, type: e.type, family: e.family, origin: e.origin, convention: e.convention, parent: e.parent, globs: e.globs })),
  fallbackComposed: getInstructionCompositionState().fallbackComposed,
  diagnostics: getInstructionCompositionState().diagnostics.map((d: any) => ({ kind: d.kind, path: d.path, detail: d.detail })),
  touched,
  guides: composedGuideFilesAt(cwd),
  classified: Object.fromEntries((plan.classify ?? []).map((path: string) => [path, isInstructionFilePath(path)])),
}))
`

type World = {
  scratch: string
  project(layout: Record<string, string>): string
  drive(cwd: string, options?: DriveOptions): WorldDrive
  close(): void
}

export function openWorld(name: string): World {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)))
  const driver = join(scratch, 'driver.ts')
  writeFileSync(driver, DRIVER)
  let projects = 0
  let homes = 0
  return {
    scratch,
    project(layout) {
      const root = join(scratch, `project-${++projects}`)
      mkdirSync(root, { recursive: true })
      for (const [rel, content] of Object.entries(layout)) {
        const path = join(root, rel)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
      }
      return root
    },
    drive(cwd, options = {}) {
      const configHome = join(scratch, `config-${++homes}`)
      seedFirstRun(configHome, options.untrusted ? [] : [options.trust ?? cwd])
      if (options.settings) writeFileSync(join(configHome, 'settings.json'), JSON.stringify(options.settings))
      const home = options.home ?? join(scratch, `home-${homes}`)
      mkdirSync(home, { recursive: true })
      const result = join(configHome, 'result.json')
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MERCURY_|CLAUDE_|ANTHROPIC_)/.test(key)))
      const run = spawnSync(process.execPath, ['run', driver, result], {
        cwd,
        env: {
          ...env,
          HOME: home,
          USERPROFILE: home,
          MERCURY_CONFIG_DIR: configHome,
          MERCURY_CREDENTIAL_STORE: 'file',
          MERCURY_LOCAL_PROBE_TARGETS: 'none',
          ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
          DRV_PLAN: JSON.stringify({ touch: options.touch ?? [], classify: options.classify ?? [] }),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
        timeout: 120_000,
      })
      if (run.error) throw run.error
      if (run.status !== 0) throw new Error(`driver exited ${run.status}: ${run.stderr}`)
      return JSON.parse(readFileSync(result, 'utf8')) as WorldDrive
    },
    close() {
      rmSync(scratch, { recursive: true, force: true })
    },
  }
}

export function checker(): { check(label: string, ok: boolean, detail?: string): void; section(title: string): void; close(name: string): never } {
  let passed = 0
  let failed = 0
  return {
    check(label, ok, detail = '') {
      ok ? passed++ : failed++
      console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
    },
    section(title) {
      console.log(title)
    },
    close(name) {
      console.log(`${name}: ${passed} passed, ${failed} failed`)
      process.exit(failed ? 1 : 0)
    },
  }
}

export const count = (text: string, needle: string): number => text.split(needle).length - 1
