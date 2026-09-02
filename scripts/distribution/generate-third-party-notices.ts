#!/usr/bin/env bun
// ============================================================================
//  scripts/distribution/generate-third-party-notices.ts — the reproducible
//  third-party inventory.
//
//  Builds THIRD_PARTY_NOTICES.md from the ACTUAL dependency truth — never a
//  handwritten memory list:
//    • runtime packages: package.json dependencies + the installed
//      node_modules metadata (bun.lock is the version authority);
//    • vendored tool payloads: the checked-in vendor lock receipts
//      (vendor/debugpy.lock.json, vendor/pyright.lock.json) + the
//      devDependency metadata for typescript / tree-sitter / ripgrep;
//    • source attributions: third-party code living inside Mercury's own tree
//      (stated below — the generated notices are their canonical statement);
//    • bundled skills: per-skill LICENSE files beside their sources.
//
//  Regenerate: ~/.bun/bin/bun run scripts/distribution/generate-third-party-notices.ts
//  Verified by: scripts/distribution/prove-distribution-notices.ts (coverage) and
//  the release packager copies this file into every archive.
// ============================================================================
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CURRENT_NOTICE_SLOTS } from '../../src/constants/legalNotice.js'

const ROOT = join(import.meta.dir, '..', '..')

type Row = { name: string; version: string; license: string; homepage?: string }

function pkgMeta(name: string): Row {
  const p = join(ROOT, 'node_modules', name, 'package.json')
  if (!existsSync(p)) return { name, version: 'not installed', license: 'UNKNOWN — package not installed' }
  const j = JSON.parse(readFileSync(p, 'utf8')) as {
    version?: string
    license?: string | { type?: string }
    homepage?: string
    repository?: { url?: string } | string
  }
  const license =
    typeof j.license === 'string' ? j.license : (j.license?.type ?? 'UNKNOWN')
  const repo =
    typeof j.repository === 'string' ? j.repository : j.repository?.url
  return {
    name,
    version: j.version ?? '?',
    license,
    homepage: j.homepage ?? repo,
  }
}

const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string
  dependencies?: Record<string, string>
}
const runtime = Object.keys(rootPkg.dependencies ?? {}).sort()
const rows = runtime.map(pkgMeta)

const byLicense = new Map<string, Row[]>()
for (const r of rows) {
  const list = byLicense.get(r.license) ?? []
  list.push(r)
  byLicense.set(r.license, list)
}

function vendorLock(file: string): { version?: string; license?: string; url?: string } {
  const p = join(ROOT, 'vendor', file)
  if (!existsSync(p)) return {}
  return JSON.parse(readFileSync(p, 'utf8')) as { version?: string; license?: string; url?: string }
}
const debugpy = vendorLock('debugpy.lock.json')
const pyright = vendorLock('pyright.lock.json')
const tsMeta = pkgMeta('typescript')
const treeSitterMeta = pkgMeta('@vscode/tree-sitter-wasm')
const ripgrepMeta = pkgMeta('@vscode/ripgrep')

// ── the Apache-2.0 NOTICE preservation sweep (LANE LW deliverable 2) ────────
// §4(d) of Apache-2.0: when a redistributed work ships a NOTICE file, its
// attribution notices must ride along. The sweep walks EVERY installed
// package root (transitive deps included — the bundle inlines the whole
// runtime graph) for NOTICE / NOTICE.txt / NOTICE.md and embeds each one
// VERBATIM below. Zero found is a stated fact, not an omitted section — the
// gate keeps the sweep alive so a future dependency's NOTICE file is
// preserved the day it appears, never remembered by hand.
interface FoundNotice {
  pkg: string
  version: string
  file: string
  content: string
}
function sweepNoticeFiles(): FoundNotice[] {
  const found: FoundNotice[] = []
  const NOTICE_RE = /^NOTICE(\.(txt|md))?$/i
  const walk = (dir: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    const hasPkgJson = entries.includes('package.json')
    if (hasPkgJson) {
      for (const e of entries) {
        if (NOTICE_RE.test(e) && statSync(join(dir, e)).isFile()) {
          let name = dir
          let version = '?'
          try {
            const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
            name = meta.name ?? dir
            version = meta.version ?? '?'
          } catch {
            /* an unreadable package.json still gets its NOTICE preserved */
          }
          found.push({ pkg: name, version, file: e, content: readFileSync(join(dir, e), 'utf8') })
        }
      }
    }
    for (const e of entries) {
      if (e === '.bin' || e === '.cache') continue
      const full = join(dir, e)
      try {
        if (statSync(full).isDirectory()) walk(full)
      } catch {
        /* races/symlink loops — skip */
      }
    }
  }
  walk(join(ROOT, 'node_modules'))
  return found.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0))
}
const preservedNotices = sweepNoticeFiles()

const lines: string[] = []
lines.push('# Third-party notices — Mercury')
lines.push('')
// The operator's NAMED TEXT SLOTS (src/constants/legalNotice.ts — the one
// owner; the generator renders them, never authors them). While a slot is
// null the line is simply absent.
if (CURRENT_NOTICE_SLOTS.copyrightLine) lines.push(CURRENT_NOTICE_SLOTS.copyrightLine, '')
if (CURRENT_NOTICE_SLOTS.licensePointer) lines.push(CURRENT_NOTICE_SLOTS.licensePointer, '')
lines.push(
  `Generated by \`scripts/distribution/generate-third-party-notices.ts\` from the actual dependency truth (package.json + bun.lock + the checked-in vendor lock receipts) for Mercury ${rootPkg.version}. Regenerate after any dependency or vendor change; \`scripts/distribution/prove-distribution-notices.ts\` fails the gate when this file drifts from the lockfile truth. Mercury is a private, unpublished project — this inventory is distribution GROUNDWORK: it records each third-party body, its licence identifier, and where the applicable licence text is retained.`,
)
lines.push('')
lines.push('## Bundled runtime packages')
lines.push('')
lines.push(
  `The built artifact (\`dist/mercury.mjs\`) is a self-contained bundle that inlines the ${rows.length} runtime packages below (versions = the installed/bun.lock resolutions). Full licence texts are retained in each package's \`node_modules/<name>/\` tree in the source checkout; per-file copyright headers survive inside the bundle where the sources carried them.`,
)
lines.push('')
for (const [license, list] of [...byLicense.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`### ${license}`)
  lines.push('')
  for (const r of list.sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`- **${r.name}** ${r.version}${r.homepage ? ` — ${r.homepage}` : ''}`)
  }
  lines.push('')
}
lines.push('## Vendored tool payloads (`dist/vendor/`)')
lines.push('')
lines.push(
  `- **ripgrep** (via ${ripgrepMeta.name} ${ripgrepMeta.version}, ${ripgrepMeta.license}) — the platform search binary, © the ripgrep contributors, dual-licensed MIT / UNLICENSE (https://github.com/BurntSushi/ripgrep). Redistributed unmodified; the wrapper package's licence text lives at node_modules/@vscode/ripgrep/LICENSE.`,
)
lines.push(
  `- **debugpy** ${debugpy.version ?? '(not vendored on this checkout)'} — Microsoft, ${debugpy.license ?? 'MIT'} (${debugpy.url ?? 'https://github.com/microsoft/debugpy'}). Receipt: vendor/debugpy.lock.json; licence text ships at dist/vendor/debugpy/…/licenses/LICENSE + ThirdPartyNotices.txt.`,
)
lines.push(
  `- **pyright** ${pyright.version ?? '(not vendored on this checkout)'} — Microsoft, ${pyright.license ?? 'MIT'} (${pyright.url ?? 'https://github.com/microsoft/pyright'}). Receipt: vendor/pyright.lock.json; licence text ships at dist/vendor/pyright/LICENSE.txt (+ typeshed LICENSE).`,
)
lines.push(
  `- **TypeScript compiler** ${tsMeta.version} — Microsoft, ${tsMeta.license} (https://github.com/microsoft/TypeScript). Vendored from the repo devDependency; licence text ships at dist/vendor/typescript/LICENSE.txt.`,
)
lines.push(
  `- **tree-sitter WASM engine + grammars** (${treeSitterMeta.name} ${treeSitterMeta.version}) — Microsoft, ${treeSitterMeta.license} (https://github.com/microsoft/vscode-tree-sitter-wasm). Licence text ships at dist/vendor/treesitter/LICENSE.`,
)
{
  // the cherry-picked grammar-pack extension. The pack's Unlicense
  // covers only its build scripts — each grammar keeps its UPSTREAM licence,
  // enumerated per-grammar from the lock receipt.
  const grammarsLockPath = join(ROOT, 'vendor', 'grammars.lock.json')
  if (existsSync(grammarsLockPath)) {
    const gl = JSON.parse(readFileSync(grammarsLockPath, 'utf8')) as {
      version?: string
      grammars?: Array<{ wasm: string; upstream?: { package?: string; license?: string; repository?: string } }>
    }
    const per = (gl.grammars ?? [])
      .map(g => `${g.upstream?.package ?? g.wasm} (${g.upstream?.license ?? 'unknown'}, ${g.upstream?.repository ?? ''})`)
      .join(' · ')
    lines.push(
      `- **grammar-pack extension** (tree-sitter-wasms ${gl.version ?? '?'}, pack scripts Unlicense — https://github.com/Gregoor/tree-sitter-wasms) — cherry-picked prebuilt grammar wasms; EACH grammar keeps its upstream licence: ${per}. Receipt: vendor/grammars.lock.json; the pack licence ships at dist/vendor/treesitter/LICENSE.grammar-pack and the per-grammar licence record at dist/vendor/treesitter/GRAMMAR-NOTICES.json.`,
    )
  }
}
lines.push('')
lines.push('## Preserved NOTICE files (Apache-2.0 §4(d))')
lines.push('')
if (preservedNotices.length === 0) {
  lines.push(
    'The preservation sweep walked every installed package root (transitive dependencies included) for `NOTICE`/`NOTICE.txt`/`NOTICE.md` files and found **none** in the current dependency set — the Apache-2.0 packages above (including `@anthropic-ai/sandbox-runtime`) ship a LICENSE file only. Any NOTICE file a future dependency introduces is embedded verbatim here on regeneration; `prove-notice-stamp.ts` re-runs the sweep and fails the gate if this section drifts from the installed truth.',
  )
} else {
  lines.push(
    `The preservation sweep found ${preservedNotices.length} NOTICE file(s); each is reproduced verbatim below per Apache-2.0 §4(d).`,
  )
  for (const n of preservedNotices) {
    lines.push('')
    lines.push(`### ${n.pkg} ${n.version} — ${n.file}`)
    lines.push('')
    lines.push('```text')
    lines.push(n.content.replace(/`{3}/g, '` ` `').trimEnd())
    lines.push('```')
  }
}
lines.push('')
lines.push('## Source attributions')
lines.push('')
lines.push(
  '- Parts of the terminal runtime (`src/ink/` — reconciler, DOM, styles, component shells) derive from the **Ink** project — © Vadim Demedes and contributors, MIT (https://github.com/vadimdemedes/ink). The layout engine, termio tokenizer, input byte layer and frame writer are Mercury-native.',
)
lines.push('')
lines.push(
  '- The extensions estate: archive sources are decompressed with **fflate** (MIT; a direct dependency) through the hardened reader at `src/utils/archive/zip.ts`. **@anthropic-ai/mcpb** (MIT) is retained as a dependency deliberately; the extensions estate reads no bundle files — an extension declares its servers in its own manifest — and the package stays available, with this notice, for a later bundle-backed server kind.',
)
lines.push('')
lines.push('## Bundled skills')
lines.push('')
lines.push(
  '- The skills compiled into the bundle under `src/skills/bundled/` are Mercury\'s own work and ship under the product licence.',
)
lines.push('')

writeFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), lines.join('\n'))
console.log(
  `THIRD_PARTY_NOTICES.md written — ${rows.length} runtime packages across ${byLicense.size} licence identifiers + 6 vendor payloads + source attributions`,
)
