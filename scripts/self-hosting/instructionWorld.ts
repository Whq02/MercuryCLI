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

export const contentsOf = (path: string, body: string): string => `Contents of ${path} (project instructions, checked into the codebase):\n\n${body}`

type GuideCase = {
  world: World
  check(label: string, ok: boolean, detail?: string): void
  section(title: string): void
  file: string
  convention: string
}

export function guideBattery({ world, check, section, file, convention }: GuideCase): void {
  const name = file.split('/').at(-1)!
  section(`${file}: alone in a project`)
  const alone = world.project({ [file]: 'guide-needle\n', 'src/a.ts': 'export const a = 1\n' })
  const guide = join(alone, file)
  const d1 = world.drive(alone, { classify: [guide] })
  check('the first request carries it in the form a shared guide has', d1.first === contentsOf(guide, 'guide-needle'), d1.first)
  const entry = d1.entries.find(e => e.path === guide)
  check('the entry is shared, from the project walk, and names its format', entry?.family === 'shared' && entry.origin === 'project-walk' && entry.convention === convention, JSON.stringify(entry))
  check('the folder counts as guided', JSON.stringify(d1.guides) === JSON.stringify([guide]), JSON.stringify(d1.guides))
  check('the file classifies as an instruction file', d1.classified[guide] === true)

  section(`${file}: MERCURY.md decides`)
  const decided = world.project({ 'MERCURY.md': 'native-needle\n', [file]: 'guide-needle\n' })
  const d2 = world.drive(decided, { classify: [join(decided, file)] })
  check('MERCURY.md composes and the other file does not', d2.first === contentsOf(join(decided, 'MERCURY.md'), 'native-needle'), d2.first)
  check('the other file is an ordinary file there', d2.classified[join(decided, file)] === false)
  const imported = world.project({ 'MERCURY.md': `@${file}\nnative-needle\n`, [file]: 'guide-needle\n' })
  const d3 = world.drive(imported)
  check('an explicit import in MERCURY.md brings it in, once', count(d3.first, 'guide-needle') === 1 && d3.first.includes('native-needle'), d3.first)
  check('the imported file rides the native chain', d3.entries.find(e => e.path === join(imported, file))?.parent === join(imported, 'MERCURY.md'), JSON.stringify(d3.entries))
  const above = world.project({ 'MERCURY.md': 'parent-native-needle\n', [`app/${file}`]: 'guide-needle\n', 'app/a.ts': '\n' })
  const d4 = world.drive(join(above, 'app'), { trust: above })
  check('a MERCURY.md above the working directory decides too', d4.first.includes('parent-native-needle') && !d4.first.includes('guide-needle'), d4.first)
  const personal = world.project({ 'MERCURY.local.md': 'local-needle\n', [file]: 'guide-needle\n' })
  const d5 = world.drive(personal)
  check('a MERCURY.local.md decides nothing: both compose, the personal layer last', d5.first.includes('guide-needle') && d5.paths.indexOf(join(personal, file)) >= 0 && d5.paths.indexOf(join(personal, file)) < d5.paths.indexOf(join(personal, 'MERCURY.local.md')), d5.paths.join(', '))

  section(`${file}: the native profile, the exclusion list, an untrusted folder`)
  check('the native profile composes nothing', world.drive(alone, { settings: { briefs: { profile: 'native' } } }).first === '')
  check('an excluded file composes nothing', world.drive(alone, { settings: { briefs: { exclude: [`**/${name}`] } } }).first === '')
  check('a folder never trusted composes nothing headless', world.drive(alone, { untrusted: true }).first === '')

  section(`${file}: the chain, a nested folder, the home folder`)
  const chain = world.project({ [file]: 'outer-needle\n', [`packages/app/${file}`]: 'inner-needle\n', 'packages/app/a.ts': '\n' })
  const d6 = world.drive(join(chain, 'packages/app'), { trust: chain })
  check('started below it, the outer file composes before the inner one', d6.paths.indexOf(join(chain, file)) >= 0 && d6.paths.indexOf(join(chain, file)) < d6.paths.indexOf(join(chain, 'packages/app', file)), d6.paths.join(', '))
  const nested = world.project({ 'README.md': 'x\n', [`sub/${file}`]: 'nested-needle\n', 'sub/file.ts': '\n', 'sub/other.ts': '\n', 'elsewhere/file.ts': '\n' })
  const d7 = world.drive(nested, { touch: [join(nested, 'elsewhere/file.ts'), join(nested, 'sub/file.ts'), join(nested, 'sub/other.ts')] })
  check('a nested file is not in the first request', d7.first === '', d7.first)
  check('a file elsewhere attaches nothing', d7.touched[0]!.attached.length === 0, JSON.stringify(d7.touched[0]))
  check('a file in its folder attaches it, as a folder guide', d7.touched[1]!.attached.length === 1 && d7.touched[1]!.attached[0]!.told.includes(`Instruction file ${join(nested, 'sub', file)} (it governs its folder):\n\nnested-needle`), JSON.stringify(d7.touched[1]))
  check('a second file there attaches nothing more', d7.touched[2]!.attached.length === 0, JSON.stringify(d7.touched[2]))
  const nestedDecided = world.project({ 'MERCURY.md': 'native-needle\n', [`sub/${file}`]: 'nested-needle\n', 'sub/file.ts': '\n' })
  check('under a MERCURY.md the nested file does not attach', world.drive(nestedDecided, { touch: [join(nestedDecided, 'sub/file.ts')] }).touched[0]!.attached.length === 0)
  const homed = world.project({ [file]: 'home-needle\n', [`work/${file}`]: 'workspace-needle\n', 'work/proj/a.ts': '\n' })
  const d8 = world.drive(join(homed, 'work/proj'), { home: homed, trust: homed })
  check("the home folder's own file does not compose and the workspace's above the project does", d8.first.includes('workspace-needle') && !d8.first.includes('home-needle'), d8.paths.join(', '))

  section(`${file}: beside AGENTS.md`)
  const beside = world.project({ 'AGENTS.md': 'agents-needle\n', [file]: 'guide-needle\n' })
  const d9 = world.drive(beside)
  check('both compose, AGENTS.md first', JSON.stringify(d9.paths) === JSON.stringify([join(beside, 'AGENTS.md'), join(beside, file)]), d9.paths.join(', '))
}
