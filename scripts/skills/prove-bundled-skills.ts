#!/usr/bin/env bun

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const SOURCE_ROOT = join(ROOT, 'mercury-skills')
const BUNDLED_DIR = join(ROOT, 'src', 'skills', 'bundled')
const RUNTIME = join(ROOT, 'src', 'skills', 'bundledSkills.ts')
const FRONTMATTER = join(ROOT, 'src', 'utils', 'frontmatterParser.ts')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'bundled-skills-proof-')))
process.on('exit', () => rmSync(SCRATCH, { recursive: true, force: true }))
const POSIX = process.platform !== 'win32'

type Command = import('../../src/types/command.ts').Command
type BuiltRegistry = {
  getBundledSkills: () => Command[]
  getBundledSkillExtractDir: (name: string) => string
  registerAll: () => void
}

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const same = (a: readonly string[], b: readonly string[]): boolean => [...a].sort().join('\n') === [...b].sort().join('\n')
const promptText = async (command: Command, args: string): Promise<string> => {
  const out = await command.getPromptForCommand(args, {} as never)
  return Array.isArray(out) ? out.map(b => ((b as { type?: string; text?: string }).type === 'text' ? (b as { text: string }).text : '')).join('') : ''
}
const walkRel = (dir: string): string[] => {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(relative(dir, join(e.parentPath, e.name)).split('\\').join('/'))
  }
  return out.sort()
}

const gen = await import('./gen-bundled.ts')
const { codeOnlyText, commentRanges } = await import('../lib/codeText.ts')
const published = (path: string, text: string): string => {
  const before = text.split('\n')
  return codeOnlyText(path, text)
    .split('\n')
    .filter((line, index) => line.trim() !== '' || (before[index] ?? '').trim() === '')
    .join('\n')
}
const { parseFrontmatter } = await import('../../src/utils/frontmatterParser.js')
const { initBundledSkills } = await import('../../src/skills/bundled/index.js')
const { getBundledSkills, getBundledSkillExtractDir } = await import('../../src/skills/bundledSkills.js')
const { getBundledSkillsRoot } = await import('../../src/utils/permissions/filesystem.js')
const { getMercuryHome } = await import('../../src/utils/envUtils.js')

async function buildRegistry(label: string, wrappers: string[]): Promise<BuiltRegistry> {
  const srcDir = join(SCRATCH, 'built', label, 'src')
  const outDir = join(SCRATCH, 'built', label, 'out')
  mkdirSync(srcDir, { recursive: true })
  const entry = join(srcDir, 'entry.ts')
  writeFileSync(
    entry,
    wrappers.map((p, i) => `import * as w${i} from ${JSON.stringify(p)}`).join('\n') +
      `\nexport { getBundledSkills, getBundledSkillExtractDir } from ${JSON.stringify(RUNTIME)}\n` +
      `export function registerAll(): void {\n` +
      wrappers.map((_, i) => `  for (const fn of Object.values(w${i})) if (typeof fn === 'function') (fn as () => void)()`).join('\n') +
      `\n}\n`,
  )
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: outDir,
    target: 'bun',
    format: 'esm',
    loader: { ...gen.TEXT_LOADERS },
    define: { 'process.env.NODE_ENV': JSON.stringify('test') },
    plugins: [
      {
        name: 'bundled-skill-runtime',
        setup(build) {
          build.onResolve({ filter: /^\.\.\/bundledSkills\.js$/ }, () => ({ path: RUNTIME }))
          build.onResolve({ filter: /^\.\.\/\.\.\/utils\/frontmatterParser\.js$/ }, () => ({ path: FRONTMATTER }))
        },
      },
    ],
  })
  if (!result.success) throw new Error(`Bun.build failed for ${label}: ${result.logs.map(l => String(l)).join('\n')}`)
  return (await import(pathToFileURL(join(outDir, 'entry.js')).href)) as BuiltRegistry
}

const EXPECTED = gen.discoverSkills().names
const GENERATED = ['app-proof', 'extension-maker', 'mcp-smithy', 'pdf-documents', 'provider-apis', 'skill-forge', 'slide-decks', 'spreadsheets', 'word-documents']

initBundledSkills()
const skills = getBundledSkills()
const byName = new Map(skills.map(s => [s.name, s]))

section(`§1 REGISTERED — exactly the nine source skills; sixteen bundled, each with description + prompt`)
{
  check(same(EXPECTED, GENERATED), 'the source root carries exactly the nine generated skills', EXPECTED.join(' '))
  check(gen.discoverSkills().invalid.length === 0, 'every source dir name is a valid skill name')
  check(skills.length === 16, 'sixteen bundled skills register (seven hand-written + nine generated)', skills.map(s => s.name).join(' '))
  const handWritten = skills.filter(s => !GENERATED.includes(s.name)).map(s => s.name)
  check(handWritten.length === 7, 'the seven hand-written skills register beside the generated ones', handWritten.join(' '))
  for (const n of EXPECTED) {
    const s = byName.get(n)
    check(
      !!s && typeof s.description === 'string' && s.description.trim().length > 0 && typeof s.getPromptForCommand === 'function',
      `registered with description + prompt: ${n}`,
    )
  }
}

section('§2 NO DOUBLE-REGISTRATION — unique names + commands.ts de-dupes')
{
  const names = skills.map(s => s.name)
  check(new Set(names).size === names.length, 'no duplicate bundled skill names', `${names.length} skills`)
  const commandsSrc = readFileSync(join(ROOT, 'src', 'commands.ts'), 'utf8')
  check(
    /const deduped: Command\[\] = \[\]/.test(commandsSrc) && /return deduped/.test(commandsSrc),
    'commands.ts filters duplicates (return deduped, bundled/first wins)',
  )
}

section('§3 ISOLATION — extract to the temp root, never a user config home')
{
  const root = getBundledSkillsRoot()
  check(
    !root.startsWith(getMercuryHome()) && !root.startsWith(join(homedir(), '.mercury')),
    'the bundled-skills extract root is outside the config home',
    root,
  )
  check(root.includes('bundled-skills'), 'extract root is the dedicated per-process bundled-skills temp dir')
  for (const n of ['mcp-smithy', 'provider-apis', 'skill-forge']) {
    check(getBundledSkillExtractDir(n).startsWith(root), `${n} extract dir under the temp root`)
  }
  const bad: string[] = []
  for (const f of readdirSync(BUNDLED_DIR).filter(n => n.endsWith('Content.ts'))) {
    const src = readFileSync(join(BUNDLED_DIR, f), 'utf8')
    if (/^import .* from '\.\/[^']*\.(js|cjs|ts|mjs)'/m.test(src)) bad.push(f)
  }
  check(bad.length === 0, 'no Content module imports raw code as a text ref (all embedded)', bad.join(', ') || 'clean')
}

process.env.MERCURY_TMPDIR = join(SCRATCH, 'tmp')
mkdirSync(process.env.MERCURY_TMPDIR, { recursive: true })

section('§4 BUILT CONTENT — the nine wrappers under the text loader carry the source frontmatter, body and reference files')
{
  const built = await buildRegistry('generated', EXPECTED.map(n => join(BUNDLED_DIR, `${n}.ts`)))
  built.registerAll()
  const registered = new Map(built.getBundledSkills().map(s => [s.name, s]))
  check(same([...registered.keys()], EXPECTED), 'the nine generated wrappers register under their source names', [...registered.keys()].join(' '))
  for (const n of EXPECTED) {
    const source = readFileSync(join(SOURCE_ROOT, n, 'SKILL.md'), 'utf8')
    const { frontmatter, content } = parseFrontmatter(source)
    const s = registered.get(n)!
    check(typeof frontmatter.description === 'string' && s.description === frontmatter.description, `${n}: the registered description is the SKILL.md description verbatim`, s.description)
    const hint = typeof frontmatter['argument-hint'] === 'string' && frontmatter['argument-hint'].trim() ? frontmatter['argument-hint'] : undefined
    check(s.argumentHint === hint, `${n}: the registered argument hint is the SKILL.md hint (${hint ?? 'none'})`, String(s.argumentHint))
    check(s.type === 'prompt' && s.userInvocable !== false && s.isHidden !== true && s.disableModelInvocation === false, `${n}: a user-invocable, model-invocable prompt command`)
    const text = await promptText(s, 'the argument')
    const body = content.trimStart()
    check(body.length > 100 && text.includes(body), `${n}: the body renders verbatim (markdown, frontmatter stripped)`, `${body.length} chars`)
    check(!/^---[\s\S]*name:/.test(text.trimStart()) && !/<(?:h1|p|ul|li)>/.test(text), `${n}: no frontmatter and no HTML in the rendered prompt`)
    check(text.endsWith('\n\nthe argument'), `${n}: the argument is appended after the body`)

    const refs = walkRel(join(SOURCE_ROOT, n)).filter(rel => rel !== 'SKILL.md')
    const { SKILL_FILES } = (await import(join(BUNDLED_DIR, `${n}Content.ts`))) as { SKILL_FILES: Record<string, string> }
    check(same(Object.keys(SKILL_FILES), refs), `${n}: SKILL_FILES carries exactly the source's reference files (${refs.length})`, Object.keys(SKILL_FILES).join(' '))
    const extractDir = built.getBundledSkillExtractDir(n)
    if (refs.length === 0) {
      check(!text.startsWith('Base directory for this skill:') && !existsSync(extractDir), `${n}: no reference files ⇒ no base-directory line, nothing extracted`)
      continue
    }
    check(text.startsWith(`Base directory for this skill: ${extractDir} `), `${n}: the prompt opens on the base-directory line naming the extract dir`)
    for (const rel of refs) {
      const bytes = readFileSync(join(SOURCE_ROOT, n, rel))
      const mirrored = join(BUNDLED_DIR, n, rel)
      const extracted = join(extractDir, rel)
      check(existsSync(mirrored) && readFileSync(mirrored).equals(bytes), `${n}/${rel}: mirrored on disk byte-identical`)
      check(existsSync(extracted) && readFileSync(extracted).equals(bytes), `${n}/${rel}: extracted byte-identical`)
    }
  }
}

section('§5 GENERATOR CONTRACT — a hermetic fixture: embed / mirror / skip, build, extract, run, --check, prune, guards')
{
  const layout = { sourceRoot: join(SCRATCH, 'fixture', 'mercury-skills'), dest: join(SCRATCH, 'fixture', 'src', 'skills', 'bundled') }
  const src = (name: string, rel = ''): string => join(layout.sourceRoot, name, rel)
  const put = (path: string, content: string | Buffer): void => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  const FIX = 'proof-fixture'
  const SIB = 'proof-sibling'
  const DESCRIPTION = 'Use when a proof needs a fixture skill that ships helpers. Not for anything real.'
  const HINT = '<target> [mode]'
  const WHEN = 'when the bundled-skills proof exercises the generator'
  const BODY = '# Proof fixture\n\nRun `scripts/probe.mjs --self-test`, then `scripts/outline.py --self-test`; read `references/notes.md` on demand.\n'
  const SKILL_MD = `---\nname: ${FIX}\ndescription: ${DESCRIPTION}\nargument-hint: "${HINT}"\nwhen-to-use: ${WHEN}\n---\n${BODY}`
  const PROBE = '#!/usr/bin/env node\n// the fixture helper — embedded as a literal, extracted executable\nif (process.argv.includes("--self-test")) {\n  console.log("fixture helper ok")\n  process.exit(0)\n}\nconsole.error("usage: probe.mjs --self-test")\nprocess.exit(2)\n'
  const OUTLINE = '#!/usr/bin/env python3\nimport sys\nif "--self-test" in sys.argv:\n    print("fixture outline ok")\n    sys.exit(0)\nsys.exit(2)\n'
  const NOTES = '# Fixture notes\n\nA reference the skill reads on demand.\n'
  put(src(FIX, 'SKILL.md'), SKILL_MD)
  put(src(FIX, 'scripts/probe.mjs'), PROBE)
  put(src(FIX, 'scripts/outline.py'), OUTLINE)
  put(src(FIX, 'references/notes.md'), NOTES)
  put(src(FIX, 'assets/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))
  put(src(FIX, '__pycache__/outline.cpython-312.pyc'), Buffer.from([0xcb, 0xfa, 0x0d, 0x0a]))
  put(src(SIB, 'SKILL.md'), `---\ndescription: Use when the proof needs a second, reference-free skill.\n---\n# Sibling\n\nA body with no reference files at all.\n`)
  const HAND = 'hand-written'
  const HAND_TS = 'export function registerHandWrittenSkill(): void {}\n'
  put(join(layout.dest, `${HAND}.ts`), HAND_TS)
  put(join(layout.dest, 'unknown-dir', 'SKILL.md'), 'a dir with no marker-bearing module is not generator output\n')
  const assetsMap = join(ROOT, 'scripts', 'gate', 'generated-assets.tsv')
  const assetsBefore = readFileSync(assetsMap)
  const lines: string[] = []
  const quiet = { layout, log: (line: string) => lines.push(line) }
  const logIf = (ok: boolean): string => (ok ? '' : lines.join(' | '))

  const r = gen.renderSkill(FIX, layout)
  check(same(r.refs, ['references/notes.md', 'scripts/outline.py', 'scripts/probe.mjs']), 'SKILL_FILES keys: the two helpers and the reference; the binary and __pycache__ are skipped', r.refs.join(' '))
  check(same(r.mirror.map(m => m.rel), ['SKILL.md', 'references/notes.md', 'scripts/outline.py']), 'the mirror holds SKILL.md and the loader-safe refs only (no .mjs, no binary)', r.mirror.map(m => m.rel).join(' '))
  check(r.contentTs.includes(`import ref_scripts_outline_py from './${FIX}/scripts/outline.py'`) && r.contentTs.includes(`import ref_references_notes_md from './${FIX}/references/notes.md'`), 'the .py and .md refs are IMPORTED (text loader)')
  check(r.contentTs.includes(`"scripts/probe.mjs": ${JSON.stringify(PROBE)},`), 'the .mjs helper is EMBEDDED as a string literal with its shebang')
  check(!r.contentTs.includes('logo.png') && !r.contentTs.includes('pyc'), 'the binary and the bytecode never reach the Content module')
  check(r.contentTs.startsWith(`${gen.GENERATED_MARKER}\n`) && r.registerTs.startsWith(`${gen.GENERATED_MARKER}\n`), 'both modules open on the generated marker')
  check(r.wiring.importLine === `import { registerProofFixtureSkill } from './${FIX}.js'` && r.wiring.callLine === '  registerProofFixtureSkill()', 'the index wiring lines name the camel-cased register function')
  check(gen.GENERATED_MARKER.startsWith('export const ') && commentRanges('marker.ts', `${gen.GENERATED_MARKER}\n`).length === 0, 'the marker is a line of code, never a comment: a publish filter that keeps no comment cannot strip it', gen.GENERATED_MARKER)
  const contentComments = commentRanges(`${FIX}Content.ts`, r.contentTs).length
  const registerComments = commentRanges(`${FIX}.ts`, r.registerTs).length
  check(contentComments === 0 && registerComments === 0 && published(`${FIX}Content.ts`, r.contentTs) === r.contentTs && published(`${FIX}.ts`, r.registerTs) === r.registerTs, 'the rendered modules carry no comment range at all, so a comment-stripped checkout keeps the render byte for byte (the embedded helper keeps its own comments inside its string)', `${contentComments} + ${registerComments} comment range(s)`)

  const ORDER = 'proof-order'
  const orderLayout = { sourceRoot: join(SCRATCH, 'order', 'mercury-skills'), dest: join(SCRATCH, 'order', 'src', 'skills', 'bundled') }
  const orderSrc = (rel: string): string => join(orderLayout.sourceRoot, ORDER, rel)
  put(orderSrc('SKILL.md'), '---\ndescription: Use when the proof needs a skill whose references the filesystem may list in any order.\n---\n# Order\n')
  const ORDER_REFS = ['references/notes.md', 'references/Zed.md', 'references/alpha.md', 'references/index.md', 'scripts/probe.mjs', 'scripts/outline.py', 'scripts/helper.sh']
  for (const rel of ORDER_REFS) put(orderSrc(rel), `${rel}\n`)
  const SORTED_REFS = ['references/Zed.md', 'references/alpha.md', 'references/index.md', 'references/notes.md', 'scripts/helper.sh', 'scripts/outline.py', 'scripts/probe.mjs']
  const listing = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).map(e => e.name)
  console.log(`  · this filesystem lists ${ORDER}/references as: ${listing(orderSrc('references')).join(' ')} · scripts as: ${listing(orderSrc('scripts')).join(' ')}`)
  const ordered = gen.renderSkill(ORDER, orderLayout)
  const importOrder = (text: string): string[] => text.split('\n').filter(line => line.startsWith('import ref_')).map(line => /from '\.\/[^/]+\/(.+)'$/.exec(line)?.[1] ?? line)
  const entryOrder = (text: string): string[] => text.split('\n').filter(line => /^  "/.test(line)).map(line => /^  "([^"]+)"/.exec(line)?.[1] ?? line)
  check(ordered.refs.join(' ') === SORTED_REFS.join(' '), 'the references render in the code-point order of their paths, whatever order the filesystem lists them in (Zed before alpha: no locale, no case fold)', ordered.refs.join(' '))
  check(importOrder(ordered.contentTs).join(' ') === SORTED_REFS.filter(rel => !rel.endsWith('.mjs')).join(' ') && entryOrder(ordered.contentTs).join(' ') === SORTED_REFS.join(' ') && ordered.mirror.map(m => m.rel).join(' ') === ['SKILL.md', ...SORTED_REFS.filter(rel => !rel.endsWith('.mjs'))].join(' '), 'the Content module imports, lists and mirrors them in that order', `${importOrder(ordered.contentTs).join(' ')} · ${entryOrder(ordered.contentTs).join(' ')} · ${ordered.mirror.map(m => m.rel).join(' ')}`)
  const identical = (a: typeof ordered, b: typeof ordered): boolean => a.contentTs === b.contentTs && a.registerTs === b.registerTs && a.refs.join('\n') === b.refs.join('\n') && a.mirror.length === b.mirror.length && a.mirror.every((m, i) => m.rel === b.mirror[i]!.rel && m.bytes.equals(b.mirror[i]!.bytes))
  const reversed = gen.renderSkill(ORDER, orderLayout, dir => readdirSync(dir, { withFileTypes: true }).reverse())
  const rotated = gen.renderSkill(ORDER, orderLayout, dir => { const entries = readdirSync(dir, { withFileTypes: true }); return [...entries.slice(1), ...entries.slice(0, 1)] })
  check(identical(ordered, reversed) && identical(ordered, rotated), 'a reversed and a rotated directory listing render byte-identical modules and mirror (the render never depends on the listing order)', `reversed ${identical(ordered, reversed) ? 'same' : 'differs'} · rotated ${identical(ordered, rotated) ? 'same' : 'differs'}`)

  const fullRc = gen.runCli([], quiet)
  check(fullRc === 0, 'a full run over the fixture tree exits 0', logIf(fullRc === 0))
  lines.length = 0
  check(same(walkRel(join(layout.dest, FIX)), ['SKILL.md', 'references/notes.md', 'scripts/outline.py']), 'on disk: the mirror is exactly SKILL.md + the .py + the .md (the .mjs lives only in the Content module)', walkRel(join(layout.dest, FIX)).join(' '))
  check(readFileSync(join(layout.dest, FIX, 'scripts', 'outline.py'), 'utf8') === OUTLINE && readFileSync(join(layout.dest, FIX, 'SKILL.md'), 'utf8') === SKILL_MD, 'mirrored files are byte-identical to the source')
  check(gen.isGeneratedModule(join(layout.dest, `${FIX}.ts`)) && gen.isGeneratedModule(join(layout.dest, `${FIX}Content.ts`)) && gen.isGeneratedModule(join(layout.dest, `${SIB}.ts`)), 'the written modules carry the marker')
  check(readFileSync(assetsMap).equals(assetsBefore), 'a library run never records the generated-assets row')

  const built = await buildRegistry('fixture', [join(layout.dest, `${FIX}.ts`), join(layout.dest, `${SIB}.ts`)])
  built.registerAll()
  const fixture = built.getBundledSkills().find(s => s.name === FIX)
  const sibling = built.getBundledSkills().find(s => s.name === SIB)
  check(fixture !== undefined && sibling !== undefined && built.getBundledSkills().length === 2, 'both fixture wrappers register')
  check(fixture?.description === DESCRIPTION, 'the fixture description is the frontmatter description verbatim', String(fixture?.description))
  check(fixture?.argumentHint === HINT && fixture?.whenToUse === WHEN, 'the argument hint and when-to-use ride through the wrapper', `${fixture?.argumentHint} / ${fixture?.whenToUse}`)
  check(sibling?.argumentHint === undefined, 'a skill without a hint registers none')
  const extractDir = built.getBundledSkillExtractDir(FIX)
  check(extractDir.startsWith(process.env.MERCURY_TMPDIR!) && extractDir.includes('bundled-skills'), 'the fixture extract dir is under the runtime temp root (MERCURY_TMPDIR honoured)', extractDir)
  check(!existsSync(extractDir), 'nothing is extracted before the first invocation')
  const text = await promptText(fixture!, 'run it')
  check(text.startsWith(`Base directory for this skill: ${extractDir} `) && text.includes(BODY.trimStart()) && text.endsWith('\n\nrun it'), 'the prompt: base-directory line, the markdown body, the argument')
  check(!text.includes('<h1>') && !text.includes('description:'), 'no HTML, no frontmatter in the prompt')
  const siblingText = await promptText(sibling!, '')
  check(!siblingText.startsWith('Base directory') && siblingText.startsWith('# Sibling') && !existsSync(built.getBundledSkillExtractDir(SIB)), 'a reference-free skill neither announces nor creates an extract dir')

  const mode = (p: string): number => statSync(p).mode & 0o777
  const probe = join(extractDir, 'scripts', 'probe.mjs')
  const outline = join(extractDir, 'scripts', 'outline.py')
  const notes = join(extractDir, 'references', 'notes.md')
  check(same(walkRel(extractDir), ['references/notes.md', 'scripts/outline.py', 'scripts/probe.mjs']), 'extraction writes exactly the three reference files (no SKILL.md, no binary)', walkRel(extractDir).join(' '))
  check(readFileSync(probe, 'utf8') === PROBE && readFileSync(outline, 'utf8') === OUTLINE && readFileSync(notes, 'utf8') === NOTES, 'the extracted files are byte-identical to the source (embedded .mjs included)')
  if (POSIX) {
    check(mode(probe) === 0o700 && mode(outline) === 0o700, 'shebang helpers extract owner-executable (0700)', `${mode(probe).toString(8)} ${mode(outline).toString(8)}`)
    check(mode(notes) === 0o600, 'a plain reference extracts owner-read/write only (0600)', mode(notes).toString(8))
  } else {
    console.log('  (skip POSIX mode-bit checks — win32)')
  }
  check(execFileSync(process.execPath, [probe, '--self-test'], { encoding: 'utf8' }).trim() === 'fixture helper ok', 'the extracted .mjs helper runs its --self-test')
  const node = POSIX ? Bun.which('node') : null
  if (node !== null) check(execFileSync(probe, ['--self-test'], { encoding: 'utf8', env: { ...process.env, PATH: `${join(node, '..')}:${process.env.PATH ?? ''}` } }).trim() === 'fixture helper ok', 'the extracted .mjs helper runs directly by its shebang + mode bit')
  else console.log(POSIX ? '  (skip direct-shebang run — no node on PATH)' : '  (skip direct-shebang run — win32)')
  const python = Bun.which('python3')
  if (python !== null) check(execFileSync(python, [outline, '--self-test'], { encoding: 'utf8' }).trim() === 'fixture outline ok', 'the extracted .py helper runs its --self-test')
  else console.log('  (skip .py run — no python3 on PATH)')
  check((await promptText(fixture!, '')) !== '' && readFileSync(probe, 'utf8') === PROBE, 'a second invocation reuses the extraction (no rewrite, no error)')

  check(gen.checkSkill(FIX, layout).length === 0 && gen.checkBundled(layout).drift.length === 0, 'freshly generated ⇒ --check is clean')
  put(src(FIX, 'SKILL.md'), SKILL_MD.replace('Not for anything real.', 'Not for anything real, ever.'))
  check(same(gen.checkSkill(FIX, layout), [`${FIX}/SKILL.md: stale`]), 'an edited source SKILL.md ⇒ the mirror reads stale', gen.checkSkill(FIX, layout).join(' | '))
  put(src(FIX, 'references/extra.md'), '# Extra\n')
  check(same(gen.checkSkill(FIX, layout), [`${FIX}Content.ts: stale`, `${FIX}/SKILL.md: stale`, `${FIX}/references/extra.md: missing`]), 'a new source reference ⇒ the Content module reads stale and the mirror file missing', gen.checkSkill(FIX, layout).join(' | '))
  const driftRc = gen.runCli(['--check'], quiet)
  const driftOk = driftRc === 1 && lines.some(l => l.includes(`${FIX}/references/extra.md: missing`)) && lines.some(l => l.includes(`${SIB} in sync`))
  check(driftOk, '--check on the CLI exits 1 naming the drift, the sibling in sync', logIf(driftOk))
  lines.length = 0
  check(gen.runCli([FIX], quiet) === 0 && gen.checkBundled(layout).drift.length === 0, 'a targeted regeneration of the stale skill ⇒ clean again')
  lines.length = 0
  writeFileSync(join(layout.dest, FIX, 'references', 'notes.md'), 'a mirror-only edit\n')
  check(same(gen.checkSkill(FIX, layout), [`${FIX}/references/notes.md: stale`]), 'a mirror-only edit reads stale (the codegen would revert it)')
  put(join(layout.dest, FIX, 'scripts', 'leftover.py'), 'print("stray")\n')
  check(gen.checkSkill(FIX, layout).includes(`${FIX}/scripts/leftover.py: stray (not in the source, or not a mirrored kind)`), 'a file in the mirror with no source reads stray')
  check(gen.runCli([FIX], quiet) === 0 && !existsSync(join(layout.dest, FIX, 'scripts', 'leftover.py')) && gen.checkSkill(FIX, layout).length === 0, 'regeneration replaces the mirror whole: the stray is gone, the edit reverted')
  lines.length = 0

  rmSync(src(SIB), { recursive: true })
  check(same(gen.retiredSkills(layout), [SIB]), 'a removed source with marker-bearing modules is the retired set', gen.retiredSkills(layout).join(' '))
  check(gen.runCli([FIX], quiet) === 0 && existsSync(join(layout.dest, `${SIB}.ts`)) && existsSync(join(layout.dest, `${SIB}Content.ts`)) && existsSync(join(layout.dest, SIB, 'SKILL.md')), 'a targeted run of another skill leaves the retired output in place')
  lines.length = 0
  const retiredRc = gen.runCli(['--check'], quiet)
  const retiredOk = retiredRc === 1 && lines.some(l => l.includes(`${SIB}: retired output still present`))
  check(retiredOk, '--check names the retired output', logIf(retiredOk))
  lines.length = 0
  const before = readdirSync(layout.dest).sort()
  const pruneRc = gen.runCli([], quiet)
  const pruneOk = pruneRc === 0 && lines.some(l => l.includes(`${SIB}: retired — removed ${SIB}Content.ts, ${SIB}.ts, ${SIB}/`))
  check(pruneOk, 'a full run prunes the retired modules and their mirror dir', logIf(pruneOk))
  lines.length = 0
  check(same(readdirSync(layout.dest), before.filter(e => !e.startsWith(SIB))), 'and removes nothing else', readdirSync(layout.dest).sort().join(' '))
  check(readFileSync(join(layout.dest, `${HAND}.ts`), 'utf8') === HAND_TS && existsSync(join(layout.dest, 'unknown-dir', 'SKILL.md')), 'the hand-written module and the unknown dir survive the full run')
  check(gen.retiredSkills(layout).length === 0 && gen.runCli(['--check'], quiet) === 0, 'after the prune --check is clean')
  lines.length = 0
  put(src(SIB, 'SKILL.md'), '---\ndescription: Use when the proof needs the sibling back.\n---\nback\n')
  check(gen.runCli([SIB], quiet) === 0 && existsSync(join(layout.dest, `${SIB}.ts`)), 'a targeted run regenerates a named skill')
  lines.length = 0
  rmSync(src(SIB), { recursive: true })
  check(gen.runCli([SIB], quiet) === 0 && !existsSync(join(layout.dest, `${SIB}.ts`)) && !existsSync(join(layout.dest, SIB)) && existsSync(join(layout.dest, `${FIX}.ts`)), 'a targeted run naming a retired skill prunes that one only')
  lines.length = 0

  const snapshot = walkRel(layout.dest)
  const refused = gen.runCli(['../escape'], quiet) === 1 && gen.runCli(['a/b'], quiet) === 1 && gen.runCli(['.hidden'], quiet) === 1 && same(walkRel(layout.dest), snapshot)
  check(refused, 'a name with a dot, a slash or .. is refused before any path is built', logIf(refused))
  lines.length = 0
  check(gen.runCli(['no-such-skill'], quiet) === 1 && same(walkRel(layout.dest), snapshot), 'a name with no source and no output exits 1 and touches nothing')
  lines.length = 0
  rmSync(src(SIB), { recursive: true, force: true })
  put(src(SIB, 'SKILL.md'), '---\ndescription: Use when the proof needs retired output to protect.\n---\nback\n')
  check(gen.runCli([SIB], quiet) === 0, 'the sibling is regenerated to leave retired output for the option guards')
  rmSync(src(SIB), { recursive: true })
  lines.length = 0
  const withRetired = walkRel(layout.dest)
  const optionsRefused = ['--help', '--dry-run', '--chek'].every(option => gen.runCli([option], quiet) === 1) && same(walkRel(layout.dest), withRetired) && lines.some(l => l.includes('unknown option --help'))
  check(optionsRefused, 'an unknown option is refused before any run: nothing is written, the retired output stays', logIf(optionsRefused))
  lines.length = 0
  put(src('richContent', 'SKILL.md'), '---\ndescription: Use when the proof needs a name that ends in Content.\n---\nx\n')
  const upperRefused = gen.runCli(['richContent'], quiet) === 1 && gen.discoverSkills(layout).invalid.includes('richContent') && !existsSync(join(layout.dest, 'richContent.ts')) && same(walkRel(layout.dest), withRetired)
  check(upperRefused, 'a source dir with an uppercase letter is invalid: not generated by name, listed apart by discovery, nothing written', logIf(upperRefused))
  lines.length = 0
  rmSync(src('richContent'), { recursive: true })
  const emptyRoot = join(SCRATCH, 'fixture', 'empty-skills')
  mkdirSync(emptyRoot, { recursive: true })
  const emptyRefused = gen.runCli([], { layout: { sourceRoot: emptyRoot, dest: layout.dest }, log: quiet.log }) === 1 && same(walkRel(layout.dest), withRetired)
  check(emptyRefused, 'a full run that discovers no source skill refuses instead of pruning everything', logIf(emptyRefused))
  lines.length = 0
  check(gen.runCli([], quiet) === 0 && !existsSync(join(layout.dest, `${SIB}.ts`)) && !existsSync(join(layout.dest, SIB)), 'a full run over the real fixture root prunes the retired sibling again')
  lines.length = 0
  check(same(walkRel(layout.dest), snapshot), 'and the tree is back to the guard snapshot')
  put(src(HAND, 'SKILL.md'), '---\ndescription: Use when a source collides with a hand-written module.\n---\nx\n')
  const collisionOk = gen.runCli([HAND], quiet) === 1 && readFileSync(join(layout.dest, `${HAND}.ts`), 'utf8') === HAND_TS && !existsSync(join(layout.dest, HAND))
  check(collisionOk, 'a source named like a hand-written module is refused; the module is untouched, no mirror is created', logIf(collisionOk))
  lines.length = 0
  rmSync(src(HAND), { recursive: true })
  check(same(gen.pruneSkill(HAND, layout).kept, [`${HAND}.ts`]) && existsSync(join(layout.dest, `${HAND}.ts`)), 'pruneSkill keeps a module without the marker')
  check(same(gen.pruneSkill('unknown-dir', layout).kept, ['unknown-dir/']) && existsSync(join(layout.dest, 'unknown-dir', 'SKILL.md')), 'pruneSkill keeps a dir with no marker-bearing sibling module')
  check(readFileSync(assetsMap).equals(assetsBefore), 'no fixture run recorded the generated-assets row')
}

section('§6 SOURCE↔MIRROR SYNC + the discovery budget + the browser-first driving law')
{
  for (const n of EXPECTED) {
    const drift = gen.checkSkill(n)
    check(drift.length === 0, `${n}: modules + mirror are byte-identical to a fresh render of the source (gen-bundled ran)`, drift.join(' | '))
  }
  const publishedDest = join(SCRATCH, 'published', 'src', 'skills', 'bundled')
  mkdirSync(publishedDest, { recursive: true })
  for (const n of EXPECTED) {
    for (const file of [`${n}Content.ts`, `${n}.ts`]) writeFileSync(join(publishedDest, file), published(file, readFileSync(join(BUNDLED_DIR, file), 'utf8')))
    cpSync(join(BUNDLED_DIR, n), join(publishedDest, n), { recursive: true })
    const drift = gen.checkSkill(n, { sourceRoot: SOURCE_ROOT, dest: publishedDest })
    check(drift.length === 0, `${n}: on a published checkout (every comment range stripped, as the publish filter does) the modules still match a fresh render — the check the hosted gate runs`, drift.join(' | '))
    check(gen.isGeneratedModule(join(publishedDest, `${n}Content.ts`)) && gen.isGeneratedModule(join(publishedDest, `${n}.ts`)), `${n}: a published checkout still recognises both modules as generator output (the prune and the overwrite guard hold there too)`)
  }
  const { retired } = gen.checkBundled()
  check(retired.length === 0, 'no retired generated output lingers under src/skills/bundled/', retired.join(' '))
  const indexSrc = readFileSync(join(BUNDLED_DIR, 'index.ts'), 'utf8')
  check(EXPECTED.every(n => indexSrc.includes(`from './${n}.js'`)), 'index.ts imports every generated wrapper')

  const dist = existsSync(join(ROOT, 'dist', 'mercury.mjs')) ? readFileSync(join(ROOT, 'dist', 'mercury.mjs'), 'utf8') : null
  const descriptions = new Map<string, string>()
  for (const n of EXPECTED) {
    const { frontmatter } = parseFrontmatter(readFileSync(join(SOURCE_ROOT, n, 'SKILL.md'), 'utf8'))
    const d = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
    check(d.length > 0 && d.length <= 1000, `${n} description present and within the 1000-char discovery budget`, `${d.length} chars`)
    check(/\b(use when|when (the user|asked|you))\b/i.test(d + ' ' + String(frontmatter['when-to-use'] ?? '')), `${n} description carries a trigger`)
    check(!descriptions.has(d), `${n} description is distinct`)
    descriptions.set(d, n)
    if (dist) {
      const prefix = d.slice(0, 80)
      const spellings = [prefix, JSON.stringify(prefix).slice(1, -1), prefix.replaceAll("'", "\\'")]
      check(spellings.some(text => dist.includes(text)), `the BUILD inlined ${n}'s SKILL.md as text (description present in dist)`)
    }
  }
  if (!dist) console.log('  (skip dist-inlining checks — no dist/mercury.mjs)')

  const appProof = readFileSync(join(SOURCE_ROOT, 'app-proof', 'SKILL.md'), 'utf8')
  const desc = String(parseFrontmatter(appProof).frontmatter.description ?? '')
  check(desc.includes('Browser') && !desc.includes('Playwright'), 'app-proof routes on the Browser tool, never Playwright (the description IS the router)')
  check(/`Browser` tool is the default driver/.test(appProof), 'the Browser tool is named the default driver for journeys')
  check(!/Playwright[^.]{0,80}is the default driver/.test(appProof), 'Playwright is never named the default driver')
  check(appProof.includes('never hand-roll a headless-Chrome harness'), 'the hand-rolled-harness ban is spelled in the skill')
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? '✅ BUNDLED SKILLS GREEN' : `❌ BUNDLED SKILLS RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
