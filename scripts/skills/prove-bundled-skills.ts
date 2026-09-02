#!/usr/bin/env bun
// ============================================================================
//  prove-bundled-skills — the skills compiled from mercury-skills/ register,
//  carry real content, never double-register, and extract in isolation.
//
//   §1 REGISTERED: every skill under mercury-skills/ is registered by name
//      with a non-empty description and a working getPromptForCommand.
//   §2 CONTENT: a body renders with its frontmatter stripped; reference files
//      ride in `files`; an embedded (.mjs) helper is present as content, a
//      loader-safe (.py/.md) helper is mirrored on disk.
//   §3 NO DOUBLE-REGISTRATION: bundled names are unique, and commands.ts
//      de-dupes by name (bundled/first wins).
//   §4 ISOLATION: bundled skills extract to the per-process temp root, never
//      a user config home; no Content module imports raw code as text.
//   §5 HELPERS: every skill that ships a helper ships it with a shebang, and
//      every description stays within the discovery budget.
//   §6 SYNC + DRIVING LAW: every bundled mirror is byte-identical to its
//      mercury-skills/ source (the codegen reverts mirror-only edits), and
//      app-proof keeps the Browser tool as the default journey driver with
//      Playwright demoted to the named escape hatch.
// ============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// MACRO is a build-time define; running the SOURCE directly needs the sim seam
// (getBundledSkillsRoot reads MACRO.VERSION). Set before any src import.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const SOURCE_ROOT = join(ROOT, 'mercury-skills')
const BUNDLED_DIR = join(ROOT, 'src', 'skills', 'bundled')

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const EXPECTED = readdirSync(SOURCE_ROOT, { withFileTypes: true })
  .filter(e => e.isDirectory() && existsSync(join(SOURCE_ROOT, e.name, 'SKILL.md')))
  .map(e => e.name)
  .sort()

const { initBundledSkills } = await import('../../src/skills/bundled/index.js')
const { getBundledSkills, getBundledSkillExtractDir } = await import('../../src/skills/bundledSkills.js')
const { getBundledSkillsRoot } = await import('../../src/utils/permissions/filesystem.js')
const { getMercuryHome } = await import('../../src/utils/envUtils.js')

initBundledSkills()
const skills = getBundledSkills()
const byName = new Map(skills.map(s => [s.name, s]))

section(`§1 REGISTERED — every mercury-skills/ skill (${EXPECTED.length}), each with description + prompt`)
{
  check(EXPECTED.length >= 10, 'the source root carries the full bundled set', `${EXPECTED.length} skills`)
  for (const n of EXPECTED) {
    const s = byName.get(n)
    check(
      !!s && typeof s.description === 'string' && s.description.trim().length > 0 && typeof s.getPromptForCommand === 'function',
      `registered with description + prompt: ${n}`,
    )
  }
}

section('§2 CONTENT — bodies render; reference files carried; embedded + mirrored helpers present')
{
  const anchor = byName.get('mcp-smithy')!
  const out = await anchor.getPromptForCommand('', {} as never)
  const text = Array.isArray(out) ? out.map(b => (b as { text?: string }).text ?? '').join('') : ''
  check(text.length > 200, 'mcp-smithy body renders (>200 chars)', `${text.length} chars`)
  check(!/^---[\s\S]*name:/.test(text.trimStart()), 'frontmatter is stripped from the rendered body')

  const { SKILL_FILES } = (await import('../../src/skills/bundled/mcp-smithyContent.js')) as { SKILL_FILES: Record<string, string> }
  check('references/typescript-v2.md' in SKILL_FILES, 'mcp-smithy carries its reference file')
  // A .mjs helper cannot ride a text loader, so the codegen embeds it as a
  // literal: present in SKILL_FILES, absent from the mirrored tree.
  check(
    'scripts/mcp_probe.mjs' in SKILL_FILES && SKILL_FILES['scripts/mcp_probe.mjs']!.startsWith('#!'),
    'the .mjs helper is embedded as content with its shebang',
  )
  check(!existsSync(join(BUNDLED_DIR, 'mcp-smithy', 'scripts', 'mcp_probe.mjs')), 'an embedded helper leaves no on-disk .mjs copy')
  // A .py helper is loader-safe: mirrored on disk and registered.
  const py = join(BUNDLED_DIR, 'word-documents', 'scripts', 'docx_outline.py')
  const { SKILL_FILES: DOCX_FILES } = (await import('../../src/skills/bundled/word-documentsContent.js')) as { SKILL_FILES: Record<string, string> }
  check(
    existsSync(py) && readFileSync(py, 'utf8').startsWith('#!') && 'scripts/docx_outline.py' in DOCX_FILES,
    'a shebang .py helper is mirrored + registered for extraction (+x on extract)',
  )
  const distPath = join(ROOT, 'dist', 'mercury.mjs')
  if (existsSync(distPath)) {
    const dist = readFileSync(distPath, 'utf8')
    check(dist.includes('def outline(path_or_bytes)'), 'the BUILD inlined the .py helper (text loader works)')
  } else {
    console.log('  (skip dist-inlining check — no dist/mercury.mjs)')
  }
}

section('§3 NO DOUBLE-REGISTRATION — unique names + commands.ts de-dupes')
{
  const names = skills.map(s => s.name)
  check(new Set(names).size === names.length, 'no duplicate bundled skill names', `${names.length} skills`)
  const commandsSrc = readFileSync(join(ROOT, 'src', 'commands.ts'), 'utf8')
  check(
    /const deduped: Command\[\] = \[\]/.test(commandsSrc) && /return deduped/.test(commandsSrc),
    'commands.ts filters duplicates (return deduped, bundled/first wins)',
  )
}

section('§4 ISOLATION — extract to the temp root, never a user config home')
{
  const root = getBundledSkillsRoot()
  check(
    !root.startsWith(getMercuryHome()) && !root.startsWith(join(homedir(), '.mercury')),
    'the bundled-skills extract root is outside the config home',
    root,
  )
  check(root.includes('bundled-skills'), 'extract root is the dedicated per-process bundled-skills temp dir')
  for (const n of ['mcp-smithy', 'provider-apis', 'skill-forge']) {
    const ex = getBundledSkillExtractDir(n)
    check(ex.startsWith(root), `${n} extract dir under the temp root`)
  }
  const bad: string[] = []
  for (const f of readdirSync(BUNDLED_DIR).filter(n => n.endsWith('Content.ts'))) {
    const src = readFileSync(join(BUNDLED_DIR, f), 'utf8')
    if (/^import .* from '\.\/[^']*\.(js|cjs|ts|mjs)'/m.test(src)) bad.push(f)
  }
  check(bad.length === 0, 'no Content module imports raw code as a text ref (all embedded)', bad.join(', ') || 'clean')
}

section('§5 HELPERS + DISCOVERY BUDGET')
{
  for (const n of EXPECTED) {
    const scriptsDir = join(SOURCE_ROOT, n, 'scripts')
    if (!existsSync(scriptsDir)) continue
    const helpers = readdirSync(scriptsDir).filter(f => /\.(py|mjs|js|sh)$/.test(f))
    check(helpers.length >= 1, `${n} ships a helper`, helpers.join(', '))
    for (const h of helpers) {
      const src = readFileSync(join(scriptsDir, h), 'utf8')
      check(src.startsWith('#!') && src.includes('--self-test'), `${n}/scripts/${h} carries a shebang and a --self-test`)
    }
  }
  // Under `bun run` a .md import rides Bun's markdown loader (HTML), so the
  // registered description here is the fallback; the BUILD inlines SKILL.md as
  // text. Read the discovery fields from the source files, and confirm the
  // built dist carries each description verbatim when a dist exists.
  const { parseFrontmatter } = await import('../../src/utils/frontmatterParser.js')
  const dist = existsSync(join(ROOT, 'dist', 'mercury.mjs')) ? readFileSync(join(ROOT, 'dist', 'mercury.mjs'), 'utf8') : null
  const descriptions = new Map<string, string>()
  for (const n of EXPECTED) {
    const { frontmatter } = parseFrontmatter(readFileSync(join(SOURCE_ROOT, n, 'SKILL.md'), 'utf8'))
    const d = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
    check(d.length > 0 && d.length <= 1000, `${n} description present and within the 1000-char discovery budget`, `${d.length} chars`)
    check(/\b(use when|when (the user|asked|you))\b/i.test(d + ' ' + String(frontmatter.when_to_use ?? '')), `${n} description carries a trigger`)
    check(!descriptions.has(d), `${n} description is distinct`)
    descriptions.set(d, n)
    if (dist) check(dist.includes(d.slice(0, 80)), `the BUILD inlined ${n}'s SKILL.md as text (description present in dist)`)
  }
}

section('§6 SOURCE↔MIRROR SYNC + the browser-first driving law')
{
  // gen-bundled.ts names mercury-skills/ the SOURCE OF TRUTH and overwrites
  // the mirror on every run — an edit landed only in src/skills/bundled/ is
  // silently reverted by the next codegen. Byte-equality closes the class.
  for (const n of EXPECTED) {
    const src = readFileSync(join(SOURCE_ROOT, n, 'SKILL.md'), 'utf8')
    const mirror = join(BUNDLED_DIR, n, 'SKILL.md')
    check(
      existsSync(mirror) && readFileSync(mirror, 'utf8') === src,
      `${n}: the bundled mirror is byte-identical to the source (gen-bundled ran)`,
    )
  }
  // The app-proof skill routed agents to Playwright as "the default driver"
  // and demoted the native Browser tool to a screenshot toy — the exact
  // in-product instruction behind an agent hand-building a browser harness.
  // These teeth keep the demotion demoted.
  const appProof = readFileSync(join(SOURCE_ROOT, 'app-proof', 'SKILL.md'), 'utf8')
  const { parseFrontmatter } = await import('../../src/utils/frontmatterParser.js')
  const desc = String(parseFrontmatter(appProof).frontmatter.description ?? '')
  check(
    desc.includes('Browser') && !desc.includes('Playwright'),
    'app-proof routes on the Browser tool, never Playwright (the description IS the router)',
  )
  check(
    /`Browser` tool is the default driver/.test(appProof),
    'the Browser tool is named the default driver for journeys',
  )
  check(
    !/Playwright[^.]{0,80}is the default driver/.test(appProof),
    'Playwright is never named the default driver',
  )
  check(
    appProof.includes('never hand-roll a headless-Chrome harness'),
    'the hand-rolled-harness ban is spelled in the skill',
  )
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? '✅ BUNDLED SKILLS GREEN' : `❌ BUNDLED SKILLS RED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
