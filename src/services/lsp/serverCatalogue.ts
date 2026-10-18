
import { existsSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { getCwd } from '../../utils/cwd.js'
import { spawnableSpellings, whichSync } from '../../utils/which.js'
import { mercuryLspEnabled } from './mercuryLsp.js'
import type { ScopedLspServerConfig } from './types.js'

interface CatalogueEntry {
  id: string
  label: string
  languages: string[]
  binaries: string[]
  args?: string[]
  extensionToLanguage: Record<string, string>
  rootMarkers: string[]
  diagnosticsOnly?: boolean
  initializationOptions?: unknown
  remedy: string
  remedyWin32?: string
}

export function remedyFor(entry: Pick<CatalogueEntry, 'remedy' | 'remedyWin32'>, platform: string = process.platform): string {
  return platform === 'win32' ? entry.remedyWin32 ?? entry.remedy : entry.remedy
}

export const SERVER_CATALOGUE: CatalogueEntry[] = [
  { id: 'rust-analyzer', label: 'rust-analyzer', languages: ['rust'], binaries: ['rust-analyzer'], extensionToLanguage: { '.rs': 'rust' }, rootMarkers: ['Cargo.toml'], remedy: 'rustup component add rust-analyzer (or brew install rust-analyzer)', remedyWin32: 'rustup component add rust-analyzer (or the release binary from github.com/rust-lang/rust-analyzer/releases)' },
  { id: 'gopls', label: 'gopls', languages: ['go'], binaries: ['gopls'], extensionToLanguage: { '.go': 'go' }, rootMarkers: ['go.mod', 'go.work'], remedy: 'go install golang.org/x/tools/gopls@latest' },
  { id: 'zls', label: 'zls (Zig)', languages: ['zig'], binaries: ['zls'], extensionToLanguage: { '.zig': 'zig' }, rootMarkers: ['build.zig'], remedy: 'brew install zls (or download from github.com/zigtools/zls)', remedyWin32: 'download the prebuilt zls.exe from zigtools.org/zls/install and put it on PATH' },
  { id: 'jdtls', label: 'Eclipse JDT LS', languages: ['java'], binaries: ['jdtls'], extensionToLanguage: { '.java': 'java' }, rootMarkers: ['pom.xml', 'build.gradle', 'build.gradle.kts', '.classpath'], remedy: 'brew install jdtls (or download from eclipse.org/jdtls)', remedyWin32: 'download a milestone build from download.eclipse.org/jdtls/milestones and put its bin folder (jdtls.bat) on PATH (needs Java 21 and Python 3.9)' },
  { id: 'kotlin-language-server', label: 'Kotlin LS', languages: ['kotlin'], binaries: ['kotlin-language-server'], extensionToLanguage: { '.kt': 'kotlin', '.kts': 'kotlin' }, rootMarkers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], remedy: 'brew install kotlin-language-server', remedyWin32: 'download the release zip from github.com/fwcd/kotlin-language-server/releases and put its bin folder (kotlin-language-server.bat) on PATH' },
  { id: 'csharp', label: 'C# LS', languages: ['c-sharp'], binaries: ['csharp-ls', 'OmniSharp'], extensionToLanguage: { '.cs': 'csharp' }, rootMarkers: ['*.sln', '*.csproj'], remedy: 'dotnet tool install --global csharp-ls' },
  { id: 'sourcekit-lsp', label: 'SourceKit-LSP', languages: ['swift'], binaries: ['sourcekit-lsp'], extensionToLanguage: { '.swift': 'swift' }, rootMarkers: ['Package.swift', '*.xcodeproj'], remedy: 'ships with Xcode/Swift toolchains (xcrun sourcekit-lsp)', remedyWin32: 'ships with the Swift toolchain for Windows (winget install --id Swift.Toolchain -e --source winget; swift.org/install/windows)' },
  { id: 'ruby-lsp', label: 'Ruby LSP', languages: ['ruby'], binaries: ['ruby-lsp', 'solargraph'], args: [], extensionToLanguage: { '.rb': 'ruby', '.rake': 'ruby' }, rootMarkers: ['Gemfile'], remedy: 'gem install ruby-lsp' },
  { id: 'intelephense', label: 'Intelephense (PHP)', languages: ['php'], binaries: ['intelephense'], args: ['--stdio'], extensionToLanguage: { '.php': 'php' }, rootMarkers: ['composer.json'], remedy: 'npm i -g intelephense' },
  { id: 'lua-language-server', label: 'Lua LS', languages: ['lua'], binaries: ['lua-language-server'], extensionToLanguage: { '.lua': 'lua' }, rootMarkers: ['.luarc.json', 'init.lua'], remedy: 'brew install lua-language-server', remedyWin32: 'scoop install lua-language-server' },
  { id: 'bash-language-server', label: 'Bash LS', languages: ['bash'], binaries: ['bash-language-server'], args: ['start'], extensionToLanguage: { '.sh': 'shellscript', '.bash': 'shellscript' }, rootMarkers: [], remedy: 'npm i -g bash-language-server' },
  { id: 'yaml-language-server', label: 'YAML LS', languages: ['yaml'], binaries: ['yaml-language-server'], args: ['--stdio'], extensionToLanguage: { '.yaml': 'yaml', '.yml': 'yaml' }, rootMarkers: [], remedy: 'npm i -g yaml-language-server' },
  { id: 'marksman', label: 'Marksman (Markdown)', languages: ['markdown'], binaries: ['marksman'], args: ['server'], extensionToLanguage: { '.md': 'markdown' }, rootMarkers: [], remedy: 'brew install marksman', remedyWin32: 'download marksman-windows.exe from github.com/artempyanykh/marksman/releases, rename it marksman.exe and put it on PATH' },
  { id: 'terraform-ls', label: 'Terraform LS', languages: ['terraform', 'hcl'], binaries: ['terraform-ls'], args: ['serve'], extensionToLanguage: { '.tf': 'terraform', '.tfvars': 'terraform-vars' }, rootMarkers: ['*.tf'], remedy: 'brew install hashicorp/tap/terraform-ls', remedyWin32: 'download the windows zip from releases.hashicorp.com/terraform-ls and put terraform-ls.exe on PATH' },
  { id: 'docker-langserver', label: 'Dockerfile LS', languages: ['dockerfile'], binaries: ['docker-langserver'], args: ['--stdio'], extensionToLanguage: { '.dockerfile': 'dockerfile' }, rootMarkers: ['Dockerfile'], remedy: 'npm i -g dockerfile-language-server-nodejs' },
  { id: 'elixir-ls', label: 'Elixir LS', languages: ['elixir'], binaries: ['elixir-ls', 'language_server.sh', 'language_server'], extensionToLanguage: { '.ex': 'elixir', '.exs': 'elixir' }, rootMarkers: ['mix.exs'], remedy: 'brew install elixir-ls', remedyWin32: 'download the release zip from github.com/elixir-lsp/elixir-ls/releases and put its folder (language_server.bat) on PATH' },
  { id: 'helm-ls', label: 'Helm LS', languages: ['helm'], binaries: ['helm_ls'], args: ['serve'], extensionToLanguage: { '.tpl': 'helm' }, rootMarkers: ['Chart.yaml'], remedy: 'brew install helm-ls', remedyWin32: 'scoop install extras/helm-ls (or add the bucket first: scoop bucket add extras)' },
  { id: 'vue', label: 'Vue LS', languages: ['vue'], binaries: ['vue-language-server', 'vls'], args: ['--stdio'], extensionToLanguage: { '.vue': 'vue' }, rootMarkers: ['package.json'], remedy: 'npm i -g @vue/language-server' },
  { id: 'svelte', label: 'Svelte LS', languages: ['svelte'], binaries: ['svelteserver'], args: ['--stdio'], extensionToLanguage: { '.svelte': 'svelte' }, rootMarkers: ['package.json'], remedy: 'npm i -g svelte-language-server' },
  { id: 'astro', label: 'Astro LS', languages: ['astro'], binaries: ['astro-ls'], args: ['--stdio'], extensionToLanguage: { '.astro': 'astro' }, rootMarkers: ['package.json'], remedy: 'npm i -g @astrojs/language-server' },
  { id: 'tailwind', label: 'Tailwind CSS LS', languages: ['tailwindcss'], binaries: ['tailwindcss-language-server'], args: ['--stdio'], extensionToLanguage: { '.css': 'css' }, rootMarkers: ['tailwind.config.js', 'tailwind.config.ts'], remedy: 'npm i -g @tailwindcss/language-server' },
  { id: 'powershell-editor-services', label: 'PowerShell Editor Services', languages: ['powershell'], binaries: ['pwsh'], args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "Import-Module PowerShellEditorServices; Start-EditorServices -Stdio -HostName mercury -HostProfileId mercury -HostVersion 1.0.0 -BundledModulesPath (Split-Path (Get-Module PowerShellEditorServices).ModuleBase -Parent) -LogPath ([System.IO.Path]::GetTempPath()) -SessionDetailsPath (Join-Path ([System.IO.Path]::GetTempPath()) 'mercury-powershell-editor-services.json')"], extensionToLanguage: { '.ps1': 'powershell', '.psm1': 'powershell', '.psd1': 'powershell' }, rootMarkers: ['*.ps1', '*.psm1', '*.psd1'], remedy: 'download the PowerShellEditorServices release zip (github.com/PowerShell/PowerShellEditorServices/releases) and unpack it into a folder on PSModulePath (requires PowerShell 7 / pwsh)' },
  { id: 'haskell-language-server', label: 'Haskell LS', languages: ['haskell'], binaries: ['haskell-language-server-wrapper', 'haskell-language-server'], args: ['--lsp'], extensionToLanguage: { '.hs': 'haskell', '.lhs': 'haskell' }, rootMarkers: ['stack.yaml', 'cabal.project', 'hie.yaml', 'package.yaml', '*.cabal'], remedy: 'ghcup install hls' },
  { id: 'ocamllsp', label: 'OCaml LSP', languages: ['ocaml'], binaries: ['ocamllsp'], extensionToLanguage: { '.ml': 'ocaml', '.mli': 'ocaml.interface' }, rootMarkers: ['dune-project', 'dune-workspace', '*.opam'], remedy: 'opam install ocaml-lsp-server' },
  { id: 'metals', label: 'Metals (Scala)', languages: ['scala'], binaries: ['metals'], extensionToLanguage: { '.scala': 'scala', '.sc': 'scala', '.sbt': 'scala' }, rootMarkers: ['build.sbt', 'build.sc', 'build.mill', '.scala-build'], remedy: 'cs install metals (or brew install coursier/formulas/coursier)', remedyWin32: 'cs install metals (or the Windows installer at get-coursier.io/docs/cli-installation)' },
  { id: 'nil', label: 'nil (Nix)', languages: ['nix'], binaries: ['nil'], extensionToLanguage: { '.nix': 'nix' }, rootMarkers: ['flake.nix', 'default.nix', 'shell.nix'], remedy: 'nix profile install nixpkgs#nil', remedyWin32: 'see github.com/oxalica/nil — no Windows install command documented (nix runs on Windows under WSL)' },
  { id: 'dart', label: 'Dart analysis server', languages: ['dart'], binaries: ['dart'], args: ['language-server', '--protocol=lsp'], extensionToLanguage: { '.dart': 'dart' }, rootMarkers: ['pubspec.yaml'], remedy: 'ships with the Dart SDK (dart.dev/get-dart) and Flutter (docs.flutter.dev/get-started)' },
  { id: 'gleam', label: 'Gleam LS', languages: ['gleam'], binaries: ['gleam'], args: ['lsp'], extensionToLanguage: { '.gleam': 'gleam' }, rootMarkers: ['gleam.toml'], remedy: 'brew install gleam (or gleam.run/getting-started/installing)', remedyWin32: 'winget install --id Gleam.Gleam (or scoop install main/gleam)' },
  { id: 'prisma-language-server', label: 'Prisma LS', languages: ['prisma'], binaries: ['prisma-language-server'], args: ['--stdio'], extensionToLanguage: { '.prisma': 'prisma' }, rootMarkers: ['schema.prisma', 'prisma'], remedy: 'npm i -g @prisma/language-server' },
  { id: 'clojure-lsp', label: 'Clojure LSP', languages: ['clojure'], binaries: ['clojure-lsp'], extensionToLanguage: { '.clj': 'clojure', '.cljs': 'clojure', '.cljc': 'clojure', '.edn': 'clojure' }, rootMarkers: ['deps.edn', 'project.clj', 'shadow-cljs.edn', 'bb.edn'], remedy: 'brew install clojure-lsp/brew/clojure-lsp-native', remedyWin32: 'scoop install clojure-lsp (or add the bucket first: scoop bucket add scoop-clojure https://github.com/littleli/scoop-clojure)' },
  { id: 'julia-language-server', label: 'Julia LS', languages: ['julia'], binaries: ['julia'], args: ['--startup-file=no', '--history-file=no', '-e', 'using LanguageServer; runserver()'], extensionToLanguage: { '.jl': 'julia' }, rootMarkers: ['Project.toml', 'JuliaProject.toml'], remedy: 'use julia -e \'using Pkg; Pkg.add("LanguageServer")\' (from the Julia SDK at julialang.org/downloads)' },
  { id: 'kotlin-lsp', label: 'Kotlin LSP', languages: ['kotlin'], binaries: ['kotlin-lsp'], args: ['--stdio'], extensionToLanguage: { '.kt': 'kotlin', '.kts': 'kotlin' }, rootMarkers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], remedy: 'brew install JetBrains/utils/kotlin-lsp (or the Kotlin/kotlin-lsp release zip)', remedyWin32: 'download the standalone zip from github.com/Kotlin/kotlin-lsp/releases and put its folder (kotlin-lsp.cmd) on PATH' },
  { id: 'phpactor', label: 'Phpactor (PHP)', languages: ['php'], binaries: ['phpactor'], args: ['language-server'], extensionToLanguage: { '.php': 'php' }, rootMarkers: ['composer.json'], remedy: 'brew install phpactor (or the phpactor.phar release)', remedyWin32: 'see phpactor.readthedocs.io — no Windows install command documented (Windows users need WSL)' },
  { id: 'expert', label: 'Expert (Elixir)', languages: ['elixir'], binaries: ['expert'], args: ['--stdio'], extensionToLanguage: { '.ex': 'elixir', '.exs': 'elixir' }, rootMarkers: ['mix.exs'], remedy: 'download the expert binary for your platform from github.com/elixir-lang/expert/releases and put it on PATH' },
]

interface CatalogueProbe {
  entry: CatalogueEntry
  binaryPath?: string
  binarySource?: 'project-local' | 'path'
  rootMatched: boolean
}

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
      const suffix = marker.slice(1)
      if (cwdEntries.some(e => e.endsWith(suffix))) return true
    } else if (cwdEntries.includes(marker)) {
      return true
    }
  }
  return false
}

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

export function catalogueServerConfigs(): Record<string, ScopedLspServerConfig> {
  if (!mercuryLspEnabled()) return {}
  const cwd = getCwd()
  const cwdEntries = listCwdEntries(cwd)
  const out: Record<string, ScopedLspServerConfig> = {}
  for (const entry of SERVER_CATALOGUE) {
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
      remedy: remedyFor(entry),
      source: 'serverCatalogue probe',
      lastCheckedAt: at,
    }
  })
}
