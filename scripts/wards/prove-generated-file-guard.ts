#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const RULE = 'no-hand-edit-generated-file'
const PROJECT = '/work/project'

async function main(): Promise<void> {
  delete process.env.MERCURY_WARDS
  const { mkdtempSync, openSync, readSync, closeSync, readFileSync, readdirSync, rmSync, mkdirSync, symlinkSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'wards-generated-home-'))
  const { BUILTIN_WARDS, evaluateWards, buildWardDenial } = await import('../../src/utils/wards/wards.js')
  const hook = await import('../../src/utils/hooks/wardsHook.js')
  const { registerWardsHook, resetWardsEngagedSessionsForTest } = hook
  const { getSessionFunctionHooks } = await import('../../src/utils/hooks/sessionHooks.js')
  const { parseGeneratedAssetsMap, GENERATED_ASSETS_MAP } = await import('../../src/utils/hooks/generatedAssets.js')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.js')

  const ROOT = join(import.meta.dir, '..', '..')
  type Resolved = { path: string; root: string | undefined }
  type Call = { toolName: string; input: Record<string, unknown>; readHead?: (path: string) => string | undefined; resolvePath?: (path: string) => Resolved }
  const heads = new Map<string, string>()
  const fakeReader = (path: string): string | undefined => heads.get(path)
  const realReader = (path: string): string | undefined => {
    let fd: number
    try {
      fd = openSync(path, 'r')
    } catch {
      return undefined
    }
    const buffer = Buffer.alloc(2048)
    let read = 0
    try {
      read = readSync(fd, buffer, 0, buffer.length, 0)
    } catch {
      return undefined
    } finally {
      closeSync(fd)
    }
    const slice = buffer.subarray(0, read)
    return slice.includes(0) ? undefined : slice.toString('utf8')
  }
  const rootedAt = (root: string) => (path: string): Resolved => ({ path, root: path === root || path.startsWith(`${root}/`) ? root : undefined })
  const projectResolver = rootedAt(PROJECT)
  const edit = (file_path: string, new_string = 'const changed = 2', readHead: Call['readHead'] = fakeReader, resolvePath: Call['resolvePath'] = projectResolver): Call => ({
    toolName: 'Edit',
    input: { file_path, old_string: 'const before = 1', new_string },
    readHead,
    resolvePath,
  })
  const write = (file_path: string, content: string, readHead: Call['readHead'] = fakeReader, resolvePath: Call['resolvePath'] = projectResolver): Call => ({ toolName: 'Write', input: { file_path, content }, readHead, resolvePath })
  const verdictOf = (call: Call) => evaluateWards(BUILTIN_WARDS, call)
  const deniedBy = (call: Call): string | null => {
    const v = verdictOf(call)
    return v.allow ? null : v.rule.name
  }
  const denialText = (call: Call): string => {
    const v = verdictOf(call)
    return v.allow ? 'ALLOWED' : buildWardDenial(v, call.toolName)
  }
  const scriptOf = (command: string): string | null => command.split(/\s+/).find(w => /[\\/]/.test(w) && !w.startsWith('-')) ?? null
  const GATE = 'The commit gate refuses the drift'

  console.log('============================================================')
  console.log(' the generated-file guard — proof')
  console.log('============================================================')

  section('A. the builtin rule exists with a name table and a leading-marker matcher')
  {
    const rule = BUILTIN_WARDS.find(r => r.name === RULE)
    check(`BUILTIN_WARDS carries '${RULE}'`, rule !== undefined, BUILTIN_WARDS.map(r => r.name).join(','))
    check('scope is edit', rule?.scope === 'edit', String(rule?.scope))
    check('the rule carries a generated-path table with generators', Array.isArray(rule?.generatedPaths) && rule.generatedPaths.length > 0 && rule.generatedPaths.every(r => typeof r.pattern === 'string'))
    check('the rule carries a leading-marker regex', typeof rule?.leadingMarker === 'string' && rule.leadingMarker.length > 0)
    check('the teaching says change the source and regenerate, and does not claim a commit gate for every project', typeof rule?.teach === 'string' && rule.teach.includes('Change the source') && rule.teach.includes('generator') && !rule.teach.includes('commit gate'), rule?.teach)
    check('no row names an upgrading command as the way to regenerate', rule !== undefined && rule.generatedPaths!.every(r => !/\b(?:update|upgrade)\b/.test(r.generator ?? '')), rule?.generatedPaths?.filter(r => /\b(?:update|upgrade)\b/.test(r.generator ?? '')).map(r => r.generator).join(' | '))
  }

  section('B. by name — a registered generated asset is refused and the generator is named')
  {
    const rel = edit('scripts/builtin-tools/fixtures/tool-census.json')
    check('Edit to the census JSON (repository-relative) ⇒ denied', deniedBy(rel) === RULE, denialText(rel))
    const abs = edit(`${PROJECT}/scripts/builtin-tools/fixtures/tool-census.md`)
    const text = denialText(abs)
    check('Edit to the census markdown (absolute path under the project root) ⇒ denied', deniedBy(abs) === RULE, text)
    check('the denial names the rule and quotes the matched name', text.includes(`Ward '${RULE}'`) && text.includes('scripts/builtin-tools/fixtures/tool-census.md'), text)
    check('the denial names the generator', text.includes('Regenerated by: bun scripts/builtin-tools/census-gen.ts'), text)
    check('the denial names the source to change', text.includes('Source: src/Tool.ts src/tools.ts src/tools/** src/utils/capability/**'), text)
    check('the denial teaches change-the-source', text.includes('Change the source'), text)
    check("the denial names this repository's commit gate and the row's check", text.includes(`${GATE}; its check: bun scripts/builtin-tools/prove-builtin-tools-census.ts.`), text)
    const rows: Array<[string, string]> = [
      [`${PROJECT}/scripts/settings/settings-schema.json`, 'bun scripts/settings/gen-settings-schema.ts'],
      [`${PROJECT}/scripts/consistency-census/basename-census.json`, 'bun scripts/consistency-census/gen-basename-census.ts'],
      [`${PROJECT}/scripts/consistency-census/lockup-census.json`, 'bun scripts/consistency-census/gen-lockup-census.ts'],
      [`${PROJECT}/scripts/consistency-census/shellstring-census.json`, 'bun scripts/consistency-census/gen-shellstring-census.ts'],
      [`${PROJECT}/assets/completions/_mercury`, 'bun run build.ts && bun scripts/project-services/gen-completions.ts'],
      [`${PROJECT}/src/skills/bundled/app-proof/SKILL.md`, 'bun scripts/skills/gen-bundled.ts'],
      [`${PROJECT}/src/skills/bundled/extension-maker/references/CONTRACT.md`, 'bun scripts/extensions/gen-contract.ts'],
      [`${PROJECT}/design-system/live/grids/frame--120x40--dark--truecolor--full.grid.json`, 'bun scripts/ui/generate-visual-baseline.ts'],
      [`${PROJECT}/design-system/live/manifest.json`, 'bun scripts/ui/generate-visual-baseline.ts'],
      [`${PROJECT}/scripts/ui/fixtures/motion-menu/menu-120x40.txt`, 'bun scripts/ui/motion-menu-stills.ts --write'],
      [`${PROJECT}/src/utils/vulcan/optable.generated.ts`, 'node scripts/vulcan/regen-optable.mjs'],
      [`${PROJECT}/assets/vulcan/addon/core/op_classes.gd`, 'node scripts/vulcan/regen-optable.mjs'],
    ]
    for (const [path, generator] of rows) {
      const t = denialText(edit(path))
      check(`${path.slice(PROJECT.length + 1)} ⇒ denied, regenerated by ${generator}`, t.includes(`Ward '${RULE}'`) && t.includes(`Regenerated by: ${generator}`), t)
    }
    const bundled = denialText(edit(`${PROJECT}/src/skills/bundled/app-proof/SKILL.md`))
    check('a map row with no separate check names the gate without a check', bundled.includes(`${GATE}.`) && !bundled.includes('its check'), bundled)
    const baseline = denialText(edit(`${PROJECT}/design-system/live/manifest.json`))
    check('a row outside the generated-assets map names no commit gate', !baseline.includes(GATE), baseline)
  }

  section("C. by leading marker — the target file's current head declares it generated")
  {
    const cases: Array<[string, string, string | null]> = [
      [`${PROJECT}/lib/schema.ts`, '// @generated\nexport const a = 1\n', null],
      [`${PROJECT}/api/api.pb.go`, '// Code generated by protoc-gen-go. DO NOT EDIT.\n// versions:\npackage api\n', null],
      [`${PROJECT}/config/routes.rb`, '# AUTO-GENERATED FILE\nRails.application.routes.draw do\nend\n', null],
      [`${PROJECT}/dist/types.d.ts`, '/* eslint-disable */\n/**\n * This file was automatically generated by json-schema-to-typescript.\n */\n', null],
      [`${PROJECT}/scripts/ui/lib/emojiProperties.ts`, '// ============================================================================\n//  scripts/ui/lib/emojiProperties.ts — GENERATED by gen-emoji-properties.ts\n', 'gen-emoji-properties.ts'],
      [`${PROJECT}/src/skills/bundled/app-proof.ts`, "// AUTO-GENERATED by scripts/skills/gen-bundled.ts — DO NOT EDIT BY HAND.\nimport x from 'y'\n", 'scripts/skills/gen-bundled.ts'],
      [`${PROJECT}/assets/splash/launcher-action-block.sh`, '#!/bin/bash\n# managed by scripts/splash/deploy.sh — do not hand-edit\n', 'scripts/splash/deploy.sh'],
      [`${PROJECT}/scripts/notifications/baselines/bench-concourse.json`, '{\n  "schema": 1,\n  "note": "generated by prove-concourse-budgets.ts — regenerate deliberately"\n}\n', 'prove-concourse-budgets.ts'],
      [`${PROJECT}/census.json`, '{\n  "generatedBy": "scripts/x/gen-census.ts",\n  "rows": []\n}\n', 'scripts/x/gen-census.ts'],
      [`${PROJECT}/docs/CENSUS.md`, '# census (GENERATED)\n\n> Regenerate: `bun run scripts/x/census-gen.ts`\n', 'scripts/x/census-gen.ts'],
      [`${PROJECT}/infra/.terraform.lock.hcl`, '# This file is maintained automatically by "terraform init".\n# Manual edits may be lost in future updates.\n', null],
      [`${PROJECT}/web/yarn.lock`, '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.\n# yarn lockfile v1\n', null],
      [`${PROJECT}/gen/Client.java`, '/**\n * NOTE: This class is auto generated by OpenAPI Generator.\n * Do not edit the class manually.\n */\n', null],
    ]
    for (const [path, head, script] of cases) {
      heads.set(path, head)
      const call = edit(path)
      const t = denialText(call)
      const named = script === null || t.includes(`Regenerated by: ${script}`)
      check(`${path.slice(PROJECT.length + 1)} with head ${JSON.stringify(head.split('\n')[0]?.slice(0, 48))} ⇒ denied${script ? `, naming ${script}` : ''}`, deniedBy(call) === RULE && named, t)
    }
    check("a marker denial names no commit gate (the gate is this repository's, known only for its map rows)", !denialText(edit(`${PROJECT}/lib/schema.ts`)).includes(GATE), denialText(edit(`${PROJECT}/lib/schema.ts`)))
    const deep = `${PROJECT}/lib/deep.ts`
    heads.set(deep, Array(12).fill('const a = 1').join('\n') + '\n// @generated\n')
    check('a marker past the first 12 lines is not a leading marker ⇒ allowed (the head read is bounded)', deniedBy(edit(deep)) === null, denialText(edit(deep)))
    const twelfth = `${PROJECT}/lib/twelfth.ts`
    heads.set(twelfth, Array(11).fill('const a = 1').join('\n') + '\n// @generated\n')
    check('a marker on line 12 ⇒ denied (the bound is inclusive)', deniedBy(edit(twelfth)) === RULE, denialText(edit(twelfth)))
    const noReader: Call = { toolName: 'Edit', input: { file_path: `${PROJECT}/lib/schema.ts`, old_string: 'a', new_string: 'b' }, resolvePath: projectResolver }
    check('with no head reader supplied the marker road stays quiet (the name road still applies)', deniedBy(noReader) === null, denialText(noReader))
    const v = verdictOf(edit(`${PROJECT}/api/api.pb.go`))
    check('a marker denial quotes the marker and its head line', v.allow === false && v.excerpt === 'Code generated by' && v.line === 1, JSON.stringify(v))
    heads.set(`${PROJECT}/lib/linked.ts`, '// @generated\n')
    const viaLink = edit(`${PROJECT}/lib/link-to-linked.ts`, 'const changed = 2', fakeReader, () => ({ path: `${PROJECT}/lib/linked.ts`, root: PROJECT }))
    check('the head is read at the RESOLVED path (a link spelling reads the real file) ⇒ denied', deniedBy(viaLink) === RULE, denialText(viaLink))
  }

  section('D. precision — hand-written files whose heads merely mention the words pass')
  {
    const passes: Array<[string, string, string]> = [
      [`${PROJECT}/src/app.ts`, "import x from 'y'\nexport const app = x\n", 'an ordinary source file'],
      [`${PROJECT}/src/constants/cyberRiskInstruction.ts`, '// ============================================================================\n//  src/constants/cyberRiskInstruction.ts — the cyber-risk instruction.\n//\n//  DO NOT EDIT without a safeguards review. The agent must not edit this\n', 'a hand-written DO NOT EDIT with a condition'],
      [`${PROJECT}/scripts/gate/generated-assets.tsv`, '# Generated assets: what regenerates each tracked asset, what proves it current, and which sources feed it.\n#\n# Columns (tab-separated): asset\tgenerator\tcheck\tsources\n#   asset      the tracked file(s) the generator writes\n#   generator  the command that regenerates the asset — never hand-edit the asset\n', 'the registry of generated assets (hand-maintained)'],
      [`${PROJECT}/src/skills/bundled/updateConfig.ts`, '// ============================================================================\n//  src/skills/bundled/updateConfig.ts — /update-config: configure the\n//  harness via settings files. Two modes: [hooks-only] emits only the hook\n//  documentation + construction flow; the full mode appends a JSON Schema\n//  GENERATED from the live settings schema, so a new settings field changes\n', 'a hand-written file that appends generated text'],
      [`${PROJECT}/README.md`, '# Project\n\nThe client is generated by the build; do not edit files under dist/ by hand.\n', 'prose about generated files elsewhere'],
      [`${PROJECT}/CODEOWNERS`, '# DO NOT EDIT without approval from the security owners\n* @owners\n', 'a conditional do-not-edit'],
      [`${PROJECT}/scripts/settings/gen-settings-schema.ts`, "#!/usr/bin/env bun\nimport { writeFileSync } from 'node:fs'\n", 'the generator itself'],
      [`${PROJECT}/docs/EXTENSIONS.md`, '# Extensions\n\nAn **extension** is a folder with ONE manifest.\n', 'a hand-written document with a spliced generated section'],
      [`${PROJECT}/assets/splash/splash-core.mjs`, '/* ============================================================================\n   (share-by-extraction).\n', 'a hand-written module with baked blocks'],
    ]
    for (const [path, head, why] of passes) {
      heads.set(path, head)
      check(`${path.slice(PROJECT.length + 1)} ⇒ allowed (${why})`, deniedBy(edit(path)) === null, denialText(edit(path)))
    }
    const bash = { toolName: 'Bash', input: { command: 'bun scripts/settings/gen-settings-schema.ts' }, shellCommand: 'bun scripts/settings/gen-settings-schema.ts' }
    check('running the generator through Bash is not an edit ⇒ allowed', deniedBy(bash) === null)
  }

  section('E. a Write that creates a generated file — by name, by lockfile, by its own head')
  {
    const named = write(`${PROJECT}/src/api/client.generated.ts`, 'export const client = 1\n')
    const namedText = denialText(named)
    check('Write creating foo.generated.ts ⇒ denied by name', deniedBy(named) === RULE && namedText.includes('.generated.ts'), namedText)
    check('a name-only denial carries no generator line and no gate line (neither is known)', !namedText.includes('Regenerated by:') && !namedText.includes(GATE), namedText)
    const dir = write(`${PROJECT}/src/generated/graphql.ts`, 'export type Q = {}\n')
    check('Write into a /generated/ directory inside the project ⇒ denied by name', deniedBy(dir) === RULE, denialText(dir))
    const locks: Array<[string, string]> = [
      ['bun.lock', 'its package manager (bun), from package.json'],
      ['package-lock.json', 'its package manager (npm), from package.json'],
      ['yarn.lock', 'its package manager (yarn), from package.json'],
      ['pnpm-lock.yaml', 'its package manager (pnpm), from package.json'],
      ['Cargo.lock', 'its package manager (cargo), from Cargo.toml'],
      ['poetry.lock', 'its package manager (poetry), from pyproject.toml'],
      ['uv.lock', 'its package manager (uv), from pyproject.toml'],
      ['Gemfile.lock', 'its package manager (bundler), from the Gemfile'],
      ['go.sum', 'the go tool, from go.mod'],
      ['flake.lock', 'nix, from flake.nix'],
      ['composer.lock', 'its package manager (composer), from composer.json'],
      ['native/desktop/Cargo.lock', 'its package manager (cargo), from Cargo.toml'],
    ]
    for (const [name, by] of locks) {
      const call = edit(`${PROJECT}/${name}`)
      const t = denialText(call)
      check(`${name} ⇒ denied, regenerated by ${by} (no upgrading command named)`, deniedBy(call) === RULE && t.includes(`Regenerated by: ${by}.`) && !/\b(?:update|upgrade)\b/.test(t), t)
    }
    const forged = write(`${PROJECT}/src/api/client.ts`, '// @generated by hand\nexport const client = 1\n')
    check('a Write whose own content opens with a generated marker ⇒ denied (a generated file is not hand-authored)', deniedBy(forged) === RULE, denialText(forged))
    heads.set(`${PROJECT}/src/api/existing.ts`, '// Code generated by openapi-codegen. DO NOT EDIT.\n')
    const overwrite = write(`${PROJECT}/src/api/existing.ts`, 'export const fresh = 1\n')
    check('a Write over an existing generated file (marker in its current head) ⇒ denied', deniedBy(overwrite) === RULE, denialText(overwrite))
  }

  section('F. an empty edit is still an edit — a deletion in a generated file is refused')
  {
    const deletion = edit(`${PROJECT}/scripts/settings/settings-schema.json`, '')
    check('an Edit whose new_string is empty (a deletion) ⇒ denied', deniedBy(deletion) === RULE, denialText(deletion))
    heads.set(`${PROJECT}/lib/gen.ts`, '// @generated\nexport const a = 1\n')
    const hunks: Call = { toolName: 'Edit', input: { file_path: `${PROJECT}/lib/gen.ts`, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '2', replace: '' }] }, readHead: fakeReader, resolvePath: projectResolver }
    check('a hunks edit with empty bodies on a marked file ⇒ denied', deniedBy(hunks) === RULE, denialText(hunks))
    const append: Call = { toolName: 'Edit', input: { file_path: `${PROJECT}/lib/gen.ts`, append: 'export const b = 2' }, readHead: fakeReader, resolvePath: projectResolver }
    check('an append on a marked file ⇒ denied', deniedBy(append) === RULE, denialText(append))
    const emptyOrdinary = edit(`${PROJECT}/src/app.ts`, '')
    check('an empty edit of an ordinary file stays allowed', deniedBy(emptyOrdinary) === null, denialText(emptyOrdinary))
  }

  section('G. the other roads that land bytes — ChangeSet members, the patch dialect, AstEdit, Git resolve, LSP apply')
  {
    const member = (file_path: string) => ({ file_path, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '2', replace: 'const changed = 2' }] })
    const call = (toolName: string, input: Record<string, unknown>): Call => ({ toolName, input, readHead: fakeReader, resolvePath: projectResolver })
    const marked = call('ChangeSet', { op: 'apply', changes: [member(`${PROJECT}/src/app.ts`), member(`${PROJECT}/lib/gen.ts`)] })
    const markedVerdict = verdictOf(marked)
    check('a ChangeSet whose second member is a marker-headed file ⇒ denied, on that member', deniedBy(marked) === RULE && !markedVerdict.allow && markedVerdict.target === `${PROJECT}/lib/gen.ts`, denialText(marked))
    const named = call('ChangeSet', { op: 'preview', changes: [member(`${PROJECT}/scripts/settings/settings-schema.json`)] })
    check('a ChangeSet preview on a registered asset ⇒ denied by name', deniedBy(named) === RULE && denialText(named).includes('Regenerated by: bun scripts/settings/gen-settings-schema.ts'), denialText(named))
    const clean = call('ChangeSet', { op: 'apply', changes: [member(`${PROJECT}/src/app.ts`)] })
    check('a ChangeSet on ordinary files ⇒ allowed', deniedBy(clean) === null, denialText(clean))
    const patch = call('ChangeSet', { op: 'preview', patch: `file ${PROJECT}/src/app.ts fa:0123456789ab\nreplace 2\n| const a = 2\nfile ${PROJECT}/lib/gen.ts fa:0123456789ab\ndelete 2\n` })
    const patchVerdict = verdictOf(patch)
    check('a patch-dialect section on a marker-headed file (a bodiless delete) ⇒ denied, on that section', deniedBy(patch) === RULE && !patchVerdict.allow && patchVerdict.target === `${PROJECT}/lib/gen.ts`, denialText(patch))
    const indented = call('ChangeSet', { op: 'preview', patch: `  file ${PROJECT}/lib/gen.ts fa:0123456789ab\n  delete 2\n` })
    check('an indented patch header (the parser trims op lines) ⇒ the section is still bound ⇒ denied', deniedBy(indented) === RULE, denialText(indented))
    const tabbed = call('ChangeSet', { op: 'preview', patch: `file\t${PROJECT}/lib/gen.ts\tfa:0123456789ab\ndelete\t2\n` })
    check('a tab-separated patch header (the parser splits on whitespace) ⇒ denied', deniedBy(tabbed) === RULE, denialText(tabbed))
    const moves: Array<[string, string]> = [
      [`${PROJECT}/src/client.generated.ts`, '.generated.ts'],
      [`${PROJECT}/bun.lock`, 'bun.lock'],
      [`${PROJECT}/src/generated/api2.ts`, 'src/generated/'],
    ]
    for (const [destination, excerpt] of moves) {
      const move = call('ChangeSet', { op: 'preview', patch: `file ${PROJECT}/src/app.ts fa:0123456789ab\nmove-to ${destination}\n` })
      const v = verdictOf(move)
      check(`a patch move-to onto ${destination.slice(PROJECT.length + 1)} ⇒ denied by name (the destination is a target)`, deniedBy(move) === RULE && !v.allow && v.excerpt === excerpt && v.target === destination, denialText(move))
    }
    const moveClean = call('ChangeSet', { op: 'preview', patch: `file ${PROJECT}/src/app.ts fa:0123456789ab\nmove-to ${PROJECT}/src/renamed.ts\n` })
    check('a patch move-to onto an ordinary path ⇒ allowed', deniedBy(moveClean) === null, denialText(moveClean))
    const astFile = call('AstEdit', { pattern: 'a', rewrite: 'b', path: `${PROJECT}/lib/gen.ts` })
    check('an AstEdit whose path is a marker-headed file ⇒ denied', deniedBy(astFile) === RULE, denialText(astFile))
    const astDir = call('AstEdit', { pattern: 'a', rewrite: 'b', path: `${PROJECT}/src/generated` })
    check('an AstEdit whose path is a generated/ directory ⇒ denied by name', deniedBy(astDir) === RULE, denialText(astDir))
    const astPlain = call('AstEdit', { pattern: 'a', rewrite: 'b', path: `${PROJECT}/src` })
    check('an AstEdit over an ordinary directory ⇒ allowed (the files it touches are chosen after the ward)', deniedBy(astPlain) === null, denialText(astPlain))
    const gitLock = call('Git', { op: 'resolve', path: 'bun.lock', content: '{\n  "lockfileVersion": 1\n}\n' })
    check('a Git resolve that hand-writes bun.lock ⇒ denied by name (the path is bound as the tool binds it, repo-relative)', deniedBy(gitLock) === RULE && denialText(gitLock).includes('Regenerated by: its package manager (bun), from package.json'), denialText(gitLock))
    const gitSchema = call('Git', { op: 'resolve', path: 'scripts/settings/settings-schema.json', content: '{}\n' })
    check('a Git resolve that hand-writes a map asset ⇒ denied naming the generator', deniedBy(gitSchema) === RULE && denialText(gitSchema).includes('Regenerated by: bun scripts/settings/gen-settings-schema.ts'), denialText(gitSchema))
    const gitForged = call('Git', { op: 'resolve', path: 'src/api/client.ts', content: '// @generated\nexport const a = 1\n' })
    check('a Git resolve whose content opens with a generated marker ⇒ denied', deniedBy(gitForged) === RULE, denialText(gitForged))
    const gitClean = call('Git', { op: 'resolve', path: 'src/app.ts', content: 'export const a = 1\n' })
    check('a Git resolve of an ordinary file ⇒ allowed', deniedBy(gitClean) === null, denialText(gitClean))
    const gitTake = call('Git', { op: 'resolve', path: 'bun.lock', take: 'theirs' })
    check('a Git resolve by take lands no model bytes ⇒ allowed', deniedBy(gitTake) === null, denialText(gitTake))
    const lspOrganize = call('LSP', { operation: 'organizeImports', filePath: `${PROJECT}/lib/gen.ts`, apply: true, plan: 'lsp-1' })
    check('an LSP organizeImports apply on a marker-headed file ⇒ denied', deniedBy(lspOrganize) === RULE, denialText(lspOrganize))
    const lspPreview = call('LSP', { operation: 'organizeImports', filePath: `${PROJECT}/lib/gen.ts` })
    check('the same operation without apply (a preview) writes nothing ⇒ allowed', deniedBy(lspPreview) === null, denialText(lspPreview))
    const lspMove = call('LSP', { operation: 'moveSymbol', filePath: `${PROJECT}/src/app.ts`, line: 1, character: 1, targetPath: `${PROJECT}/src/api/client.generated.ts`, apply: true, plan: 'lsp-2' })
    check('an LSP moveSymbol apply whose targetPath is a *.generated.ts ⇒ denied by name', deniedBy(lspMove) === RULE, denialText(lspMove))
    const lspRename = call('LSP', { operation: 'pathRename', filePath: `${PROJECT}/src/app.ts`, newPath: `${PROJECT}/bun.lock`, apply: true, plan: 'lsp-3' })
    check('an LSP pathRename apply whose newPath is a lockfile ⇒ denied by name', deniedBy(lspRename) === RULE, denialText(lspRename))
    const lspFormat = call('LSP', { operation: 'formatDocument', filePath: `${PROJECT}/scripts/settings/settings-schema.json`, apply: true, plan: 'lsp-4' })
    check('an LSP formatDocument apply on a map asset ⇒ denied naming the generator', deniedBy(lspFormat) === RULE && denialText(lspFormat).includes('Regenerated by: bun scripts/settings/gen-settings-schema.ts'), denialText(lspFormat))
    const lspClean = call('LSP', { operation: 'rename', filePath: `${PROJECT}/src/app.ts`, line: 1, character: 1, newName: 'b', apply: true, plan: 'lsp-5' })
    check('an LSP apply on an ordinary file ⇒ allowed', deniedBy(lspClean) === null, denialText(lspClean))
    const lspRead = call('LSP', { operation: 'hover', filePath: `${PROJECT}/lib/gen.ts`, line: 1, character: 1 })
    check('an LSP read on a marker-headed file ⇒ allowed (nothing lands)', deniedBy(lspRead) === null, denialText(lspRead))
    const godotGenerated = call('Godot', { op: 'script_create', args: { path: 'res://addons/x/core/op_classes.generated.gd', content: 'extends RefCounted\n' } })
    check('a Godot script_create onto a *.generated.gd resource path ⇒ denied by name (the res:// prefix is stripped, the path binds as given)', deniedBy(godotGenerated) === RULE && denialText(godotGenerated).includes('.generated.gd'), denialText(godotGenerated))
    const godotDir = call('Godot', { op: 'script_edit', args: { path: 'res://generated/glue.gd', content: 'extends Node\n' } })
    check('a Godot script_edit inside a generated/ resource folder ⇒ denied by name', deniedBy(godotDir) === RULE, denialText(godotDir))
    const godotMarked = call('Godot', { op: 'script_create', args: { path: 'res://addons/x/core/op_classes.gd', content: '# @generated by scripts/vulcan/regen-optable.mjs\nextends RefCounted\n' } })
    check("a Godot script_create whose content opens with a generated marker ⇒ denied (the content's own head)", deniedBy(godotMarked) === RULE && denialText(godotMarked).includes('Regenerated by: scripts/vulcan/regen-optable.mjs'), denialText(godotMarked))
    const godotPlain = call('Godot', { op: 'script_edit', args: { path: 'res://player.gd', content: 'extends Node\n' } })
    check('a Godot script_edit on an ordinary resource ⇒ allowed', deniedBy(godotPlain) === null, denialText(godotPlain))
  }

  section('H. the name rows bind the path relative to ITS repository root, never the cwd or the absolute ancestry')
  {
    const bare = (file_path: string, resolvePath?: Call['resolvePath']): Call => ({ toolName: 'Edit', input: { file_path, old_string: 'a', new_string: 'b' }, readHead: fakeReader, ...(resolvePath === undefined ? {} : { resolvePath }) })
    const nested = '/Users/x/generated/app/src/main.ts'
    check('a project living under a folder named generated/ is not refused (the ancestor is above its root)', deniedBy(bare(nested, rootedAt('/Users/x/generated/app'))) === null, denialText(bare(nested, rootedAt('/Users/x/generated/app'))))
    check('the same path with the root above generated/ ⇒ denied (then the directory is inside the project)', deniedBy(bare(nested, rootedAt('/Users/x'))) === RULE, denialText(bare(nested, rootedAt('/Users/x'))))
    const bundledProject = '/Users/x/src/skills/bundled/proj/main.ts'
    check('a project living under a folder named src/skills/bundled/<name>/ is not refused', deniedBy(bare(bundledProject, rootedAt('/Users/x/src/skills/bundled/proj'))) === null, denialText(bare(bundledProject, rootedAt('/Users/x/src/skills/bundled/proj'))))
    check('a lockfile outside the resolved root is still refused by its bare name', deniedBy(bare('/elsewhere/bun.lock', projectResolver)) === RULE, denialText(bare('/elsewhere/bun.lock', projectResolver)))
    check('a same-named bare file elsewhere passes (the directory rows need the root-relative path)', deniedBy(bare('/elsewhere/tool-census.json', projectResolver)) === null && deniedBy(bare('/elsewhere/scripts/settings/settings-schema.json', projectResolver)) === null)
    check('with no resolver supplied an absolute path binds by its bare name only', deniedBy(bare(`${PROJECT}/scripts/settings/settings-schema.json`)) === null && deniedBy(bare(`${PROJECT}/bun.lock`)) === RULE, denialText(bare(`${PROJECT}/scripts/settings/settings-schema.json`)))
    check('a repository-relative path binds as itself', deniedBy(bare('design-system/live/manifest.json')) === RULE && deniedBy(bare('src/generated/api.ts')) === RULE, denialText(bare('design-system/live/manifest.json')))
    check('a ./ spelling is normalised before binding', deniedBy(bare('./scripts/settings/settings-schema.json')) === RULE && deniedBy(bare('./src/generated/api.ts')) === RULE, denialText(bare('./scripts/settings/settings-schema.json')))
    check('a .. spelling is normalised before binding (no resolver)', deniedBy(bare(`${PROJECT}/src/../scripts/settings/settings-schema.json`, projectResolver)) === RULE && deniedBy(bare('src/../scripts/settings/settings-schema.json')) === RULE, denialText(bare(`${PROJECT}/src/../scripts/settings/settings-schema.json`, projectResolver)))
    const seen: string[] = []
    const spy = (path: string): Resolved => { seen.push(path); return projectResolver(path) }
    verdictOf(bare(`${PROJECT}/src/skills/../skills/bundled/app-proof/SKILL.md`, spy))
    check('the resolver receives the normalised path (the engine collapses . and .. before asking)', seen[0] === `${PROJECT}/src/skills/bundled/app-proof/SKILL.md`, JSON.stringify(seen))
    const moved = rootedAt(PROJECT)
    const rootedAtSubdir = (path: string): Resolved => ({ path, root: `${PROJECT}/scripts` })
    check('the root the resolver answers is what binds, not any cwd: a per-path root at the repository denies, a subdirectory root would not', deniedBy(bare(`${PROJECT}/scripts/builtin-tools/fixtures/tool-census.json`, moved)) === RULE && deniedBy(bare(`${PROJECT}/scripts/builtin-tools/fixtures/tool-census.json`, rootedAtSubdir)) === null)
  }

  section('I. the registry ratchet — every asset in the generated-assets map is refused with its generator named')
  {
    const mapText = readFileSync(join(ROOT, GENERATED_ASSETS_MAP), 'utf8')
    const { rows, errors } = parseGeneratedAssetsMap(mapText)
    check('the map parses', errors.length === 0 && rows.length > 0, errors.join('; '))
    const listTree = (): string[] => {
      const out: string[] = []
      const walk = (dir: string): void => {
        for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
          if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue
          const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
          if (entry.isDirectory()) walk(rel)
          else if (entry.isFile()) out.push(rel)
        }
      }
      walk('')
      return out
    }
    let tracked: string[]
    try {
      tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').split('\0').filter(Boolean)
    } catch {
      tracked = listTree()
      console.log(`  · not a git checkout: ${tracked.length} files listed by walking the tree`)
    }
    const partial = new Set(['assets/splash/splash-core.mjs', 'docs/EXTENSIONS.md'])
    const matches = (rel: string, asset: string): boolean => (/[*?{]/.test(asset) ? new Bun.Glob(asset).match(rel) : rel === asset)
    const scriptsFor = (rel: string): Set<string> => {
      const out = new Set<string>()
      for (const row of rows) if (row.assets.some(a => matches(rel, a))) for (const part of row.generator.split('&&')) { const s = scriptOf(part); if (s !== null) out.add(s) }
      return out
    }
    const realResolver = typeof hook.makeTargetResolver === 'function' ? hook.makeTargetResolver(ROOT) : rootedAt(ROOT)
    let assetsSeen = 0
    for (const row of rows) {
      for (const asset of row.assets) {
        const files = tracked.filter(rel => matches(rel, asset))
        check(`row ${row.line} asset ${asset} names ${files.length} tracked file(s)`, files.length > 0)
        for (const rel of files) {
          assetsSeen++
          const call = edit(join(ROOT, rel), 'const changed = 2', realReader, realResolver)
          const v = verdictOf(call)
          if (partial.has(rel)) {
            check(`${rel} is hand-written with a baked region ⇒ allowed by design`, v.allow, v.allow ? '' : buildWardDenial(v, 'Edit'))
            continue
          }
          if (asset === 'src/skills/bundled/**' && !rel.slice('src/skills/bundled/'.length).includes('/') && !/AUTO-GENERATED/.test(realReader(join(ROOT, rel)) ?? '')) {
            check(`${rel} is a hand-written top-level file under the bundled glob ⇒ allowed`, v.allow, v.allow ? '' : buildWardDenial(v, 'Edit'))
            continue
          }
          const expected = scriptsFor(rel)
          const named = v.allow ? '' : (v.generator ?? '')
          const namedScript = scriptOf(named) ?? named
          check(`${rel} ⇒ denied naming ${[...expected].join(' or ')}`, !v.allow && expected.has(namedScript), v.allow ? 'ALLOWED' : buildWardDenial(v, 'Edit'))
        }
      }
    }
    console.log(`  · ${assetsSeen} tracked asset file(s) across ${rows.length} rows`)
    const survey: string[] = []
    for (const rel of tracked) {
      if (/\.(?:png|jpe?g|gif|webp|ico|icns|wav|mp3|mp4|mov|woff2?|ttf|otf|node|wasm|zip|gz|tgz|cast|pdf|dylib|so|dll|exe|lockb)$/i.test(rel)) continue
      const v = verdictOf(edit(join(ROOT, rel), 'const changed = 2', realReader, realResolver))
      if (!v.allow && rows.every(row => !row.assets.some(a => matches(rel, a)))) survey.push(`${rel} (${v.excerpt}${v.generator ? ` → ${v.generator}` : ''})`)
    }
    console.log(`  · refused beyond the map (marker or name): ${survey.length}\n    ${survey.join('\n    ')}`)
    for (const rel of ['src/constants/cyberRiskInstruction.ts', 'src/skills/bundled/updateConfig.ts', 'scripts/gate/generated-assets.tsv', 'src/utils/wards/wards.ts', 'scripts/wards/prove-wards.ts', 'MERCURY.md']) {
      const v = verdictOf(edit(join(ROOT, rel), 'const changed = 2', realReader, realResolver))
      check(`${rel} (hand-written) ⇒ allowed with its real head`, v.allow, v.allow ? '' : buildWardDenial(v, 'Edit'))
    }
  }

  section('J. the head reader reads regular files only and never blocks; the resolver finds the enclosing repository')
  {
    const reader = typeof hook.readTargetHead === 'function' ? hook.readTargetHead : null
    check('the hook exports the bounded head reader', reader !== null)
    const scratch = mkdtempSync(join(tmpdir(), 'wards-head-'))
    if (reader !== null) {
      const regular = join(scratch, 'regular.ts')
      writeFileSync(regular, '// @generated\nexport const a = 1\n')
      check('a regular file answers its head', reader(regular) === '// @generated\nexport const a = 1\n')
      check('a missing file answers undefined', reader(join(scratch, 'missing.ts')) === undefined)
      check('a directory answers undefined', reader(scratch) === undefined)
      const fifo = join(scratch, 'pipe')
      execFileSync('mkfifo', [fifo])
      const t0 = performance.now()
      const fifoHead = reader(fifo)
      const ms = performance.now() - t0
      check(`a FIFO with no writer answers undefined without blocking (${ms.toFixed(1)}ms)`, fifoHead === undefined && ms < 100)
      check('a character device answers undefined', reader('/dev/null') === undefined)
    }
    const resolver = typeof hook.makeTargetResolver === 'function' ? hook.makeTargetResolver : null
    check('the hook exports the target resolver factory', resolver !== null)
    if (resolver !== null) {
      const repo = join(scratch, 'repo')
      mkdirSync(join(repo, 'src', 'generated'), { recursive: true })
      mkdirSync(join(repo, '.git'))
      writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1\n')
      const worktree = join(scratch, 'worktree')
      mkdirSync(join(worktree, 'scripts', 'settings'), { recursive: true })
      writeFileSync(join(worktree, '.git'), `gitdir: ${repo}/.git/worktrees/w\n`)
      writeFileSync(join(worktree, 'scripts', 'settings', 'settings-schema.json'), '{}\n')
      const link = join(scratch, 'link')
      symlinkSync(repo, link)
      const resolve = resolver(scratch)
      const real = (p: string): string => hook.realTargetPath(p)
      check('a file inside a repository resolves to its own root (a .git directory)', resolve(join(repo, 'src', 'a.ts')).root === real(repo), JSON.stringify(resolve(join(repo, 'src', 'a.ts'))))
      check('a worktree resolves to its own root (a .git FILE)', resolve(join(worktree, 'scripts', 'settings', 'settings-schema.json')).root === real(worktree), JSON.stringify(resolve(join(worktree, 'scripts', 'settings', 'settings-schema.json'))))
      check('a file that does not exist yet resolves under its existing ancestors', resolve(join(repo, 'src', 'generated', 'new.ts')).path === join(real(repo), 'src', 'generated', 'new.ts') && resolve(join(repo, 'src', 'generated', 'new.ts')).root === real(repo), JSON.stringify(resolve(join(repo, 'src', 'generated', 'new.ts'))))
      check('a symlink spelling resolves to the physical path and root', resolve(join(link, 'src', 'a.ts')).path === join(real(repo), 'src', 'a.ts') && resolve(join(link, 'src', 'a.ts')).root === real(repo), JSON.stringify(resolve(join(link, 'src', 'a.ts'))))
      check('a .. spelling resolves to the physical path', resolve(join(repo, 'src', '..', 'src', 'a.ts')).path === join(real(repo), 'src', 'a.ts'), JSON.stringify(resolve(join(repo, 'src', '..', 'src', 'a.ts'))))
      const outside = join(scratch, 'loose', 'x.ts')
      check('a path under no repository falls back to the session root given at registration', resolve(outside).root === real(scratch), JSON.stringify(resolve(outside)))
      const relative = runWithCwdOverride(join(repo, 'src'), () => resolve('./a.ts'))
      check('a relative spelling resolves against the live cwd, then binds to the repository root', relative.path === join(real(repo), 'src', 'a.ts') && relative.root === real(repo), JSON.stringify(relative))
      const deep = join(repo, 'src', 'a/'.repeat(40_000) + 'x.ts')
      const t0 = performance.now()
      const deepResolved = resolve(deep)
      const deepMs = performance.now() - t0
      check(`a 40 000-segment path (${deep.length} chars, over PATH_MAX) resolves in ${deepMs.toFixed(1)}ms (< 5ms): the walks are skipped and the fallback root answers`, deepMs < 5 && deepResolved.root === real(scratch), JSON.stringify(deepResolved).slice(0, 120))
      const huge = join(repo, 'src', 'a/'.repeat(80_000) + 'x.ts')
      const t1 = performance.now()
      resolve(huge)
      const hugeMs = performance.now() - t1
      check(`a 160 KB path resolves in ${hugeMs.toFixed(1)}ms (< 5ms)`, hugeMs < 5)
      const underMax = join(repo, 'src', 'a/'.repeat(1_900) + 'x.ts')
      const t2 = performance.now()
      const underResolved = resolve(underMax)
      const underMs = performance.now() - t2
      check(`a ${underMax.length}-char path under PATH_MAX still resolves to its repository in ${underMs.toFixed(1)}ms (< 50ms)`, underMs < 50 && underResolved.root === real(repo), JSON.stringify(underResolved).slice(0, 120))
      const gitFile = join(repo, 'src', 'generated', 'new.ts')
      check('the .git walk starts at the deepest EXISTING ancestor, so a planted .git deeper than any existing directory cannot be reached', resolve(gitFile).root === real(repo))
      check('the resolver factory realpaths its fallback once and answers it for a path over PATH_MAX', resolve('/' + 'b/'.repeat(3_000) + 'y.ts').root === real(scratch))
    }
    rmSync(scratch, { recursive: true, force: true })
  }

  section('K. the armed hook road — the head reader and the per-path resolver are wired; a moved cwd, a link spelling and a .. member cannot re-open the table')
  {
    type AnyState = { sessionHooks: Map<string, unknown> } & Record<string, unknown>
    let state: AnyState = { sessionHooks: new Map() }
    const setAppState = ((updater: (prev: AnyState) => AnyState) => {
      state = updater(state)
    }) as never
    const scratch = mkdtempSync(join(tmpdir(), 'wards-hook-'))
    const link = join(scratch, 'link')
    symlinkSync(ROOT, link)
    const realRoot = typeof hook.realTargetPath === 'function' ? hook.realTargetPath(ROOT) : ROOT
    const ctx = (toolName: string, input: Record<string, unknown>) => ({ hookInput: { tool_name: toolName, tool_input: input }, tool: { name: toolName } })
    const fresh = async (cwd: string, toolName: string, input: Record<string, unknown>, id: string): Promise<unknown> => {
      resetWardsEngagedSessionsForTest()
      runWithCwdOverride(cwd, () => registerWardsHook(setAppState, id))
      const matchers = getSessionFunctionHooks({ sessionHooks: state.sessionHooks } as never, id, 'PreToolUse').get('PreToolUse' as never) ?? []
      const cb = matchers.flatMap((m: { hooks: Array<{ callback: (mm: never[], s?: never, c?: unknown) => unknown }> }) => m.hooks)[0]!.callback
      return runWithCwdOverride(cwd, () => cb([], undefined as never, ctx(toolName, input)))
    }
    const census = join(ROOT, 'scripts', 'builtin-tools', 'fixtures', 'tool-census.json')
    const schema = join(ROOT, 'scripts', 'settings', 'settings-schema.json')
    const marked = await fresh(ROOT, 'Edit', { file_path: join(ROOT, 'src', 'skills', 'bundled', 'app-proof.ts'), old_string: 'a', new_string: 'b' }, 'w-g1')
    check('the hook denies an Edit to a real marker-headed file in the worktree, naming its generator', typeof marked === 'string' && marked.includes(`Ward '${RULE}'`) && marked.includes('Regenerated by: scripts/skills/gen-bundled.ts'), String(marked).slice(0, 240))
    const named = await fresh(ROOT, 'Write', { file_path: schema, content: '{}\n' }, 'w-g2')
    check('the hook denies a Write over a registered asset by name, with the gate and its check', typeof named === 'string' && named.includes('Regenerated by: bun scripts/settings/gen-settings-schema.ts') && named.includes(`${GATE}; its check: bun scripts/settings/prove-settings-schema.ts.`), String(named).slice(0, 300))
    for (const sub of ['scripts', 'src', join('scripts', 'builtin-tools'), join('src', 'skills'), 'assets']) {
      const moved = await fresh(join(ROOT, sub), 'Edit', { file_path: census, old_string: 'a', new_string: 'b' }, `w-g3-${sub.replace(/\W/g, '-')}`)
      check(`with the cwd moved to <W>/${sub}, the census fixture is still denied by name (the root is the file's repository, not the cwd)`, typeof moved === 'string' && moved.includes('Regenerated by: bun scripts/builtin-tools/census-gen.ts'), String(moved).slice(0, 200))
    }
    const movedSchema = await fresh(join(ROOT, 'src'), 'Write', { file_path: schema, content: '{}\n' }, 'w-g4')
    check('with the cwd moved to <W>/src, settings-schema.json is still denied by name', typeof movedSchema === 'string' && movedSchema.includes('Regenerated by: bun scripts/settings/gen-settings-schema.ts'), String(movedSchema).slice(0, 200))
    const viaLink = await fresh(ROOT, 'Edit', { file_path: join(link, 'scripts', 'settings', 'settings-schema.json'), old_string: 'a', new_string: 'b' }, 'w-g5')
    check('an Edit through a symlinked spelling of the worktree is denied by name (the target is realpathed)', typeof viaLink === 'string' && viaLink.includes('Regenerated by: bun scripts/settings/gen-settings-schema.ts'), String(viaLink).slice(0, 200))
    const linkCwd = await fresh(link, 'Edit', { file_path: join(realRoot, 'scripts', 'builtin-tools', 'fixtures', 'tool-census.json'), old_string: 'a', new_string: 'b' }, 'w-g6')
    check('with the cwd at the link and the physical path given, the census fixture is denied', typeof linkCwd === 'string' && linkCwd.includes('Regenerated by: bun scripts/builtin-tools/census-gen.ts'), String(linkCwd).slice(0, 200))
    const member = (file_path: string) => ({ file_path, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '1', replace: 'x' }] })
    const dotDot = await fresh(ROOT, 'ChangeSet', { op: 'apply', changes: [member(join(ROOT, 'src', '..', 'scripts', 'settings', 'settings-schema.json'))] }, 'w-g7')
    check('a ChangeSet member spelled with .. is denied by name', typeof dotDot === 'string' && dotDot.includes('Regenerated by: bun scripts/settings/gen-settings-schema.ts'), String(dotDot).slice(0, 200))
    const dotSlash = await fresh(ROOT, 'ChangeSet', { op: 'apply', changes: [member('./scripts/settings/settings-schema.json')] }, 'w-g8')
    check('a ChangeSet member spelled with ./ is denied by name', typeof dotSlash === 'string' && dotSlash.includes('Regenerated by: bun scripts/settings/gen-settings-schema.ts'), String(dotSlash).slice(0, 200))
    const dotSlashMoved = await fresh(join(ROOT, 'scripts'), 'ChangeSet', { op: 'apply', changes: [member('./settings/settings-schema.json')] }, 'w-g9')
    check('a relative ChangeSet member resolves against the moved cwd and is still denied by name', typeof dotSlashMoved === 'string' && dotSlashMoved.includes('Regenerated by: bun scripts/settings/gen-settings-schema.ts'), String(dotSlashMoved).slice(0, 200))
    const bundledDotDot = await fresh(ROOT, 'ChangeSet', { op: 'apply', changes: [member(join(ROOT, 'src', 'skills', '..', 'skills', 'bundled', 'app-proof', 'SKILL.md'))] }, 'w-g10')
    check('a ChangeSet member reaching a bundled skill file through .. is denied by name', typeof bundledDotDot === 'string' && bundledDotDot.includes('Regenerated by: bun scripts/skills/gen-bundled.ts'), String(bundledDotDot).slice(0, 200))
    const astDotDot = await fresh(ROOT, 'AstEdit', { pattern: 'a', rewrite: 'b', path: join(ROOT, 'src', '..', 'src', 'skills', 'bundled', 'app-proof') }, 'w-g11')
    check('an AstEdit path reaching a bundled skill folder through .. is denied by name', typeof astDotDot === 'string' && astDotDot.includes('Regenerated by: bun scripts/skills/gen-bundled.ts'), String(astDotDot).slice(0, 200))
    const changeSet = await fresh(ROOT, 'ChangeSet', { op: 'apply', changes: [member(join(ROOT, 'src', 'skills', 'bundled', 'app-proof.ts'))] }, 'w-g12')
    check('the hook denies a ChangeSet on a real marker-headed file', typeof changeSet === 'string' && changeSet.includes(`Ward '${RULE}'`), String(changeSet).slice(0, 240))
    const gitLock = await fresh(join(ROOT, 'src'), 'Git', { op: 'resolve', path: 'bun.lock', content: '{}\n' }, 'w-g13')
    check('the hook denies a Git resolve that hand-writes bun.lock, whatever the cwd', typeof gitLock === 'string' && gitLock.includes('Regenerated by: its package manager (bun), from package.json'), String(gitLock).slice(0, 200))
    const lsp = await fresh(ROOT, 'LSP', { operation: 'organizeImports', filePath: join(ROOT, 'src', 'skills', 'bundled', 'app-proof.ts'), apply: true, plan: 'lsp-1' }, 'w-g14')
    check('the hook denies an LSP apply on a real marker-headed file', typeof lsp === 'string' && lsp.includes(`Ward '${RULE}'`), String(lsp).slice(0, 240))
    const ordinary = await fresh(ROOT, 'Edit', { file_path: join(ROOT, 'src', 'utils', 'wards', 'wards.ts'), old_string: 'a', new_string: 'b' }, 'w-g15')
    check('the hook passes an Edit to an ordinary file', ordinary === true, JSON.stringify(ordinary))
    const ordinaryMoved = await fresh(join(ROOT, 'scripts'), 'Edit', { file_path: join(ROOT, 'src', 'utils', 'wards', 'wards.ts'), old_string: 'a', new_string: 'b' }, 'w-g16')
    check('the hook passes an Edit to an ordinary file with the cwd moved', ordinaryMoved === true, JSON.stringify(ordinaryMoved))
    const missing = await fresh(ROOT, 'Write', { file_path: join(ROOT, 'src', 'utils', 'wards', 'never-written.ts'), content: 'export const a = 1\n' }, 'w-g17')
    check('the hook passes a Write creating an ordinary file that does not exist yet', missing === true, JSON.stringify(missing))
    const project = join(scratch, 'generated', 'app')
    mkdirSync(join(project, 'src'), { recursive: true })
    mkdirSync(join(project, '.git'))
    writeFileSync(join(project, 'src', 'main.ts'), 'export const main = 1\n')
    const elsewhere = await fresh(project, 'Edit', { file_path: join(project, 'src', 'main.ts'), old_string: 'a', new_string: 'b' }, 'w-g18')
    check('a project under a folder named generated/ passes (its own .git is the root)', elsewhere === true, JSON.stringify(elsewhere))
    const elsewhereGenerated = await fresh(project, 'Write', { file_path: join(project, 'src', 'generated', 'x.ts'), content: 'x' }, 'w-g19')
    check("that project's own src/generated/ is still refused", typeof elsewhereGenerated === 'string' && elsewhereGenerated.includes(`Ward '${RULE}'`), String(elsewhereGenerated).slice(0, 200))
    const timed = async (label: string, toolName: string, input: Record<string, unknown>, id: string): Promise<void> => {
      const armed = performance.now()
      let fired = -1
      const timer = new Promise<void>(resolve => setTimeout(() => { fired = performance.now() - armed; resolve() }, 100))
      const t0 = performance.now()
      const result = await fresh(ROOT, toolName, input, id)
      const ms = performance.now() - t0
      await timer
      check(`${label}: the hook answers in ${ms.toFixed(1)}ms (< 50ms) and passes (fail open: the OS refuses the path); the 100ms timer armed first fired at ${fired.toFixed(0)}ms (< 1000ms)`, result === true && ms < 50 && fired < 1000, JSON.stringify(result).slice(0, 120))
    }
    await timed('a Write whose path has 40 000 segments (80 KB)', 'Write', { file_path: join(ROOT, 'src', 'a/'.repeat(40_000) + 'x.ts'), content: 'export const a = 1\n' }, 'w-g20')
    await timed('a Write whose path is 160 KB', 'Write', { file_path: join(ROOT, 'src', 'a/'.repeat(80_000) + 'x.ts'), content: 'export const a = 1\n' }, 'w-g21')
    await timed('a Git resolve whose absolute path has 40 000 segments', 'Git', { op: 'resolve', path: join(ROOT, 'a/'.repeat(40_000) + 'x.ts'), content: 'x\n' }, 'w-g22')
    await timed('a ChangeSet member whose path has 40 000 segments', 'ChangeSet', { op: 'apply', changes: [member(join(ROOT, 'src', 'a/'.repeat(40_000) + 'x.ts'))] }, 'w-g23')
    resetWardsEngagedSessionsForTest()
    rmSync(scratch, { recursive: true, force: true })
  }

  section('L. the rule set stays data')
  {
    check('BUILTIN_WARDS survives a JSON round-trip unchanged', JSON.stringify(JSON.parse(JSON.stringify(BUILTIN_WARDS))) === JSON.stringify(BUILTIN_WARDS))
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ GENERATED-FILE GUARD PROOF PASSES')
  process.exit(0)
}

void main()
