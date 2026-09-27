#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, relative } from 'node:path'
import { registerGeneratedAsset, registerOnlyRequested } from '../lib/generated-assets-map.mjs'

const ROOT = join(import.meta.dir, '..', '..')
const ROW = {
  assets: 'src/skills/bundled/**',
  generator: 'bun scripts/skills/gen-bundled.ts',
  check: null,
  sources: 'mercury-skills/**',
}

export type Layout = { sourceRoot: string; dest: string }
export const DEFAULT_LAYOUT: Layout = {
  sourceRoot: join(ROOT, 'mercury-skills'),
  dest: join(ROOT, 'src', 'skills', 'bundled'),
}

export const GENERATED_MARKER = "export const GENERATED_BY = 'scripts/skills/gen-bundled.ts'"

export type DirEntry = { name: string; isDirectory(): boolean; isFile(): boolean }
export type ListDir = (dir: string) => DirEntry[]
export const listDir: ListDir = dir => readdirSync(dir, { withFileTypes: true })
const byName = (a: DirEntry, b: DirEntry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

const SKIP_EXT = new Set(['.ttf', '.otf', '.woff', '.woff2', '.pyc', '.pdf', '.gz', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.ico', '.webp'])
const LOADER_TEXT_EXT = new Set(['.md', '.txt', '.sh', '.py', '.html', '.xml', '.dot'])
export const TEXT_LOADERS: Readonly<Record<string, 'text'>> = Object.fromEntries([...LOADER_TEXT_EXT].map(ext => [ext, 'text' as const]))

export function isSkillName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/.test(name)
}

function hasSource(name: string, layout: Layout): boolean {
  return existsSync(join(layout.sourceRoot, name, 'SKILL.md'))
}

function walk(dir: string, list: ListDir = listDir): string[] {
  const out: string[] = []
  for (const e of [...list(dir)].sort(byName)) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__pycache__' || e.name === 'node_modules' || e.name === '.git') continue
      out.push(...walk(p, list))
    } else if (e.isFile()) {
      out.push(p)
    }
  }
  return out
}

function posix(rel: string): string {
  return rel.split(/[\\/]/).join('/')
}

function camel(name: string): string {
  return name
    .split(/[-_]/)
    .map(s => (s ? s[0]!.toUpperCase() + s.slice(1) : ''))
    .join('')
}

function ident(relPath: string, seen: Set<string>): string {
  let base = 'ref_' + relPath.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (base.length > 60) base = base.slice(0, 60)
  let id = base
  let n = 1
  while (seen.has(id)) id = `${base}_${n++}`
  seen.add(id)
  return id
}

export function isGeneratedModule(path: string): boolean {
  if (!existsSync(path)) return false
  return (readFileSync(path, 'utf8').split('\n', 1)[0] ?? '') === GENERATED_MARKER
}

export function discoverSkills(layout: Layout = DEFAULT_LAYOUT): { names: string[]; invalid: string[] } {
  const names: string[] = []
  const invalid: string[] = []
  if (!existsSync(layout.sourceRoot)) return { names, invalid }
  for (const e of readdirSync(layout.sourceRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || !hasSource(e.name, layout)) continue
    ;(isSkillName(e.name) ? names : invalid).push(e.name)
  }
  return { names: names.sort(), invalid: invalid.sort() }
}

export function retiredSkills(layout: Layout = DEFAULT_LAYOUT): string[] {
  const out = new Set<string>()
  if (!existsSync(layout.dest)) return []
  for (const file of readdirSync(layout.dest)) {
    const name = /^(.+?)(?:Content)?\.ts$/.exec(file)?.[1]
    if (name === undefined || !isSkillName(name) || hasSource(name, layout)) continue
    if (isGeneratedModule(join(layout.dest, file))) out.add(name)
  }
  return [...out].sort()
}

export type Rendered = {
  name: string
  mirror: Array<{ rel: string; bytes: Buffer }>
  contentTs: string
  registerTs: string
  refs: string[]
  wiring: { importLine: string; callLine: string }
}

export function renderSkill(name: string, layout: Layout = DEFAULT_LAYOUT, list: ListDir = listDir): Rendered {
  if (!isSkillName(name)) throw new Error(`invalid skill name ${JSON.stringify(name)} (lowercase letters, digits, - and _ only)`)
  const srcDir = join(layout.sourceRoot, name)
  if (!hasSource(name, layout)) throw new Error(`${name}: no SKILL.md under ${layout.sourceRoot}`)

  const mirror: Rendered['mirror'] = []
  const refImports: string[] = []
  const refEntries: string[] = []
  const refs: string[] = []
  const seen = new Set<string>()

  for (const abs of walk(srcDir, list)) {
    const rel = posix(relative(srcDir, abs))
    const ext = extname(abs).toLowerCase()
    if (SKIP_EXT.has(ext)) continue
    const content = readFileSync(abs)
    const isSkillMd = rel === 'SKILL.md'
    const loaderSafe = LOADER_TEXT_EXT.has(ext)

    if (isSkillMd || loaderSafe) mirror.push({ rel, bytes: content })
    if (isSkillMd) continue

    refs.push(rel)
    if (loaderSafe) {
      const id = ident(rel, seen)
      refImports.push(`import ${id} from './${name}/${rel}'`)
      refEntries.push(`  ${JSON.stringify(rel)}: ${id},`)
    } else {
      refEntries.push(`  ${JSON.stringify(rel)}: ${JSON.stringify(content.toString('utf8'))},`)
    }
  }

  const contentTs =
    `${GENERATED_MARKER}\n` +
    `import skillMd from './${name}/SKILL.md'\n` +
    (refImports.length ? refImports.join('\n') + '\n' : '') +
    `\nexport const SKILL_MD: string = skillMd\n\n` +
    `export const SKILL_FILES: Record<string, string> = {\n` +
    refEntries.join('\n') +
    (refEntries.length ? '\n' : '') +
    `}\n`

  const Camel = camel(name)
  const registerTs =
    `${GENERATED_MARKER}\n` +
    `import { parseFrontmatter } from '../../utils/frontmatterParser.js'\n` +
    `import { registerBundledSkill } from '../bundledSkills.js'\n` +
    `import { SKILL_FILES, SKILL_MD } from './${name}Content.js'\n\n` +
    `const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)\n` +
    `const DESCRIPTION =\n` +
    `  typeof frontmatter.description === 'string' && frontmatter.description.trim()\n` +
    `    ? frontmatter.description\n` +
    `    : ${JSON.stringify(`${name} — bundled skill`)}\n\n` +
    `export function register${Camel}Skill(): void {\n` +
    `  registerBundledSkill({\n` +
    `    name: ${JSON.stringify(name)},\n` +
    `    description: DESCRIPTION,\n` +
    `    ...(typeof frontmatter['when-to-use'] === 'string' && frontmatter['when-to-use'].trim()\n` +
    `      ? { whenToUse: frontmatter['when-to-use'] }\n` +
    `      : {}),\n` +
    `    ...(typeof frontmatter['argument-hint'] === 'string' && frontmatter['argument-hint'].trim()\n` +
    `      ? { argumentHint: frontmatter['argument-hint'] }\n` +
    `      : {}),\n` +
    `    ...(String(frontmatter['disable-model-invocation'] ?? '').toLowerCase() === 'true'\n` +
    `      ? { disableModelInvocation: true }\n` +
    `      : {}),\n` +
    `    userInvocable: String(frontmatter['user-invocable'] ?? '').toLowerCase() !== 'false',\n` +
    `    ...(Object.keys(SKILL_FILES).length > 0 ? { files: SKILL_FILES } : {}),\n` +
    `    async getPromptForCommand(args) {\n` +
    `      const parts: string[] = [SKILL_BODY.trimStart()]\n` +
    `      if (args) parts.push(args)\n` +
    `      return [{ type: 'text', text: parts.join('\\n\\n') }]\n` +
    `    },\n` +
    `  })\n` +
    `}\n`

  return {
    name,
    mirror,
    contentTs,
    registerTs,
    refs,
    wiring: {
      importLine: `import { register${Camel}Skill } from './${name}.js'`,
      callLine: `  register${Camel}Skill()`,
    },
  }
}

export function writeSkill(rendered: Rendered, layout: Layout = DEFAULT_LAYOUT): void {
  for (const file of [`${rendered.name}Content.ts`, `${rendered.name}.ts`]) {
    const p = join(layout.dest, file)
    if (existsSync(p) && !isGeneratedModule(p)) {
      throw new Error(`${rendered.name}: src/skills/bundled/${file} exists without the generated marker — a hand-written module; rename the skill`)
    }
  }
  const destDir = join(layout.dest, rendered.name)
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  for (const { rel, bytes } of rendered.mirror) {
    const file = join(destDir, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes)
  }
  writeFileSync(join(layout.dest, `${rendered.name}Content.ts`), rendered.contentTs)
  writeFileSync(join(layout.dest, `${rendered.name}.ts`), rendered.registerTs)
}

export function pruneSkill(name: string, layout: Layout = DEFAULT_LAYOUT): { removed: string[]; kept: string[] } {
  if (!isSkillName(name)) throw new Error(`invalid skill name ${JSON.stringify(name)}`)
  const removed: string[] = []
  const kept: string[] = []
  for (const file of [`${name}Content.ts`, `${name}.ts`]) {
    const p = join(layout.dest, file)
    if (!existsSync(p)) continue
    if (isGeneratedModule(p)) {
      rmSync(p)
      removed.push(file)
    } else {
      kept.push(file)
    }
  }
  const dir = join(layout.dest, name)
  if (existsSync(dir)) {
    if (removed.length > 0) {
      rmSync(dir, { recursive: true, force: true })
      removed.push(`${name}/`)
    } else {
      kept.push(`${name}/`)
    }
  }
  return { removed, kept }
}

export function checkSkill(name: string, layout: Layout = DEFAULT_LAYOUT): string[] {
  const r = renderSkill(name, layout)
  const drift: string[] = []
  for (const [file, expected] of [[`${name}Content.ts`, r.contentTs], [`${name}.ts`, r.registerTs]] as const) {
    const p = join(layout.dest, file)
    if (!existsSync(p)) drift.push(`${file}: missing`)
    else if (readFileSync(p, 'utf8') !== expected) drift.push(`${file}: stale`)
  }
  const destDir = join(layout.dest, name)
  const expected = new Map(r.mirror.map(m => [m.rel, m.bytes]))
  for (const [rel, bytes] of expected) {
    const p = join(destDir, rel)
    if (!existsSync(p)) drift.push(`${name}/${rel}: missing`)
    else if (!readFileSync(p).equals(bytes)) drift.push(`${name}/${rel}: stale`)
  }
  if (existsSync(destDir)) {
    for (const abs of walk(destDir)) {
      const rel = posix(relative(destDir, abs))
      if (!expected.has(rel)) drift.push(`${name}/${rel}: stray (not in the source, or not a mirrored kind)`)
    }
  }
  return drift
}

export function checkBundled(layout: Layout = DEFAULT_LAYOUT): { drift: string[]; retired: string[]; invalid: string[] } {
  const { names, invalid } = discoverSkills(layout)
  return { drift: names.flatMap(name => checkSkill(name, layout)), retired: retiredSkills(layout), invalid }
}

export type RunOptions = {
  layout?: Layout
  register?: boolean
  log?: (line: string) => void
}

export function runCli(argv: string[], options: RunOptions = {}): number {
  const layout = options.layout ?? DEFAULT_LAYOUT
  const log = options.log ?? ((line: string) => console.log(line))
  const unknownOptions = argv.filter(a => a.startsWith('--') && a !== '--check')
  for (const option of unknownOptions) log(`  ! unknown option ${option} — the options are --check (and --register from the command line)`)
  if (unknownOptions.length) return 1
  const requested = argv.filter(a => !a.startsWith('--'))
  const bad = requested.filter(n => !isSkillName(n))
  for (const n of bad) log(`  ! invalid skill name ${JSON.stringify(n)} — lowercase letters, digits, - and _ only`)
  if (bad.length) return 1
  const discovered = discoverSkills(layout)
  if (!requested.length && discovered.names.length === 0) {
    log(`  ! no skill under ${layout.sourceRoot} — refusing a full run (it would prune every generated skill)`)
    return 1
  }
  for (const name of discovered.invalid) log(`  ✗ ${JSON.stringify(name)}: source dir name is not a valid skill name — not generated`)
  let failed = discovered.invalid.length

  if (argv.includes('--check')) {
    const names = requested.length ? requested : discovered.names
    for (const name of names) {
      const drift = hasSource(name, layout) ? checkSkill(name, layout) : [`${name}: no SKILL.md in the source root`]
      if (drift.length === 0) log(`  ✓ ${name} in sync`)
      for (const d of drift) log(`  ✗ ${d}`)
      failed += drift.length
    }
    for (const name of retiredSkills(layout).filter(n => !requested.length || requested.includes(n))) {
      log(`  ✗ ${name}: retired output still present (a full run prunes it)`)
      failed++
    }
    log(failed === 0 ? '✅ bundled skills in sync with mercury-skills/' : `❌ ${failed} drift line(s) — run bun scripts/skills/gen-bundled.ts`)
    return failed === 0 ? 0 : 1
  }

  const names = requested.length ? requested : discovered.names
  const toPrune = requested.length ? requested.filter(n => !hasSource(n, layout)) : retiredSkills(layout)
  log(`Generating ${names.filter(n => hasSource(n, layout)).length} bundled skill(s)…`)
  const wiring: Rendered['wiring'][] = []
  for (const name of names) {
    if (!hasSource(name, layout)) continue
    try {
      const r = renderSkill(name, layout)
      writeSkill(r, layout)
      wiring.push(r.wiring)
      log(`  ✓ ${name}  (${r.refs.length} ref file(s))`)
    } catch (error) {
      failed++
      log(`  ✗ ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  let pruned = 0
  for (const name of toPrune) {
    const { removed, kept } = pruneSkill(name, layout)
    if (removed.length) {
      pruned++
      log(`  - ${name}: retired — removed ${removed.join(', ')}`)
    }
    for (const k of kept) log(`  ! ${name}: ${k} carries no generated marker — not generator output, left in place`)
    if (removed.length === 0 && kept.length === 0) {
      log(`  ! ${name}: no SKILL.md in the source root and no generated output — skipped`)
      failed++
    }
  }

  log('\n── index.ts wiring (add these) ──')
  log('// imports:')
  log(wiring.map(w => w.importLine).join('\n'))
  log('// calls (inside initBundledSkills):')
  log(wiring.map(w => w.callLine).join('\n'))
  if (options.register === true && failed === 0) registerGeneratedAsset(ROW)
  log(`\n${failed === 0 ? '✅' : '❌'} generated ${wiring.length} skill(s)${pruned ? `, pruned ${pruned} retired` : ''}${failed ? `, ${failed} failure(s)` : ''}`)
  return failed === 0 ? 0 : 1
}

if (import.meta.main) {
  if (registerOnlyRequested(ROW)) process.exit(0)
  process.exit(runCli(process.argv.slice(2), { register: true }))
}
