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
  attached: Array<{ path: string; told: string; partial: boolean }>
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
  seeded: string[]
  rows: string[]
  listed: string[]
  listedBefore: string[]
  words: { footer: string; centre: string; health: string }
  orient: string
  attached: string[]
  attachedBefore: string[]
  dropped: { attached: string[]; listed: string[] }
  returned: { attached: string[]; listed: string[] }
}

type DriveOptions = {
  touch?: string[]
  settings?: object
  untrusted?: boolean
  trust?: string
  home?: string
  classify?: string[]
  screens?: boolean
  orient?: boolean
  personal?: string
  env?: Record<string, string>
  drop?: boolean
}

const DRIVER = `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
;(globalThis as any).MACRO = { VERSION: '1.0.0' }
const repo = ${JSON.stringify(repo)}
const { enableConfigs } = await import(join(repo, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { getEmptyToolPermissionContext } = await import(join(repo, 'src/Tool.ts'))
const { getInstructionFiles, getInstructionBundle, getInstructionCompositionState, isInstructionFilePath, seedFileKnowledgeFromInjectedInstructions } = await import(join(repo, 'src/services/instructions/engine.ts'))
const { getUserContext } = await import(join(repo, 'src/context.ts'))
const { getNestedMemoryAttachmentsForFile } = await import(join(repo, 'src/utils/attachments/nestedMemory.ts'))
const { normalizeAttachmentForAPI } = await import(join(repo, 'src/utils/messages/attachmentText.ts'))
const { createFileStateCacheWithSizeLimit } = await import(join(repo, 'src/utils/fileStateCache.ts'))
const { composedGuideFilesAt } = await import(join(repo, 'src/services/instructions/adapters/index.ts'))
const plan = JSON.parse(process.env.DRV_PLAN ?? '{}')
const cwd = process.cwd()
const files = await getInstructionFiles()
const state = { toolPermissionContext: getEmptyToolPermissionContext() }
const context = { readFileState: createFileStateCacheWithSizeLimit(100), loadedNestedMemoryPaths: new Set(), nestedMemoryAttachmentTriggers: new Set(), getAppState: () => state }
const held = (path: string): boolean => context.readFileState.has(path)
const screens = async (): Promise<{ rows: string[]; listed: string[]; attached: string[]; words: { footer: string; centre: string; health: string } }> => {
  let listing: any
  try {
    listing = await import(join(repo, 'src/services/instructions/listing.ts'))
  } catch {
    return { rows: [], listed: [], attached: [], words: { footer: '', centre: '', health: '' } }
  }
  const { getRelativeMemoryPath } = await import(join(repo, 'src/components/memory/MemoryUpdateNotification.tsx'))
  const { profileStatusLine } = await import(join(repo, 'src/commands/memory/memory.tsx'))
  const { filesRow } = await import(join(repo, 'src/components/memory/memoryCentreLayout.ts'))
  listing.getInstructionListing.cache.clear()
  const family = (entry: any): string => (entry.family === 'native' ? 'Mercury-native · ' : entry.family === 'shared' ? 'shared guide · ' : '')
  const listed = await listing.getInstructionListing()
  return {
    rows: files.filter((entry: any) => entry.parent === undefined).map((entry: any) => (listing.toolPrefixOf(entry) ?? family(entry)) + getRelativeMemoryPath(entry.path) + listing.loadedStateOf(entry)),
    listed: listed.map((row: any) => listing.listingRowWords(row, getRelativeMemoryPath(row.path), held)),
    attached: (listing.attachedRows?.(held, [...files.map((entry: any) => entry.path), ...listed.map((row: any) => row.path)]) ?? []).map((row: any) => listing.listingRowWords(row, getRelativeMemoryPath(row.path), held)),
    words: {
      footer: profileStatusLine(),
      centre: filesRow({ count: files.length, profile: getInstructionCompositionState().resolution.resolved }).detail,
      health: listing.sharedSourcesNote?.((await getInstructionBundle()).entries) ?? '',
    },
  }
}
const before = plan.screens ? await screens() : null
const bundle = await getInstructionBundle()
const told = (attachment: unknown): string =>
  normalizeAttachmentForAPI(attachment as never)
    .map((message: any) => (typeof message.message.content === 'string' ? message.message.content : message.message.content.map((block: any) => block.text ?? '').join('')))
    .join('\\n')
const touched = []
for (const file of plan.touch ?? []) {
  const got = await getNestedMemoryAttachmentsForFile(file, context as never, state)
  touched.push({ file, attached: got.map((a: any) => ({ path: a.path, told: told(a), partial: context.readFileState.get(a.path)?.isPartialView === true })) })
}
const seedCache = createFileStateCacheWithSizeLimit(100)
await seedFileKnowledgeFromInjectedInstructions(seedCache)
const after = plan.screens ? await screens() : { rows: [], listed: [], attached: [], words: { footer: '', centre: '', health: '' } }
const none = { attached: [], listed: [] }
let dropped = none
let returned = none
if (plan.drop) {
  context.readFileState.clear()
  context.loadedNestedMemoryPaths.clear()
  const then = await screens()
  dropped = { attached: then.attached, listed: then.listed }
  for (const file of plan.touch ?? []) for (const a of await getNestedMemoryAttachmentsForFile(file, context as never, state)) told(a)
  const again = await screens()
  returned = { attached: again.attached, listed: again.listed }
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
  seeded: files.map((f: any) => f.path).filter((path: string) => seedCache.has(path)),
  listedBefore: before?.listed ?? [],
  attachedBefore: before?.attached ?? [],
  orient: plan.orient ? (await (await import(join(repo, 'src/commands/orient/orient.ts'))).default.getPromptForCommand())[0].text : '',
  ...after,
  dropped,
  returned,
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
      if (options.personal !== undefined) writeFileSync(join(configHome, 'MERCURY.md'), options.personal)
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
          DRV_PLAN: JSON.stringify({ touch: options.touch ?? [], classify: options.classify ?? [], screens: options.screens === true, orient: options.orient === true, drop: options.drop === true }),
          ...options.env,
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

export const governs = (path: string, patterns: string, body: string): string => `Instruction file ${path} (it governs files matching ${patterns}):\n\n${body}`

type RulesCase = {
  world: World
  check(label: string, ok: boolean, detail?: string): void
  section(title: string): void
  convention: string
  folder: string
  ext: string
  always(body: string): string
  scoped(patterns: string[], body: string): string
  nearestOnly?: boolean
}

export function rulesBattery({ world, check, section, convention, folder, ext, always, scoped, nearestOnly = false }: RulesCase): void {
  const rule = (name: string): string => `${folder}/${name}${ext}`
  const attachedPaths = (touch: WorldTouch): string[] => touch.attached.map(a => a.path)

  section(`${folder}: a rule that always applies reaches the first request, a scoped one does not`)
  const p1 = world.project({
    [rule('10-general')]: always('always-needle\n'),
    [rule('20-typescript')]: scoped(['src/**/*.ts'], 'typescript-needle\n'),
    [rule('30-docs')]: scoped(['docs/**'], 'docs-needle\n'),
    'src/app/main.ts': '\n',
    'src/app/other.ts': '\n',
    'docs/guide.md': '\n',
    'README.md': 'x\n',
  })
  const general = join(p1, rule('10-general'))
  const typescript = join(p1, rule('20-typescript'))
  const d1 = world.drive(p1, {
    classify: [general, typescript],
    touch: [join(p1, 'README.md'), join(p1, 'src/app/main.ts'), join(p1, 'src/app/other.ts'), join(p1, 'docs/guide.md')],
  })
  check('the first request carries the always rule alone, its header stripped, in the form a shared guide has', d1.first === contentsOf(general, 'always-needle'), d1.first)
  const entry = d1.entries.find(e => e.path === general)
  check('the entry is shared, from the project walk, and names its format', entry?.family === 'shared' && entry.origin === 'project-walk' && entry.convention === convention, JSON.stringify(entry))
  check('both rule files classify as instruction files', d1.classified[general] === true && d1.classified[typescript] === true, JSON.stringify(d1.classified))
  check('a file no pattern names attaches nothing', d1.touched[0]!.attached.length === 0, JSON.stringify(d1.touched[0]))
  check('a matching file attaches its rule, saying what it governs', d1.touched[1]!.attached.length === 1 && d1.touched[1]!.attached[0]!.told.includes(governs(typescript, 'src/**/*.ts', 'typescript-needle')), JSON.stringify(d1.touched[1]))
  check('the attached rule is held as a partial view: its header was not shown', d1.touched[1]!.attached[0]?.partial === true)
  check('a second matching file attaches nothing more', d1.touched[2]!.attached.length === 0, JSON.stringify(d1.touched[2]))
  check('a file of the other scope attaches the other rule', JSON.stringify(attachedPaths(d1.touched[3]!)) === JSON.stringify([join(p1, rule('30-docs'))]), JSON.stringify(d1.touched[3]))
  if (always('x') === 'x') check('a plain rule shown whole counts as read in full', d1.seeded.includes(general), d1.seeded.join(', '))
  else check('a rule whose header was stripped is not counted as read in full', !d1.seeded.includes(general), d1.seeded.join(', '))

  section(`${folder}: the vendor's patterns: no slash means the root's files, braces and lists hold`)
  const p2 = world.project({
    [rule('root-only')]: scoped(['*.ts'], 'root-only-needle\n'),
    [rule('anywhere')]: scoped(['**/*.py'], 'anywhere-needle\n'),
    [rule('braces')]: scoped(['web/**/*.{tsx,css}'], 'braces-needle\n'),
    [rule('listed')]: scoped(['api/**', 'schema/*.sql'], 'listed-needle\n'),
    [rule('folder')]: scoped(['tools/'], 'folder-needle\n'),
    'top.ts': '\n', 'src/deep.ts': '\n', 'run.py': '\n', 'pkg/deep/run.py': '\n',
    'web/ui/a.tsx': '\n', 'web/ui/a.css': '\n', 'web/ui/a.ts': '\n',
    'api/v1/h.go': '\n', 'schema/a.sql': '\n', 'schema/old/a.sql': '\n', 'tools/x/y.sh': '\n',
  })
  const touchOne = (file: string): string[] => attachedPaths(world.drive(p2, { touch: [join(p2, file)] }).touched[0]!)
  const names = (paths: string[]): string => paths.map(path => path.split('/').at(-1)!.replace(ext, '')).join(',')
  check('*.ts governs a file in the root', names(touchOne('top.ts')) === 'root-only', names(touchOne('top.ts')))
  check('*.ts does not govern a file in a folder below', names(touchOne('src/deep.ts')) === '', names(touchOne('src/deep.ts')))
  check('**/*.py governs the root and any depth', names(touchOne('run.py')) === 'anywhere' && names(touchOne('pkg/deep/run.py')) === 'anywhere')
  check('a brace group governs each alternative and nothing else', names(touchOne('web/ui/a.tsx')) === 'braces' && names(touchOne('web/ui/a.css')) === 'braces' && names(touchOne('web/ui/a.ts')) === '')
  check('each pattern of a list governs its own files and no deeper than it says', names(touchOne('api/v1/h.go')) === 'listed' && names(touchOne('schema/a.sql')) === 'listed' && names(touchOne('schema/old/a.sql')) === '')
  check('a pattern ending in a slash governs the folder', names(touchOne('tools/x/y.sh')) === 'folder', names(touchOne('tools/x/y.sh')))

  section(`${folder}: found from any folder of the repository, matched from the folder that owns it`)
  const p3 = world.project({
    [rule('general')]: always('outer-always-needle\n'),
    [rule('packages')]: scoped(['packages/app/**/*.ts'], 'outer-scoped-needle\n'),
    [`packages/app/${rule('local')}`]: scoped(['lib/**'], 'inner-scoped-needle\n'),
    'packages/app/lib/a.ts': '\n',
    'packages/app/main.go': '\n',
  })
  const d3 = world.drive(join(p3, 'packages/app'), { trust: p3, touch: [join(p3, 'packages/app/main.go'), join(p3, 'packages/app/lib/a.ts')] })
  if (nearestOnly) {
    check('started in a folder that holds its own, the folder above is not read: the nearest one alone', d3.first === '', d3.first)
    check('a file neither scope names attaches nothing', d3.touched[0]!.attached.length === 0, JSON.stringify(d3.touched[0]))
    check('only the rule of the nearest folder is matched', JSON.stringify(attachedPaths(d3.touched[1]!)) === JSON.stringify([join(p3, 'packages/app', rule('local'))]), JSON.stringify(d3.touched[1]))
    const p3b = world.project({
      [rule('general')]: always('outer-always-needle\n'),
      [rule('packages')]: scoped(['packages/app/**/*.ts'], 'outer-scoped-needle\n'),
      'packages/app/lib/a.ts': '\n',
    })
    const d3b = world.drive(join(p3b, 'packages/app'), { trust: p3b, touch: [join(p3b, 'packages/app/lib/a.ts')] })
    check('started below the only one, it is found by walking up', d3b.first === contentsOf(join(p3b, rule('general')), 'outer-always-needle'), d3b.first)
    check('and its scoped rule is matched from its own owning folder', JSON.stringify(attachedPaths(d3b.touched[0]!)) === JSON.stringify([join(p3b, rule('packages'))]), JSON.stringify(d3b.touched[0]))
  } else {
    check('started below it, the always rule of the folder above composes', d3.first === contentsOf(join(p3, rule('general')), 'outer-always-needle'), d3.first)
    check('a file neither scope names attaches nothing', d3.touched[0]!.attached.length === 0, JSON.stringify(d3.touched[0]))
    check('each rule is matched from its own owning folder', JSON.stringify(attachedPaths(d3.touched[1]!).sort()) === JSON.stringify([join(p3, rule('packages')), join(p3, 'packages/app', rule('local'))].sort()), JSON.stringify(d3.touched[1]))
  }

  section(`${folder}: a rules folder in a nested folder loads with its folder`)
  const p4 = world.project({
    'README.md': 'x\n',
    [`sub/${rule('general')}`]: always('nested-always-needle\n'),
    [`sub/${rule('scoped')}`]: scoped(['lib/**'], 'nested-scoped-needle\n'),
    'sub/main.go': '\n',
    'sub/lib/a.go': '\n',
    'elsewhere/lib/a.go': '\n',
  })
  const d4 = world.drive(p4, { touch: [join(p4, 'elsewhere/lib/a.go'), join(p4, 'sub/main.go'), join(p4, 'sub/lib/a.go')] })
  check('the first request carries neither', d4.first === '', d4.first)
  check('a file elsewhere attaches nothing', d4.touched[0]!.attached.length === 0, JSON.stringify(d4.touched[0]))
  check('a file in the nested folder attaches its always rule alone', JSON.stringify(attachedPaths(d4.touched[1]!)) === JSON.stringify([join(p4, 'sub', rule('general'))]), JSON.stringify(d4.touched[1]))
  check('a file its scoped rule names, read from the nested folder, attaches that rule', JSON.stringify(attachedPaths(d4.touched[2]!)) === JSON.stringify([join(p4, 'sub', rule('scoped'))]), JSON.stringify(d4.touched[2]))

  section(`${folder}: MERCURY.md decides, on every road`)
  const p5 = world.project({
    'MERCURY.md': 'native-needle\n',
    [rule('general')]: always('always-needle\n'),
    [rule('typescript')]: scoped(['src/**/*.ts'], 'typescript-needle\n'),
    [`sub/${rule('general')}`]: always('nested-always-needle\n'),
    'src/a.ts': '\n',
    'sub/a.ts': '\n',
  })
  const d5 = world.drive(p5, { classify: [join(p5, rule('general'))], touch: [join(p5, 'src/a.ts'), join(p5, 'sub/a.ts')] })
  check('the first request carries MERCURY.md alone', d5.first === contentsOf(join(p5, 'MERCURY.md'), 'native-needle'), d5.first)
  check('a matching file attaches nothing', d5.touched[0]!.attached.length === 0, JSON.stringify(d5.touched[0]))
  check('a nested rules folder attaches nothing', d5.touched[1]!.attached.length === 0, JSON.stringify(d5.touched[1]))
  check('the rule file is an ordinary file there', d5.classified[join(p5, rule('general'))] === false)
  const p5b = world.project({
    [rule('typescript')]: scoped(['**/*.ts'], 'typescript-needle\n'),
    'mixed/MERCURY.md': 'nested-native-needle\n',
    [`mixed/${rule('general')}`]: always('nested-always-needle\n'),
    'mixed/a.ts': '\n',
  })
  const d5b = world.drive(p5b, { touch: [join(p5b, 'mixed/a.ts')] })
  check('a nested folder with its own MERCURY.md attaches that and not its rules folder', attachedPaths(d5b.touched[0]!).includes(join(p5b, 'mixed/MERCURY.md')) && !attachedPaths(d5b.touched[0]!).includes(join(p5b, 'mixed', rule('general'))), JSON.stringify(d5b.touched[0]))

  section(`${folder}: the native profile, the exclusion list, an untrusted folder, the home folder`)
  const d6 = world.drive(p1, { settings: { briefs: { profile: 'native' } }, touch: [join(p1, 'src/app/main.ts')] })
  check('the native profile composes nothing and attaches nothing', d6.first === '' && d6.touched[0]!.attached.length === 0, JSON.stringify(d6.touched[0]))
  const d6b = world.drive(p1, { settings: { briefs: { exclude: [`**/${folder}/**`] } }, touch: [join(p1, 'src/app/main.ts')] })
  check('an excluded rules folder composes nothing and attaches nothing', d6b.first === '' && d6b.touched[0]!.attached.length === 0, JSON.stringify(d6b.touched[0]))
  const d6c = world.drive(p1, { untrusted: true, touch: [join(p1, 'src/app/main.ts')] })
  check('a folder never trusted composes nothing and attaches nothing headless', d6c.first === '' && d6c.touched[0]!.attached.length === 0, JSON.stringify(d6c.touched[0]))
  const p6 = world.project({
    [rule('personal')]: always('home-always-needle\n'),
    [rule('personal-scoped')]: scoped(['**/*.ts'], 'home-scoped-needle\n'),
    'work/proj/a.ts': '\n',
  })
  const d6d = world.drive(join(p6, 'work/proj'), { home: p6, trust: p6, touch: [join(p6, 'work/proj/a.ts')] })
  check("the home folder's own rules folder neither composes nor attaches", d6d.first === '' && d6d.touched[0]!.attached.length === 0, `${d6d.first} ${JSON.stringify(d6d.touched[0])}`)
  const p6b = world.project({
    [rule('personal')]: always('home-always-needle\n'),
    [rule('personal-scoped')]: scoped(['*.ts'], 'home-scoped-needle\n'),
    'a.ts': '\n',
  })
  const d6e = world.drive(p6b, { home: p6b, touch: [join(p6b, 'a.ts')] })
  if (folder.includes('/')) {
    check('started in the home folder itself, the tool folder there stays personal: nothing composes, nothing attaches', d6e.first === '' && d6e.touched[0]!.attached.length === 0, `${d6e.first} ${JSON.stringify(d6e.touched[0])}`)
  } else {
    check('started in the home folder itself, a rules folder that is an entry of that folder is read', d6e.first === contentsOf(join(p6b, rule('personal')), 'home-always-needle') && JSON.stringify(attachedPaths(d6e.touched[0]!)) === JSON.stringify([join(p6b, rule('personal-scoped'))]), `${d6e.first} ${JSON.stringify(d6e.touched[0])}`)
  }

  section(`${folder}: which files are rules, and in what order`)
  const p7 = world.project({
    [rule('b-second')]: always('second-needle\n'),
    [rule('a-first')]: always('first-needle\n'),
    [`${folder}/web/${`c-third${ext}`}`]: always('third-needle\n'),
    [`${folder}/notes.txt`]: 'stray-needle\n',
  })
  const d7 = world.drive(p7)
  check('rules compose in name order, a subfolder among them', JSON.stringify(d7.paths) === JSON.stringify([join(p7, rule('a-first')), join(p7, rule('b-second')), join(p7, folder, 'web', `c-third${ext}`)]), d7.paths.join(', '))
  check('a file the format does not name is not a rule', !d7.first.includes('stray-needle'), d7.first)
}
