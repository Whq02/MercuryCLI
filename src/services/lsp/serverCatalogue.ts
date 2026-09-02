// ============================================================================
//  lsp/serverCatalogue — the bundled catalogue of language-server rows.
//
//  Each entry is DATA: binary names, spawn args, extension→language map,
//  root markers, install remedy. Three DISTINCT states, never conflated:
//    catalogue presence — the row exists here (knowledge, not capability);
//    detected           — a binary resolves (project-local bins first, then
//                         PATH) — visible in /health as configured;
//    OFFERED            — detected AND a root marker matches the cwd: the
//                         row joins the configured-server map (LAST in the
//                         first-wins merge — operator env, extensions, and the
//                         curated builtin lanes all outrank it) and spawns
//                         LAZILY on the first operation that touches a
//                         matching file. Detection is cwd-only; the
//                         catalogue never probes beyond the workspace root.
//
//  A row that is present-but-not-offered says exactly why (no binary / no
//  root marker) through the readiness records (/capabilities + doctor).
//  Linter-class rows carry diagnosticsOnly and are never the navigation
//  primary. Proof: scripts/lsp/prove-lsp-catalogue.ts.
// ============================================================================

import { existsSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { spawnableSpellings, whichSync } from '../../utils/which.js'
import { mercuryLspEnabled } from './mercuryLsp.js'
import type { ScopedLspServerConfig } from './types.js'

export interface CatalogueEntry {
  /** Stable id (readiness row: `catalogue:lsp:<id>`; config row: `catalogue:<id>`). */
  id: string
  label: string
  /** The languages/formats this server credibly owns. */
  languages: string[]
  /** PATH binary names probed, first hit wins. */
  binaries: string[]
  /** Arguments after the resolved binary. */
  args?: string[]
  /** File-extension → LSP language id map (the routing claim). */
  extensionToLanguage: Record<string, string>
  /** Workspace files that mark a project this server owns. Literal names
   *  ("Cargo.toml") or `*.ext` suffix patterns (".sln"). Empty = offer on
   *  binary alone (single-file languages like shell). */
  rootMarkers: string[]
  /** Linter-class lane: diagnostics + sync only, never navigation primary. */
  diagnosticsOnly?: boolean
  initializationOptions?: unknown
  /** The exact install remedy shown when no binary is present. */
  remedy: string
}

export const SERVER_CATALOGUE: CatalogueEntry[] = [
  { id: 'rust-analyzer', label: 'rust-analyzer', languages: ['rust'], binaries: ['rust-analyzer'], extensionToLanguage: { '.rs': 'rust' }, rootMarkers: ['Cargo.toml'], remedy: 'rustup component add rust-analyzer (or brew install rust-analyzer)' },
  { id: 'gopls', label: 'gopls', languages: ['go'], binaries: ['gopls'], extensionToLanguage: { '.go': 'go' }, rootMarkers: ['go.mod', 'go.work'], remedy: 'go install golang.org/x/tools/gopls@latest' },
  { id: 'zls', label: 'zls (Zig)', languages: ['zig'], binaries: ['zls'], extensionToLanguage: { '.zig': 'zig' }, rootMarkers: ['build.zig'], remedy: 'brew install zls (or download from github.com/zigtools/zls)' },
  { id: 'jdtls', label: 'Eclipse JDT LS', languages: ['java'], binaries: ['jdtls'], extensionToLanguage: { '.java': 'java' }, rootMarkers: ['pom.xml', 'build.gradle', 'build.gradle.kts', '.classpath'], remedy: 'brew install jdtls (or download from eclipse.org/jdtls)' },
  { id: 'kotlin-language-server', label: 'Kotlin LS', languages: ['kotlin'], binaries: ['kotlin-language-server'], extensionToLanguage: { '.kt': 'kotlin', '.kts': 'kotlin' }, rootMarkers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], remedy: 'brew install kotlin-language-server' },
  { id: 'csharp', label: 'C# LS', languages: ['c-sharp'], binaries: ['csharp-ls', 'OmniSharp'], extensionToLanguage: { '.cs': 'csharp' }, rootMarkers: ['*.sln', '*.csproj'], remedy: 'dotnet tool install --global csharp-ls' },
  { id: 'sourcekit-lsp', label: 'SourceKit-LSP', languages: ['swift'], binaries: ['sourcekit-lsp'], extensionToLanguage: { '.swift': 'swift' }, rootMarkers: ['Package.swift', '*.xcodeproj'], remedy: 'ships with Xcode/Swift toolchains (xcrun sourcekit-lsp)' },
  { id: 'ruby-lsp', label: 'Ruby LSP', languages: ['ruby'], binaries: ['ruby-lsp', 'solargraph'], args: [], extensionToLanguage: { '.rb': 'ruby', '.rake': 'ruby' }, rootMarkers: ['Gemfile'], remedy: 'gem install ruby-lsp' },
  { id: 'intelephense', label: 'Intelephense (PHP)', languages: ['php'], binaries: ['intelephense'], args: ['--stdio'], extensionToLanguage: { '.php': 'php' }, rootMarkers: ['composer.json'], remedy: 'npm i -g intelephense' },
  { id: 'lua-language-server', label: 'Lua LS', languages: ['lua'], binaries: ['lua-language-server'], extensionToLanguage: { '.lua': 'lua' }, rootMarkers: ['.luarc.json', 'init.lua'], remedy: 'brew install lua-language-server' },
  { id: 'bash-language-server', label: 'Bash LS', languages: ['bash'], binaries: ['bash-language-server'], args: ['start'], extensionToLanguage: { '.sh': 'shellscript', '.bash': 'shellscript' }, rootMarkers: [], remedy: 'npm i -g bash-language-server' },
  { id: 'yaml-language-server', label: 'YAML LS', languages: ['yaml'], binaries: ['yaml-language-server'], args: ['--stdio'], extensionToLanguage: { '.yaml': 'yaml', '.yml': 'yaml' }, rootMarkers: [], remedy: 'npm i -g yaml-language-server' },
  { id: 'marksman', label: 'Marksman (Markdown)', languages: ['markdown'], binaries: ['marksman'], args: ['server'], extensionToLanguage: { '.md': 'markdown' }, rootMarkers: [], remedy: 'brew install marksman' },
  { id: 'terraform-ls', label: 'Terraform LS', languages: ['terraform', 'hcl'], binaries: ['terraform-ls'], args: ['serve'], extensionToLanguage: { '.tf': 'terraform', '.tfvars': 'terraform-vars' }, rootMarkers: ['*.tf'], remedy: 'brew install hashicorp/tap/terraform-ls' },
  { id: 'docker-langserver', label: 'Dockerfile LS', languages: ['dockerfile'], binaries: ['docker-langserver'], args: ['--stdio'], extensionToLanguage: { '.dockerfile': 'dockerfile' }, rootMarkers: ['Dockerfile'], remedy: 'npm i -g dockerfile-language-server-nodejs' },
  { id: 'elixir-ls', label: 'Elixir LS', languages: ['elixir'], binaries: ['elixir-ls', 'language_server.sh'], extensionToLanguage: { '.ex': 'elixir', '.exs': 'elixir' }, rootMarkers: ['mix.exs'], remedy: 'brew install elixir-ls' },
  { id: 'helm-ls', label: 'Helm LS', languages: ['helm'], binaries: ['helm_ls'], args: ['serve'], extensionToLanguage: { '.tpl': 'helm' }, rootMarkers: ['Chart.yaml'], remedy: 'brew install helm-ls' },
  { id: 'vue', label: 'Vue LS', languages: ['vue'], binaries: ['vue-language-server', 'vls'], args: ['--stdio'], extensionToLanguage: { '.vue': 'vue' }, rootMarkers: ['package.json'], remedy: 'npm i -g @vue/language-server' },
  { id: 'svelte', label: 'Svelte LS', languages: ['svelte'], binaries: ['svelteserver'], args: ['--stdio'], extensionToLanguage: { '.svelte': 'svelte' }, rootMarkers: ['package.json'], remedy: 'npm i -g svelte-language-server' },
  { id: 'astro', label: 'Astro LS', languages: ['astro'], binaries: ['astro-ls'], args: ['--stdio'], extensionToLanguage: { '.astro': 'astro' }, rootMarkers: ['package.json'], remedy: 'npm i -g @astrojs/language-server' },
  { id: 'tailwind', label: 'Tailwind CSS LS', languages: ['tailwindcss'], binaries: ['tailwindcss-language-server'], args: ['--stdio'], extensionToLanguage: { '.css': 'css' }, rootMarkers: ['tailwind.config.js', 'tailwind.config.ts'], remedy: 'npm i -g @tailwindcss/language-server' },
]

export interface CatalogueProbe {
  entry: CatalogueEntry
  /** The found binary's absolute path, when present. */
  binaryPath?: string
  /** Which rung resolved it. */
  binarySource?: 'project-local' | 'path'
  /** Whether a root marker matches the cwd (empty markers ⇒ true). */
  rootMatched: boolean
}

/** One bounded cwd listing per probe sweep (marker matching material). */
function listCwdEntries(cwd: string): string[] {
  try {
    return readdirSync(cwd)
  } catch {
    return []
  }
}

function markerMatches(markers: string[], cwdEntries: string[]): boolean {
  if (markers.length === 0) return true
  for (const marker of markers) {
    if (marker.startsWith('*.')) {
      const suffix = marker.slice(1) // '.sln'
      if (cwdEntries.some(e => e.endsWith(suffix))) return true
    } else if (cwdEntries.includes(marker)) {
      return true
    }
  }
  return false
}

/** Binary resolution: the project's own bin dir first (a repo-pinned server
 *  outranks a global one), then PATH. The local probe walks the SPAWNABLE
 *  spellings ahead of the bare name: npm writes the extensionless POSIX shim
 *  beside <name>.cmd, and the bare name resolved first on win32 — a file
 *  node cannot spawn, offered by health and never started (FN-015 rank 18);
 *  the .cmd sibling is the shape the client's batch-shim shell ride runs. */
function resolveBinary(entry: CatalogueEntry, cwd: string): { path: string; source: 'project-local' | 'path' } | null {
  for (const bin of entry.binaries) {
    for (const spelling of spawnableSpellings(bin)) {
      const local = path.join(cwd, 'node_modules', '.bin', spelling)
      if (existsSync(local)) return { path: local, source: 'project-local' }
    }
  }
  for (const bin of entry.binaries) {
    const found = whichSync(bin)
    if (found) return { path: found, source: 'path' }
  }
  return null
}

/** PATH/root probe for one entry against a cwd listing.
 *
 *  `binaryProbe` exists because the two consumers want different costs: the
 *  root check is FREE (an already-read listing) while resolveBinary is a
 *  blocking `where.exe` per missing binary on win32 with misses uncached by
 *  law — probing all ~24 catalogue binaries a box does not have, on the
 *  startup path and again per capability-manager refresh, stalled the loop
 *  for two dozen process creations that the offered-configs consumer then
 *  threw away on `!rootMatched` anyway (TASK-017 S2,
 *  lsp-catalogue-where-exe-sweep). The records view still probes 'always':
 *  its "binary present but no root marker" rows are the point of the view. */
export function probeCatalogueEntry(
  entry: CatalogueEntry,
  cwd: string = getCwd(),
  cwdEntries: string[] = listCwdEntries(cwd),
  binaryProbe: 'always' | 'when-root-matched' = 'always',
): CatalogueProbe {
  const rootMatched = markerMatches(entry.rootMarkers, cwdEntries)
  if (binaryProbe === 'when-root-matched' && !rootMatched) return { entry, rootMatched }
  const bin = resolveBinary(entry, cwd)
  if (!bin) return { entry, rootMatched }
  return { entry, binaryPath: bin.path, binarySource: bin.source, rootMatched }
}

/**
 * The catalogue's OFFERED config rows: detection = resolvable binary ∩ root
 * marker, cwd-only. Rows join the configured-server map LAST in the
 * first-wins merge, so the operator env, extensions, and every curated builtin
 * lane outrank them — and servers spawn lazily, on first use, never here.
 */
export function catalogueServerConfigs(): Record<string, ScopedLspServerConfig> {
  if (!mercuryLspEnabled()) return {}
  const cwd = getCwd()
  const cwdEntries = listCwdEntries(cwd)
  const out: Record<string, ScopedLspServerConfig> = {}
  for (const entry of SERVER_CATALOGUE) {
    // Lazy binary probe: a row this consumer would drop on !rootMatched must
    // never pay a where.exe launch for the binary it will not use.
    const probe = probeCatalogueEntry(entry, cwd, cwdEntries, 'when-root-matched')
    if (!probe.binaryPath || !probe.rootMatched) continue
    out[`catalogue:${entry.id}`] = {
      command: probe.binaryPath,
      args: entry.args ?? [],
      extensionToLanguage: entry.extensionToLanguage,
      transport: 'stdio',
      workspaceFolder: cwd,
      startupTimeout: 30_000,
      maxRestarts: 2,
      rootMarkers: entry.rootMarkers,
      ...(entry.diagnosticsOnly ? { diagnosticsOnly: true } : {}),
      ...(entry.initializationOptions !== undefined
        ? { initializationOptions: entry.initializationOptions }
        : {}),
      scope: 'dynamic',
      source: 'mercury-catalogue',
    }
  }
  return out
}

/**
 * Readiness rows for the catalogue — three-state honesty:
 *   offered      — binary + root marker: the row is IN the config map and
 *                  spawns lazily on first use ('configured' state, offered
 *                  detail);
 *   configured   — binary present, no root marker in this cwd (present, not
 *                  engaged — the detail names the missing marker);
 *   unavailable  — no binary, with the install remedy.
 * A row here never reads 'ready'; only a RUNNING server does (its own
 * `lane:lsp:<name>` row, not here).
 */
export function serverCatalogueRecords(): Array<{
  id: string
  kind: 'lane'
  label: string
  state: 'configured' | 'unavailable'
  detail: string
  remedy?: string
  source: string
  lastCheckedAt: number
}> {
  if (!mercuryLspEnabled()) return []
  const at = Date.now()
  const cwd = getCwd()
  const cwdEntries = listCwdEntries(cwd)
  return SERVER_CATALOGUE.map(entry => {
    const probe = probeCatalogueEntry(entry, cwd, cwdEntries)
    if (probe.binaryPath && probe.rootMatched) {
      return {
        id: `catalogue:lsp:${entry.id}`,
        kind: 'lane' as const,
        label: `${entry.label} (offered)`,
        state: 'configured' as const,
        detail: `binary present (${probe.binaryPath}, ${probe.binarySource}) and a root marker matches — offered to the manager; spawns lazily on first ${Object.keys(entry.extensionToLanguage).join('/')} operation`,
        source: 'serverCatalogue probe',
        lastCheckedAt: at,
      }
    }
    if (probe.binaryPath) {
      return {
        id: `catalogue:lsp:${entry.id}`,
        kind: 'lane' as const,
        label: `${entry.label} (detected)`,
        state: 'configured' as const,
        detail: `binary present (${probe.binaryPath}) but no root marker (${entry.rootMarkers.join(', ')}) in ${cwd} — not offered here; wire it via MERCURY_LSP_SERVERS (or an extension) to force it`,
        source: 'serverCatalogue probe',
        lastCheckedAt: at,
      }
    }
    return {
      id: `catalogue:lsp:${entry.id}`,
      kind: 'lane' as const,
      label: entry.label,
      state: 'unavailable' as const,
      detail: `no ${entry.binaries.join('/')} on PATH (${entry.languages.join(', ')})`,
      remedy: entry.remedy,
      source: 'serverCatalogue probe',
      lastCheckedAt: at,
    }
  })
}
