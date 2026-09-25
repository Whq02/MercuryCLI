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
  const { mkdtempSync, openSync, readSync, closeSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { execFileSync } = await import('node:child_process')
  process.env.MERCURY_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), 'wards-generated-home-'))
  const { BUILTIN_WARDS, evaluateWards, buildWardDenial } = await import('../../src/utils/wards/wards.js')
  const { registerWardsHook, resetWardsEngagedSessionsForTest, readTargetHead } = await import('../../src/utils/hooks/wardsHook.js')
  const { getSessionFunctionHooks } = await import('../../src/utils/hooks/sessionHooks.js')
  const { parseGeneratedAssetsMap, GENERATED_ASSETS_MAP } = await import('../../src/utils/hooks/generatedAssets.js')
  const { runWithCwdOverride } = await import('../../src/utils/cwd.js')

  const ROOT = join(import.meta.dir, '..', '..')
  type Call = { toolName: string; input: Record<string, unknown>; projectRoot?: string; readHead?: (path: string) => string | undefined }
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
  const edit = (file_path: string, new_string = 'const changed = 2', readHead: Call['readHead'] = fakeReader, projectRoot = PROJECT): Call => ({
    toolName: 'Edit',
    input: { file_path, old_string: 'const before = 1', new_string },
    projectRoot,
    readHead,
  })
  const write = (file_path: string, content: string, readHead: Call['readHead'] = fakeReader, projectRoot = PROJECT): Call => ({ toolName: 'Write', input: { file_path, content }, projectRoot, readHead })
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
    check('a marker denial names no commit gate (the gate is this repository\'s, known only for its map rows)', !denialText(edit(`${PROJECT}/lib/schema.ts`)).includes(GATE), denialText(edit(`${PROJECT}/lib/schema.ts`)))
    const deep = `${PROJECT}/lib/deep.ts`
    heads.set(deep, Array(12).fill('const a = 1').join('\n') + '\n// @generated\n')
    check('a marker past the first 12 lines is not a leading marker ⇒ allowed (the head read is bounded)', deniedBy(edit(deep)) === null, denialText(edit(deep)))
    const twelfth = `${PROJECT}/lib/twelfth.ts`
    heads.set(twelfth, Array(11).fill('const a = 1').join('\n') + '\n// @generated\n')
    check('a marker on line 12 ⇒ denied (the bound is inclusive)', deniedBy(edit(twelfth)) === RULE, denialText(edit(twelfth)))
    const noReader: Call = { toolName: 'Edit', input: { file_path: `${PROJECT}/lib/schema.ts`, old_string: 'a', new_string: 'b' }, projectRoot: PROJECT }
    check('with no head reader supplied the marker road stays quiet (the name road still applies)', deniedBy(noReader) === null, denialText(noReader))
    const v = verdictOf(edit(`${PROJECT}/api/api.pb.go`))
    check('a marker denial quotes the marker and its head line', v.allow === false && v.excerpt === 'Code generated by' && v.line === 1, JSON.stringify(v))
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
    const hunks: Call = { toolName: 'Edit', input: { file_path: `${PROJECT}/lib/gen.ts`, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '2', replace: '' }] }, projectRoot: PROJECT, readHead: fakeReader }
    check('a hunks edit with empty bodies on a marked file ⇒ denied', deniedBy(hunks) === RULE, denialText(hunks))
    const append: Call = { toolName: 'Edit', input: { file_path: `${PROJECT}/lib/gen.ts`, append: 'export const b = 2' }, projectRoot: PROJECT, readHead: fakeReader }
    check('an append on a marked file ⇒ denied', deniedBy(append) === RULE, denialText(append))
    const emptyOrdinary = edit(`${PROJECT}/src/app.ts`, '')
    check('an empty edit of an ordinary file stays allowed', deniedBy(emptyOrdinary) === null, denialText(emptyOrdinary))
  }

  section('G. the other roads that land bytes — ChangeSet members, the patch dialect, AstEdit')
  {
    const member = (file_path: string) => ({ file_path, expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '2', replace: 'const changed = 2' }] })
    const marked: Call = { toolName: 'ChangeSet', input: { op: 'apply', changes: [member(`${PROJECT}/src/app.ts`), member(`${PROJECT}/lib/gen.ts`)] }, projectRoot: PROJECT, readHead: fakeReader }
    const markedVerdict = verdictOf(marked)
    check('a ChangeSet whose second member is a marker-headed file ⇒ denied, on that member', deniedBy(marked) === RULE && !markedVerdict.allow && markedVerdict.target === `${PROJECT}/lib/gen.ts`, denialText(marked))
    const named: Call = { toolName: 'ChangeSet', input: { op: 'preview', changes: [member(`${PROJECT}/scripts/settings/settings-schema.json`)] }, projectRoot: PROJECT, readHead: fakeReader }
    check('a ChangeSet preview on a registered asset ⇒ denied by name', deniedBy(named) === RULE && denialText(named).includes('Regenerated by: bun scripts/settings/gen-settings-schema.ts'), denialText(named))
    const clean: Call = { toolName: 'ChangeSet', input: { op: 'apply', changes: [member(`${PROJECT}/src/app.ts`)] }, projectRoot: PROJECT, readHead: fakeReader }
    check('a ChangeSet on ordinary files ⇒ allowed', deniedBy(clean) === null, denialText(clean))
    const patch: Call = { toolName: 'ChangeSet', input: { op: 'preview', patch: `file ${PROJECT}/src/app.ts fa:0123456789ab\nreplace 2\n| const a = 2\nfile ${PROJECT}/lib/gen.ts fa:0123456789ab\ndelete 2\n` }, projectRoot: PROJECT, readHead: fakeReader }
    const patchVerdict = verdictOf(patch)
    check('a patch-dialect section on a marker-headed file (a bodiless delete) ⇒ denied, on that section', deniedBy(patch) === RULE && !patchVerdict.allow && patchVerdict.target === `${PROJECT}/lib/gen.ts`, denialText(patch))
    const astFile: Call = { toolName: 'AstEdit', input: { pattern: 'a', rewrite: 'b', path: `${PROJECT}/lib/gen.ts` }, projectRoot: PROJECT, readHead: fakeReader }
    check('an AstEdit whose path is a marker-headed file ⇒ denied', deniedBy(astFile) === RULE, denialText(astFile))
    const astDir: Call = { toolName: 'AstEdit', input: { pattern: 'a', rewrite: 'b', path: `${PROJECT}/src/generated` }, projectRoot: PROJECT, readHead: fakeReader }
    check('an AstEdit whose path is a generated/ directory ⇒ denied by name', deniedBy(astDir) === RULE, denialText(astDir))
    const astPlain: Call = { toolName: 'AstEdit', input: { pattern: 'a', rewrite: 'b', path: `${PROJECT}/src` }, projectRoot: PROJECT, readHead: fakeReader }
    check('an AstEdit over an ordinary directory ⇒ allowed (the files it touches are chosen after the ward)', deniedBy(astPlain) === null, denialText(astPlain))
  }

  section('H. the name rows bind the project-relative path, never the absolute ancestry')
  {
    const nested = '/Users/x/generated/app/src/main.ts'
    check('a project living under a folder named generated/ is not refused (the ancestor is above the root)', deniedBy(edit(nested, 'const changed = 2', fakeReader, '/Users/x/generated/app')) === null, denialText(edit(nested, 'const changed = 2', fakeReader, '/Users/x/generated/app')))
    check('the same path with the root above generated/ ⇒ denied (then the directory is inside the project)', deniedBy(edit(nested, 'const changed = 2', fakeReader, '/Users/x')) === RULE, denialText(edit(nested, 'const changed = 2', fakeReader, '/Users/x')))
    const bundledProject = '/Users/x/src/skills/bundled/proj/main.ts'
    check("a project living under a folder named src/skills/bundled/<name>/ is not refused", deniedBy(edit(bundledProject, 'const changed = 2', fakeReader, '/Users/x/src/skills/bundled/proj')) === null, denialText(edit(bundledProject, 'const changed = 2', fakeReader, '/Users/x/src/skills/bundled/proj')))
    check('a lockfile outside the project root is still refused by its bare name', deniedBy(edit('/elsewhere/bun.lock', 'const changed = 2', fakeReader, PROJECT)) === RULE, denialText(edit('/elsewhere/bun.lock', 'const changed = 2', fakeReader, PROJECT)))
    check('a same-named bare file elsewhere passes (the directory rows need the project-relative path)', deniedBy(edit('/elsewhere/tool-census.json', 'const changed = 2', fakeReader, PROJECT)) === null && deniedBy(edit('/elsewhere/scripts/settings/settings-schema.json', 'const changed = 2', fakeReader, PROJECT)) === null)
    const bare = (file_path: string): Call => ({ toolName: 'Edit', input: { file_path, old_string: 'a', new_string: 'b' }, readHead: fakeReader })
    check('with no project root supplied an absolute path binds by its bare name only', deniedBy(bare(`${PROJECT}/scripts/settings/settings-schema.json`)) === null && deniedBy(bare(`${PROJECT}/bun.lock`)) === RULE, denialText(bare(`${PROJECT}/scripts/settings/settings-schema.json`)))
    check('a repository-relative path binds as itself', deniedBy(bare('design-system/live/manifest.json')) === RULE && deniedBy(bare('src/generated/api.ts')) === RULE, denialText(bare('design-system/live/manifest.json')))
  }

  section('I. the registry ratchet — every asset in the generated-assets map is refused with its generator named')
  {
    const mapText = readFileSync(join(ROOT, GENERATED_ASSETS_MAP), 'utf8')
    const { rows, errors } = parseGeneratedAssetsMap(mapText)
    check('the map parses', errors.length === 0 && rows.length > 0, errors.join('; '))
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 1 << 28 }).toString('utf8').split('\0').filter(Boolean)
    const partial = new Set(['assets/splash/splash-core.mjs', 'docs/EXTENSIONS.md'])
    const matches = (rel: string, asset: string): boolean => (/[*?{]/.test(asset) ? new Bun.Glob(asset).match(rel) : rel === asset)
    const scriptsFor = (rel: string): Set<string> => {
      const out = new Set<string>()
      for (const row of rows) if (row.assets.some(a => matches(rel, a))) for (const part of row.generator.split('&&')) { const s = scriptOf(part); if (s !== null) out.add(s) }
      return out
    }
    let assetsSeen = 0
    for (const row of rows) {
      for (const asset of row.assets) {
        const files = tracked.filter(rel => matches(rel, asset))
        check(`row ${row.line} asset ${asset} names ${files.length} tracked file(s)`, files.length > 0)
        for (const rel of files) {
          assetsSeen++
          const call = edit(join(ROOT, rel), 'const changed = 2', realReader, ROOT)
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
      const v = verdictOf(edit(join(ROOT, rel), 'const changed = 2', realReader, ROOT))
      if (!v.allow && rows.every(row => !row.assets.some(a => matches(rel, a)))) survey.push(`${rel} (${v.excerpt}${v.generator ? ` → ${v.generator}` : ''})`)
    }
    console.log(`  · refused beyond the map (marker or name): ${survey.length}\n    ${survey.join('\n    ')}`)
    for (const rel of ['src/constants/cyberRiskInstruction.ts', 'src/skills/bundled/updateConfig.ts', 'scripts/gate/generated-assets.tsv', 'src/utils/wards/wards.ts', 'scripts/wards/prove-wards.ts', 'MERCURY.md']) {
      const v = verdictOf(edit(join(ROOT, rel), 'const changed = 2', realReader, ROOT))
      check(`${rel} (hand-written) ⇒ allowed with its real head`, v.allow, v.allow ? '' : buildWardDenial(v, 'Edit'))
    }
  }

  section('J. the head reader reads regular files only and never blocks')
  {
    const reader = typeof readTargetHead === 'function' ? readTargetHead : null
    check('the hook exports the bounded head reader', reader !== null)
    if (reader !== null) {
      const scratch = mkdtempSync(join(tmpdir(), 'wards-head-'))
      const regular = join(scratch, 'regular.ts')
      await Bun.write(regular, '// @generated\nexport const a = 1\n')
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
      rmSync(scratch, { recursive: true, force: true })
    }
  }

  section('K. the armed hook road — the injected head reader and project root are wired')
  {
    type AnyState = { sessionHooks: Map<string, unknown> } & Record<string, unknown>
    let state: AnyState = { sessionHooks: new Map() }
    const setAppState = ((updater: (prev: AnyState) => AnyState) => {
      state = updater(state)
    }) as never
    resetWardsEngagedSessionsForTest()
    runWithCwdOverride(ROOT, () => registerWardsHook(setAppState, 'w-generated'))
    const matchers = getSessionFunctionHooks({ sessionHooks: state.sessionHooks } as never, 'w-generated', 'PreToolUse').get('PreToolUse' as never) ?? []
    const cb = matchers.flatMap((m: { hooks: Array<{ callback: (mm: never[], s?: never, c?: unknown) => unknown }> }) => m.hooks)[0]!.callback
    const ctx = (toolName: string, input: Record<string, unknown>) => ({ hookInput: { tool_name: toolName, tool_input: input }, tool: { name: toolName } })
    const run = (toolName: string, input: Record<string, unknown>) => runWithCwdOverride(ROOT, () => cb([], undefined as never, ctx(toolName, input)))
    const marked = await run('Edit', { file_path: join(ROOT, 'src', 'skills', 'bundled', 'app-proof.ts'), old_string: 'a', new_string: 'b' })
    check('the hook denies an Edit to a real marker-headed file in the worktree, naming its generator', typeof marked === 'string' && marked.includes(`Ward '${RULE}'`) && marked.includes('Regenerated by: scripts/skills/gen-bundled.ts'), String(marked).slice(0, 240))
    const named = await run('Write', { file_path: join(ROOT, 'scripts', 'settings', 'settings-schema.json'), content: '{}\n' })
    check('the hook denies a Write over a registered asset by name, with the gate and its check', typeof named === 'string' && named.includes('Regenerated by: bun scripts/settings/gen-settings-schema.ts') && named.includes(`${GATE}; its check: bun scripts/settings/prove-settings-schema.ts.`), String(named).slice(0, 300))
    const changeSet = await run('ChangeSet', { op: 'apply', changes: [{ file_path: join(ROOT, 'src', 'skills', 'bundled', 'app-proof.ts'), expected_anchor: 'fa:0123456789ab', hunks: [{ lines: '2', replace: 'x' }] }] })
    check('the hook denies a ChangeSet on a real marker-headed file', typeof changeSet === 'string' && changeSet.includes(`Ward '${RULE}'`), String(changeSet).slice(0, 240))
    const ordinary = await run('Edit', { file_path: join(ROOT, 'src', 'utils', 'wards', 'wards.ts'), old_string: 'a', new_string: 'b' })
    check('the hook passes an Edit to an ordinary file', ordinary === true, JSON.stringify(ordinary))
    const missing = await run('Write', { file_path: join(ROOT, 'src', 'utils', 'wards', 'never-written.ts'), content: 'export const a = 1\n' })
    check('the hook passes a Write creating an ordinary file that does not exist yet', missing === true, JSON.stringify(missing))
    const elsewhere = await runWithCwdOverride('/Users/x/generated/app', () => cb([], undefined as never, ctx('Edit', { file_path: '/Users/x/generated/app/src/main.ts', old_string: 'a', new_string: 'b' })))
    check('the hook binds the name rows to the session cwd (a project under a generated/ folder passes)', elsewhere === true, JSON.stringify(elsewhere))
    resetWardsEngagedSessionsForTest()
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
