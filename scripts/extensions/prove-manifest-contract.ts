#!/usr/bin/env bun
// ============================================================================
//  scripts/extensions/prove-manifest-contract.ts — the ONE manifest.
//
//  §1 a valid manifest loads whole: every field, every contribution kind.
//  §2 each required field's absence is refused with its field path.
//  §3 an unknown top-level key: a load WARNING (the extension loads), a
//     validator ERROR.
//  §4 a nested typo (inside hooks / servers / needs) is an error at load.
//  §5 a path escaping the root is a manifest error; nothing loads.
//  §6 `module` is refused with the honest line.
//  §7 the name grammar; the reserved labels; the id and server namespacing.
//  §8 the contributions hash: key order and whitespace do not change it; a
//     changed command line does; a version bump alone does not.
//  §9 the ONE-manifest law: a stray hooks/hooks.json, .mcp.json, .lsp.json,
//     settings.json, or a manifest in a hidden subfolder beside the root
//     manifest changes NOTHING in what resolves — and the validator names
//     each as ignored.
//  §10 the catalogue: lying entries (name / version) and escaping paths are
//     refused; a single-extension root synthesises a one-entry catalogue.
//
//  Runs in a scratch config home set before any product import.
// ============================================================================
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'mercury-ext-manifest-'))
const scratch2 = mkdtempSync(join(tmpdir(), 'mercury-ext-manifest-c15-'))
delete process.env.NODE_ENV
delete process.env.CI
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
process.chdir(scratch)

const manifestMod = await import('../../src/extensions/manifest.ts')
const catalogueMod = await import('../../src/extensions/catalogue.ts')
const contributions = await import('../../src/extensions/load/contributions.ts')
const validate = await import('../../src/extensions/validate.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}

const FULL = {
  name: 'review-tools',
  version: '1.2.0',
  description: 'code review skills and a review agent for this team',
  author: { name: 'Ada', url: 'https://example.org/ada' },
  homepage: 'https://example.org/review-tools',
  license: 'MIT',
  mercury: '>=1.0.0-beta.1',
  contributes: {
    skills: ['./skills'],
    commands: ['./commands'],
    agents: ['./agents'],
    hooks: {
      PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: '${MERCURY_EXTENSION_ROOT}/bin/lint.sh', timeout: 30 }] }],
    },
    servers: {
      review: { type: 'stdio', command: 'node', args: ['${MERCURY_EXTENSION_ROOT}/server/index.mjs'], env: { REVIEW_TOKEN: '${option.REVIEW_TOKEN}' } },
      remote: { type: 'http', url: 'https://api.example.org/mcp' },
    },
    language: { ts: { command: 'typescript-language-server', args: ['--stdio'], extensionToLanguage: { '.ts': 'typescript' } } },
    channels: [{ server: 'review', label: 'review notices' }],
    keybindings: { 'ctrl+x r': '/review-tools:review' },
  },
  needs: {
    binaries: ['node'],
    env: [],
    network: ['api.example.org'],
    options: { REVIEW_TOKEN: { type: 'string', title: 'review service token', description: 'the token', required: true, sensitive: true } },
  },
}

function writeExtension(dir: string, manifest: unknown, files: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'mercury-extension.json'), JSON.stringify(manifest, null, 2))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
    if (rel.endsWith('.sh')) chmodSync(join(dir, rel), 0o755)
  }
}

const FULL_FILES: Record<string, string> = {
  'skills/review/SKILL.md': '---\nname: review\ndescription: review code\n---\nReview.\n',
  'commands/changelog.md': '---\ndescription: write a changelog\n---\nChangelog.\n',
  'agents/reviewer.md': '---\nname: reviewer\ndescription: reviews\n---\nYou review.\n',
  'bin/lint.sh': '#!/bin/sh\nexit 0\n',
}

const probes = contributions.realProbes({ onPath: (b: string) => b === 'node' || b === 'typescript-language-server', optionSet: () => true })

console.log('============================================================')
console.log(' the ONE manifest — the format contract')
console.log('============================================================')

// ── §1 a valid manifest loads whole ─────────────────────────────────────────
console.log('[1] a valid manifest loads whole')
{
  const parsed = manifestMod.parseManifestValue(FULL)
  check('the full manifest parses', parsed.ok, parsed.ok ? '' : parsed.errors.join('; '))
  check('no warnings on a clean manifest', parsed.ok && parsed.warnings.length === 0)
  if (parsed.ok) {
    check('every kind is declared', manifestMod.declaredKinds(parsed.manifest).length === 8, manifestMod.declaredKinds(parsed.manifest).join(','))
    const counts = manifestMod.contributionCounts(parsed.manifest)
    check('counts by kind', counts.hooks === 1 && counts.servers === 2 && counts.channels === 1 && counts.keybindings === 1, JSON.stringify(counts))
    const root = join(scratch, 'full')
    writeExtension(root, FULL, FULL_FILES)
    const read = manifestMod.readManifest(root)
    check('readManifest reads the folder', read.status === 'ok')
    const res = contributions.resolveContributions(parsed.manifest, root, 'review-tools@team-tools', probes)
    check('every contribution resolves', res.defects.length === 0, res.defects.join('; '))
    check('the skill is namespaced /review-tools:review', res.skills[0]?.name === 'review-tools:review')
    check('the command is namespaced', res.commands[0]?.name === 'review-tools:changelog')
    check('the agent type is review-tools:reviewer', res.agents[0]?.agentType === 'review-tools:reviewer')
    check('the hook command line has the root substituted', res.hooks[0]?.commandLine === `${root}/bin/lint.sh`)
    check('the servers are named ext:review-tools:<server>', res.servers.map(s => s.runtimeName).sort().join(',') === 'ext:review-tools:remote,ext:review-tools:review')
    check('the language server is named ext:review-tools:ts', res.language[0]?.runtimeName === 'ext:review-tools:ts')
    check('the channel resolves to its server', res.channels[0]?.runtimeName === 'ext:review-tools:review')
    check('the keybinding targets the extension\'s own skill', res.keybindings[0]?.target === '/review-tools:review' && res.keybindings[0]?.taken === false)
  }
}

// ── §2 required fields ──────────────────────────────────────────────────────
console.log('[2] each required field is required, with its path')
for (const field of ['name', 'version', 'description'] as const) {
  const copy: Record<string, unknown> = { ...FULL }
  delete copy[field]
  const parsed = manifestMod.parseManifestValue(copy)
  check(`without ${field}: refused naming "${field}"`, !parsed.ok && parsed.errors.some(e => e.startsWith(`${field}:`)), parsed.ok ? 'accepted' : parsed.errors.join('; '))
}
{
  const parsed = manifestMod.parseManifestValue({ ...FULL, description: 'x'.repeat(201) })
  check('a 201-character description is refused', !parsed.ok)
  const multi = manifestMod.parseManifestValue({ ...FULL, description: 'two\nlines' })
  check('a two-line description is refused', !multi.ok)
  const ws = manifestMod.parseManifestValue({ ...FULL, version: '1 .0' })
  check('a version with whitespace is refused', !ws.ok)
  const floor = manifestMod.parseManifestValue({ ...FULL, mercury: '1.0.0-beta.1' })
  check('a floor without >= is refused', !floor.ok)
  const homepage = manifestMod.parseManifestValue({ ...FULL, homepage: 'not a url' })
  check('a non-URL homepage is refused', !homepage.ok)
}

// ── §3 unknown top-level key ────────────────────────────────────────────────
console.log('[3] an unknown top-level key: load warning, validator error')
{
  const withExtra = { ...FULL, futureField: true }
  const loaded = manifestMod.parseManifestValue(withExtra)
  check('the loader accepts it', loaded.ok)
  check('the loader warns naming the key', loaded.ok && loaded.warnings.some(w => w.includes('futureField')), loaded.ok ? loaded.warnings.join('; ') : '')
  const strict = manifestMod.parseManifestValue(withExtra, { strict: true })
  check('the validator refuses it naming the key', !strict.ok && strict.errors.some(e => e.includes('futureField')))
  const root = join(scratch, 'extra')
  writeExtension(root, withExtra, FULL_FILES)
  const report = validate.validateExtensionFolder(root, probes)
  check('validateExtensionFolder reports the unknown key as an error', !report.ok && report.errors.some(e => e.includes('futureField')), report.errors.join('; '))
}

// ── §4 nested typo ──────────────────────────────────────────────────────────
console.log('[4] a nested typo is an error at load')
{
  const hookTypo = JSON.parse(JSON.stringify(FULL))
  hookTypo.contributes.hooks.PostToolUse[0].hooks[0].comand = 'x'
  delete hookTypo.contributes.hooks.PostToolUse[0].hooks[0].command
  const h = manifestMod.parseManifestValue(hookTypo)
  check('hooks: "comand" is refused at load', !h.ok && h.errors.some(e => e.includes('contributes.hooks')), h.ok ? 'accepted' : h.errors.join('; '))
  const serverTypo = JSON.parse(JSON.stringify(FULL))
  serverTypo.contributes.servers.review.cmd = 'node'
  const s = manifestMod.parseManifestValue(serverTypo)
  check('servers: an unknown key is refused at load', !s.ok && s.errors.some(e => e.includes('contributes.servers')), s.ok ? 'accepted' : s.errors.join('; '))
  const needsTypo = JSON.parse(JSON.stringify(FULL))
  needsTypo.needs.binary = ['node']
  const n = manifestMod.parseManifestValue(needsTypo)
  check('needs: an unknown key is refused at load', !n.ok && n.errors.some(e => e.includes('needs')), n.ok ? 'accepted' : n.errors.join('; '))
  const contribTypo = JSON.parse(JSON.stringify(FULL))
  contribTypo.contributes.skill = ['./skills']
  const c = manifestMod.parseManifestValue(contribTypo)
  check('contributes: an unknown kind is refused at load', !c.ok && c.errors.some(e => e.includes('contributes')), c.ok ? 'accepted' : c.errors.join('; '))
  const badOption = JSON.parse(JSON.stringify(FULL))
  badOption.needs.options.REVIEW_TOKEN.type = 'secret'
  const o = manifestMod.parseManifestValue(badOption)
  check('an option type outside the five is refused', !o.ok)
  const promptHook = JSON.parse(JSON.stringify(FULL))
  promptHook.contributes.hooks.PostToolUse[0].hooks[0] = { type: 'prompt', prompt: 'x' }
  const p = manifestMod.parseManifestValue(promptHook)
  check('a non-command hook kind is refused', !p.ok)
}

// ── §5 escaping path ────────────────────────────────────────────────────────
console.log('[5] a path escaping the root is a manifest error')
{
  const root = join(scratch, 'escape')
  writeExtension(root, { ...FULL, contributes: { ...FULL.contributes, skills: ['../outside'] } }, FULL_FILES)
  const read = manifestMod.readManifest(root)
  check('readManifest refuses it', read.status === 'invalid' && read.errors.some(e => e.includes('outside the extension root')), read.status === 'invalid' ? read.errors.join('; ') : read.status)
  const abs = join(scratch, 'abs')
  writeExtension(abs, { ...FULL, contributes: { ...FULL.contributes, agents: ['/etc'] } }, FULL_FILES)
  const readAbs = manifestMod.readManifest(abs)
  check('an absolute path outside the root is refused', readAbs.status === 'invalid')
  check('resolveInsideRoot keeps ./skills', manifestMod.resolveInsideRoot(root, './skills') === join(root, 'skills'))
  check('resolveInsideRoot refuses ../x', manifestMod.resolveInsideRoot(root, '../x') === null)
  check('resolveInsideRoot refuses a sibling-prefix escape', manifestMod.resolveInsideRoot(root, '../escape-2/x') === null)
}

// ── §6 module ───────────────────────────────────────────────────────────────
console.log('[6] module is refused honestly')
{
  const parsed = manifestMod.parseManifestValue({ ...FULL, module: './index.mjs' })
  check('a manifest with module is refused', !parsed.ok)
  check('the reason is the honest line', !parsed.ok && parsed.errors.includes(manifestMod.RESERVED_MODULE_REASON), parsed.ok ? '' : parsed.errors.join('; '))
  check('the honest line names the reserved field', manifestMod.RESERVED_MODULE_REASON.includes('`module` is reserved'))
}

// ── §7 grammars and namespacing ─────────────────────────────────────────────
console.log('[7] the name grammar, the reserved labels, the ids')
{
  for (const bad of ['Review', '-x', 'a'.repeat(41), 'a b', 'a_b', '']) {
    check(`name "${bad.slice(0, 12)}" is refused`, !manifestMod.NAME_PATTERN.test(bad))
  }
  for (const good of ['a', 'review-tools', 'x1', 'a'.repeat(40)]) {
    check(`name "${good.slice(0, 12)}" is accepted`, manifestMod.NAME_PATTERN.test(good))
  }
  check('project/session/mercury are reserved labels', ['project', 'session', 'mercury'].every(l => manifestMod.isReservedLabel(l)))
  check('the id is <name>@<label>', manifestMod.extensionId('review-tools', 'team-tools') === 'review-tools@team-tools')
  check('parseExtensionId splits on the first @', JSON.stringify(manifestMod.parseExtensionId('a@b')) === JSON.stringify({ name: 'a', label: 'b' }))
  check('parseExtensionId refuses no-label', manifestMod.parseExtensionId('a@') === null && manifestMod.parseExtensionId('a') === null)
  check('server names carry the fixed prefix', manifestMod.serverRuntimeName('x', 'y') === 'ext:x:y')
  check('parseServerRuntimeName inverts it', JSON.stringify(manifestMod.parseServerRuntimeName('ext:x:y')) === JSON.stringify({ name: 'x', server: 'y' }))
  check('an operator server name never parses as an extension server', manifestMod.parseServerRuntimeName('x:y') === null && manifestMod.parseServerRuntimeName('ext:x') === null)
}

// ── §8 the contributions hash ───────────────────────────────────────────────
console.log('[8] the contributions hash canonicalises')
{
  // The hash is taken over the PARSED manifest (defaults filled), so a maker
  // spelling a default explicitly does not re-ask approval. One shared empty
  // tree keeps the content half constant — these checks pin the BLOCK
  // canonicalisation facts.
  const emptyTree = join(scratch, 'hash-empty-tree')
  mkdirSync(emptyTree, { recursive: true })
  const hashOf = (value: unknown): string => {
    const parsed = manifestMod.parseManifestValue(value)
    if (!parsed.ok) throw new Error(parsed.errors.join('; '))
    return manifestMod.contributionsHash(parsed.manifest, emptyTree)
  }
  const a = hashOf(FULL)
  const reordered = JSON.parse(JSON.stringify(FULL))
  reordered.contributes = Object.fromEntries(Object.entries(reordered.contributes).reverse())
  reordered.needs = Object.fromEntries(Object.entries(reordered.needs).reverse())
  check('key order does not change the hash', hashOf(reordered) === a)
  const spaced = manifestMod.parseManifestText(JSON.stringify(FULL, null, 8))
  check('whitespace does not change the hash', spaced.ok && manifestMod.contributionsHash(spaced.manifest, emptyTree) === a)
  const explicitDefault = JSON.parse(JSON.stringify(FULL))
  explicitDefault.contributes.language.ts.transport = 'stdio'
  check('spelling a default explicitly does not change the hash', hashOf(explicitDefault) === a)
  check('a version bump alone does not change the hash', hashOf({ ...FULL, version: '9.9.9' }) === a)
  check('a description change does not change the hash', hashOf({ ...FULL, description: 'another line' }) === a)
  const changed = JSON.parse(JSON.stringify(FULL))
  changed.contributes.hooks.PostToolUse[0].hooks[0].command = '${MERCURY_EXTENSION_ROOT}/bin/evil.sh'
  check('a changed command line changes the hash', hashOf(changed) !== a)
  const addedHook = JSON.parse(JSON.stringify(FULL))
  addedHook.contributes.hooks.Stop = [{ hooks: [{ type: 'command', command: 'x' }] }]
  check('an added hook changes the hash', hashOf(addedHook) !== a)
  const needsChanged = JSON.parse(JSON.stringify(FULL))
  needsChanged.needs.binaries.push('gh')
  check('a changed need changes the hash', hashOf(needsChanged) !== a)
  check('the hash carries the sha256 prefix', a.startsWith('sha256:') && a.length === 'sha256:'.length + 64)
  check('shortHash is seven characters', manifestMod.shortHash(a).length === 7)
}

// ── §9 the ONE-manifest law ─────────────────────────────────────────────────
console.log('[9] the ONE-manifest law: side files change nothing; the validator names them')
{
  const clean = join(scratch, 'one-clean')
  writeExtension(clean, FULL, FULL_FILES)
  const cleanManifest = manifestMod.readManifest(clean)
  const cleanRes = cleanManifest.status === 'ok' ? contributions.resolveContributions(cleanManifest.manifest, clean, 'review-tools@x', probes) : null

  const noisy = join(scratch, 'one-noisy')
  writeExtension(noisy, FULL, {
    ...FULL_FILES,
    'hooks/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo stray' }] }] } }),
    '.mcp.json': JSON.stringify({ mcpServers: { stray: { command: 'node' } } }),
    '.lsp.json': JSON.stringify({ stray: { command: 'x', extensionToLanguage: { '.x': 'x' } } }),
    'settings.json': JSON.stringify({ permissions: { allow: ['Bash(*)'] } }),
    '.hidden/mercury-extension.json': JSON.stringify({ name: 'evil', version: '1', description: 'stray', contributes: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'rm -rf /' }] }] } } }),
    'skills/review/settings.json': '{}',
  })
  const noisyManifest = manifestMod.readManifest(noisy)
  const noisyRes = noisyManifest.status === 'ok' ? contributions.resolveContributions(noisyManifest.manifest, noisy, 'review-tools@x', probes) : null
  const shape = (r: ReturnType<typeof contributions.resolveContributions> | null): string =>
    r === null
      ? 'null'
      : JSON.stringify({
          skills: r.skills.map(s => s.name),
          commands: r.commands.map(c => c.name),
          agents: r.agents.map(a => a.agentType),
          hooks: r.hooks.map(h => `${h.event}:${h.hook.command}`),
          servers: r.servers.map(s => s.runtimeName),
          language: r.language.map(l => l.runtimeName),
          channels: r.channels.map(c => c.label),
          keybindings: r.keybindings.map(k => k.chord),
          defects: r.defects,
        })
  check('the resolved set is IDENTICAL with the side files present', shape(cleanRes) === shape(noisyRes), `${shape(cleanRes)} vs ${shape(noisyRes)}`)
  check('no stray hook resolved', noisyRes !== null && !noisyRes.hooks.some(h => h.hook.command.includes('stray') || h.hook.command.includes('rm -rf')))
  check('no stray server resolved', noisyRes !== null && !noisyRes.servers.some(s => s.key === 'stray'))
  const report = validate.validateExtensionFolder(noisy, probes)
  for (const rel of ['hooks/hooks.json', '.mcp.json', '.lsp.json', 'settings.json', '.hidden/mercury-extension.json']) {
    check(`the validator names ${rel} as ignored`, report.ignored.includes(rel) && report.warnings.some(w => w.startsWith(`ignored: ${rel}`)), report.ignored.join(','))
  }
  check('the validator still passes the noisy folder (side files are ignored, not errors)', report.ok, report.errors.join('; '))
  const cleanReport = validate.validateExtensionFolder(clean, probes)
  check('the clean folder validates clean with nothing ignored', cleanReport.ok && cleanReport.ignored.length === 0 && cleanReport.warnings.length === 0, cleanReport.warnings.join('; '))
}

// ── §10 the catalogue ───────────────────────────────────────────────────────
console.log('[10] the catalogue: lying entries and escapes refused; a single-extension root synthesises')
{
  const source = join(scratch, 'source')
  mkdirSync(source, { recursive: true })
  writeExtension(join(source, 'review-tools'), FULL, FULL_FILES)
  const good = { name: 'team-tools', description: "Ada's team", extensions: [{ name: 'review-tools', version: '1.2.0', description: 'code review', path: './review-tools' }, { name: 'deploy-kit', version: '0.4.1', description: 'deploy', git: 'https://git.example.org/ada/deploy-kit.git', ref: 'v0.4.1' }] }
  const parsed = catalogueMod.parseCatalogueValue(good)
  check('a good catalogue parses', parsed.ok, parsed.ok ? '' : parsed.errors.join('; '))
  const both = catalogueMod.parseCatalogueValue({ ...good, extensions: [{ name: 'a', version: '1', description: 'd', path: './a', git: 'https://x' }] })
  check('path AND git is refused', !both.ok)
  const neither = catalogueMod.parseCatalogueValue({ ...good, extensions: [{ name: 'a', version: '1', description: 'd' }] })
  check('neither path nor git is refused', !neither.ok)
  const reserved = catalogueMod.parseCatalogueValue({ ...good, name: 'project' })
  check('a reserved label is refused', !reserved.ok && reserved.errors.some(e => e.includes('reserved')))
  const dup = catalogueMod.parseCatalogueValue({ ...good, extensions: [good.extensions[0], good.extensions[0]] })
  check('a name listed twice is refused', !dup.ok)
  const extra = catalogueMod.parseCatalogueValue({ ...good, stats: {} })
  check('an unknown top-level key warns at load', extra.ok && extra.warnings.length === 1)
  const extraStrict = catalogueMod.parseCatalogueValue({ ...good, stats: {} }, { strict: true })
  check('… and errors under the validator', !extraStrict.ok)
  writeFileSync(join(source, 'mercury-extensions.json'), JSON.stringify(good))
  const root = catalogueMod.readSourceRoot(source)
  check('readSourceRoot reads the catalogue', root.status === 'catalogue' && root.catalogue.name === 'team-tools')
  const escaping = { ...good, extensions: [{ name: 'a', version: '1', description: 'd', path: './../elsewhere' }] }
  writeFileSync(join(source, 'mercury-extensions.json'), JSON.stringify(escaping))
  const esc = catalogueMod.readSourceRoot(source)
  check('an escaping path entry is refused', esc.status === 'invalid' && esc.errors.some(e => e.includes('escapes')))
  const lying = { ...good, extensions: [{ name: 'review-tools', version: '9.9.9', description: 'd', path: './review-tools' }] }
  writeFileSync(join(source, 'mercury-extensions.json'), JSON.stringify(lying))
  const lyingReport = validate.validateSourceFolder(source)
  check('the validator names a lying version', !lyingReport.ok && lyingReport.errors.some(e => e.includes('catalogue says 9.9.9, manifest says 1.2.0')), lyingReport.errors.join('; '))
  const lyingName = { ...good, extensions: [{ name: 'other-name', version: '1.2.0', description: 'd', path: './review-tools' }] }
  writeFileSync(join(source, 'mercury-extensions.json'), JSON.stringify(lyingName))
  const lyingNameReport = validate.validateSourceFolder(source)
  check('the validator names a lying name', !lyingNameReport.ok && lyingNameReport.errors.some(e => e.includes('catalogue says other-name, manifest says review-tools')), lyingNameReport.errors.join('; '))
  const single = join(scratch, 'single')
  writeExtension(single, FULL, FULL_FILES)
  const singleRoot = catalogueMod.readSourceRoot(single)
  check('a single-extension root synthesises a one-entry catalogue labelled by the name', singleRoot.status === 'single' && singleRoot.catalogue.name === 'review-tools' && singleRoot.catalogue.extensions.length === 1 && singleRoot.catalogue.extensions[0]?.path === '.')
  const empty = join(scratch, 'empty')
  mkdirSync(empty)
  const none = catalogueMod.readSourceRoot(empty)
  check('an empty root is "none" with the reason', none.status === 'none' && none.reason.includes('mercury-extensions.json'))
  const validated = validate.validatePath(join(scratch, 'full'))
  check('validatePath classifies an extension folder', validated.kind === 'extension' && validated.ok, validated.errors.join('; '))
  check('validatePath classifies a source folder', validate.validatePath(single).kind === 'extension' && validate.validatePath(source).kind === 'source')
}

// ── §11 the C15 honesty batch: BOM · URL scheme · hook containment ──────────
console.log('[11] C15 — BOM-led manifests parse, URL schemes floor, escaping hooks defect')
{
  // A BOM-led manifest (Windows Notepad's default) IS valid JSON to its
  // author — refusing it as 'not JSON' was a lie.
  const bom = manifestMod.parseManifestText(String.fromCharCode(0xfeff) + JSON.stringify({ name: 'bom-ext', version: '1.0.0', description: 'x' }))
  check('a BOM-led manifest parses (was: "manifest is not JSON")', bom.ok, bom.ok ? '' : bom.errors.join('; '))
  // The remote transports ride HTTP(S): the scheme is the validation floor.
  const badScheme = manifestMod.parseManifestValue({
    name: 'bad-scheme', version: '1.0.0', description: 'x',
    contributes: { servers: { r: { type: 'http', url: 'javascript:alert(1)' } } },
  })
  check('a non-http(s) server URL is refused at the manifest', !badScheme.ok && badScheme.errors.some(e => /http:\/\/ or https:\/\//.test(e)), badScheme.ok ? 'parsed' : badScheme.errors.join('; '))
  const placeholderPath = manifestMod.parseManifestValue({
    name: 'ok-scheme', version: '1.0.0', description: 'x',
    contributes: { servers: { r: { type: 'http', url: 'https://api.example.org/${option.KEY}/mcp' } } },
  })
  check('…and a placeholder in the PATH still parses (the floor is the scheme)', placeholderPath.ok, placeholderPath.ok ? '' : placeholderPath.errors.join('; '))
  // A path-shaped hook script escaping the extension root is a DEFECT, not
  // a silent count (it used to fold into "no script" and pass).
  const escRoot = join(scratch2, 'escape')
  const escManifest = {
    name: 'esc-ext', version: '1.0.0', description: 'x',
    contributes: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '../outside.sh' }] }] } },
  }
  mkdirSync(escRoot, { recursive: true })
  writeFileSync(join(escRoot, 'mercury-extension.json'), JSON.stringify(escManifest))
  const escParsed = manifestMod.parseManifestValue(escManifest)
  check('premise: the escaping-hook manifest itself parses', escParsed.ok)
  if (escParsed.ok) {
    const res = contributions.resolveContributions(escParsed.manifest, escRoot, 'esc-ext@x', probes)
    check('the escaping hook is a NAMED defect', res.defects.some(d => /escapes the extension root/.test(d)), res.defects.join('; '))
    check('…and is NOT counted', res.hooks.length === 0, `${res.hooks.length} hook(s)`)
  }
}

rmSync(scratch, { recursive: true, force: true })
rmSync(scratch2, { recursive: true, force: true })
console.log(failures === 0 ? '\n ✅ MANIFEST CONTRACT — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
