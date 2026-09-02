#!/usr/bin/env bun
// ============================================================================
//  scripts/skills/gen-bundled.ts — CODEGEN for the bundled skills.
//
//  For each skill dir under mercury-skills/ (or a name list on argv), it:
//    1. mirrors the text/script tree into src/skills/bundled/<name>/ (skipping
//       binaries — fonts/pyc/pdf/gz/images — and __pycache__),
//    2. generates <camel>Content.ts:
//         - SKILL.md + loader-safe refs (.md/.txt/.sh/.py/.html/.xml/.dot) are
//           IMPORTED via Bun's text loader (build.ts),
//         - .js/.cjs/.ts/extensionless refs are EMBEDDED as string literals
//           (those extensions can't be globalized to a text loader without
//           turning real code imports into strings),
//    3. generates <camel>.ts (registerBundledSkill wrapper; frontmatter parsed
//       at runtime for description, when_to_use, argument-hint, invocation flags),
//    4. prints the src/skills/bundled/index.ts wiring (import + call lines).
//
//  Idempotent + re-runnable: mercury-skills/ is the SOURCE OF TRUTH; edit
//  there and re-run. Bundled skills extract to getBundledSkillsRoot() (a
//  per-process temp dir), never a user config home — see prove-bundled-skills.
//
//  Usage:  bun run scripts/skills/gen-bundled.ts [skill-name ...]
// ============================================================================

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
// The one source root for bundled skills.
const SOURCE_ROOTS = [join(ROOT, 'mercury-skills')]
const DEST = join(ROOT, 'src', 'skills', 'bundled')

/** The source root that holds `<name>/SKILL.md` (first root wins). */
function resolveSourceRoot(name: string): string | undefined {
  for (const root of SOURCE_ROOTS) {
    if (existsSync(join(root, name, 'SKILL.md'))) return root
  }
  return undefined
}

// Files never bundled: binaries + regeneratable artifacts + tree docs.
const SKIP_EXT = new Set(['.ttf', '.otf', '.woff', '.woff2', '.pyc', '.pdf', '.gz', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.ico', '.webp'])
// Extensions safe to import via a GLOBAL 'text' loader (build.ts) — never a
// real JS/TS module extension.
const LOADER_TEXT_EXT = new Set(['.md', '.txt', '.sh', '.py', '.html', '.xml', '.dot'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === '__pycache__' || e.name === 'node_modules' || e.name === '.git') continue
      out.push(...walk(p))
    } else if (e.isFile()) {
      out.push(p)
    }
  }
  return out
}

function camel(name: string): string {
  return name
    .split(/[-_]/)
    .map(s => (s ? s[0]!.toUpperCase() + s.slice(1) : ''))
    .join('')
}

/** A stable, unique, valid JS identifier for a ref import. */
function ident(relPath: string, seen: Set<string>): string {
  let base = 'ref_' + relPath.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (base.length > 60) base = base.slice(0, 60)
  let id = base
  let n = 1
  while (seen.has(id)) id = `${base}_${n++}`
  seen.add(id)
  return id
}

function genSkill(name: string): { importLine: string; callLine: string } | null {
  const root = resolveSourceRoot(name)
  if (!root) {
    console.log(`  ! ${name}: no SKILL.md in any source root — skipped`)
    return null
  }
  const srcDir = join(root, name)
  const skillMd = join(srcDir, 'SKILL.md')
  const destDir = join(DEST, name)
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })

  const files = walk(srcDir)
  const refImports: string[] = [] // import lines for loader-safe refs
  const refEntries: string[] = [] // SKILL_FILES entries
  const seen = new Set<string>()

  for (const abs of files) {
    const rel = relative(srcDir, abs) // POSIX-ish relative path
    const relPosix = rel.split(/[\\/]/).join('/')
    const ext = extname(abs).toLowerCase()
    if (SKIP_EXT.has(ext)) continue
    const content = readFileSync(abs)
    const isSkillMd = relPosix === 'SKILL.md'
    const loaderSafe = LOADER_TEXT_EXT.has(ext)

    // Write to disk ONLY files that Content.ts IMPORTS (SKILL.md + loader-safe
    // refs). Embedded refs (.js/.cjs/.ts/extensionless) live ONLY in Content.ts
    // and extract from there — leaving a redundant on-disk .ts/.js copy would
    // (a) trip the no-orphans ratchet (an un-imported .ts asset) and (b) bloat
    // src/. The content is preserved verbatim in the SKILL_FILES literal.
    if (isSkillMd || loaderSafe) {
      const destFile = join(destDir, rel)
      mkdirSync(dirname(destFile), { recursive: true })
      writeFileSync(destFile, content)
    }
    if (isSkillMd) continue // the skill body, imported separately

    if (loaderSafe) {
      const id = ident(relPosix, seen)
      refImports.push(`import ${id} from './${name}/${relPosix}'`)
      refEntries.push(`  ${JSON.stringify(relPosix)}: ${id},`)
    } else {
      // .js/.cjs/.ts/extensionless/other → EMBED as a literal (can't be a
      // global text loader). Content read from disk at codegen time.
      const text = content.toString('utf8')
      refEntries.push(`  ${JSON.stringify(relPosix)}: ${JSON.stringify(text)},`)
    }
  }

  const contentTs =
    `// AUTO-GENERATED by scripts/skills/gen-bundled.ts — DO NOT EDIT BY HAND.\n` +
    `// Source of truth: mercury-skills/${name}/. Re-run the codegen to update.\n` +
    `import skillMd from './${name}/SKILL.md'\n` +
    (refImports.length ? refImports.join('\n') + '\n' : '') +
    `\nexport const SKILL_MD: string = skillMd\n\n` +
    `export const SKILL_FILES: Record<string, string> = {\n` +
    refEntries.join('\n') +
    (refEntries.length ? '\n' : '') +
    `}\n`
  writeFileSync(join(DEST, `${name}Content.ts`), contentTs)

  const Camel = camel(name)
  const registerTs =
    `// AUTO-GENERATED by scripts/skills/gen-bundled.ts — DO NOT EDIT BY HAND.\n` +
    `import { parseFrontmatter } from '../../utils/frontmatterParser.js'\n` +
    `import { registerBundledSkill } from '../bundledSkills.js'\n` +
    `import { SKILL_FILES, SKILL_MD } from './${name}Content.js'\n\n` +
    `const { frontmatter, content: SKILL_BODY } = parseFrontmatter(SKILL_MD)\n` +
    `const DESCRIPTION =\n` +
    `  typeof frontmatter.description === 'string' && frontmatter.description.trim()\n` +
    `    ? frontmatter.description\n` +
    `    : ${JSON.stringify(`${name} — bundled skill`)}\n\n` +
    `/** The '${name}' bundled skill. Reference files extract to a per-process\n` +
    ` *  temp dir on first invocation, never a user config home. */\n` +
    `export function register${Camel}Skill(): void {\n` +
    `  registerBundledSkill({\n` +
    `    name: ${JSON.stringify(name)},\n` +
    `    description: DESCRIPTION,\n` +
    `    ...(typeof frontmatter.when_to_use === 'string' && frontmatter.when_to_use.trim()\n` +
    `      ? { whenToUse: frontmatter.when_to_use }\n` +
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
  writeFileSync(join(DEST, `${name}.ts`), registerTs)

  const refCount = refImports.length + refEntries.length - refImports.length // = refEntries total
  console.log(`  ✓ ${name}  (${refEntries.length} ref file(s))`)
  return {
    importLine: `import { register${Camel}Skill } from './${name}.js'`,
    callLine: `  register${Camel}Skill()`,
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const discovered = new Set<string>()
for (const root of SOURCE_ROOTS) {
  if (!existsSync(root)) continue
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) discovered.add(e.name)
  }
}
const names = (argv.length ? argv : [...discovered].sort()).filter(n => {
  if (!resolveSourceRoot(n)) {
    console.log(`  ! ${n}: no SKILL.md in the source root — skipped`)
    return false
  }
  return true
})

console.log(`Generating ${names.length} bundled skill(s)…`)
const wiring: { importLine: string; callLine: string }[] = []
for (const n of names) {
  const w = genSkill(n)
  if (w) wiring.push(w)
}

console.log('\n── index.ts wiring (add these) ──')
console.log('// imports:')
console.log(wiring.map(w => w.importLine).join('\n'))
console.log('// calls (inside initBundledSkills):')
console.log(wiring.map(w => w.callLine).join('\n'))
console.log(`\n✅ generated ${wiring.length} skill(s)`)
