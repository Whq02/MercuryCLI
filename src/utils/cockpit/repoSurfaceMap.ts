/* ============================================================================
 *  repoSurfaceMap — fast onboarding for a NEW repo (the ROADMAP's last
 *  un-built north-star cell, shipped).
 *
 *  What: a deterministic, API-free scan of a repository that derives a compact
 *  SURFACE MAP — languages, package topology, entry points, scripts, tests,
 *  docs, CI/config markers — so a session landing cold in an unmapped repo
 *  orients in one read instead of a dozen exploratory tool calls.
 *
 *  Where it surfaces:
 *   - the `repo_surface_map` attachment (utils/attachments.ts): injected ONCE,
 *     first turn, interactive main thread, and ONLY when the repo carries no
 *     orientation doc — MERCURY.md, AGENTS.md, or a CLAUDE.md (a mapped repo
 *     already orients faster than any auto-scan);
 *   - the /orient command: operator-invoked, always regenerates, works
 *     regardless of orientation-doc presence.
 *
 *  Discipline:
 *   - STRUCTURE-ONLY BY CONSTRUCTION (the shape-only-digest lesson): the map
 *     contains paths, names, counts, and extension stats. The only file
 *     CONTENT ever read is package-manifest metadata (name / bin / script
 *     NAMES) and the README's first heading line. No file bodies, no env
 *     values, no script bodies — so there is nothing to secret-scan.
 *   - BOUNDED: depth ≤ MAX_DEPTH, visited entries ≤ MAX_ENTRIES, fixed
 *     skip-list for dependency/build trees. A million-file monorepo costs the
 *     same as a small repo (the walk stops at the cap and says so).
 *   - DETERMINISTIC: directory entries are sorted before descent; two scans
 *     of the same tree yield byte-identical maps (proof-locked).
 *
 *  Gate: MERCURY_ONBOARDING (default-on, additive tier). `=0` ⇒ no scan, no
 *  attachment, /orient hidden — byte-identical.
 * ========================================================================= */

import { closeSync, lstatSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function repoSurfaceMapEnabled(): boolean {
  if (flagEnv('MERCURY_ONBOARDING') === '0') return false
  return true
}

const MAX_DEPTH = 5
const MAX_ENTRIES = 4000
const MAX_MAP_CHARS = 3000

// Dependency/build/VCS trees — never descended (both cost and noise).
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'target',
  'vendor', 'venv', '.venv', '__pycache__', '.cache', 'coverage', '.turbo',
  '.parcel-cache', '.gradle', '.idea', '.vscode', 'Pods', 'DerivedData',
])

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.java': 'Java',
  '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C/C++ header', '.cc': 'C++',
  '.cpp': 'C++', '.hpp': 'C++', '.cs': 'C#', '.php': 'PHP', '.ex': 'Elixir',
  '.exs': 'Elixir', '.erl': 'Erlang', '.hs': 'Haskell', '.ml': 'OCaml',
  '.scala': 'Scala', '.zig': 'Zig', '.lua': 'Lua', '.sh': 'Shell', '.bash': 'Shell',
  '.sql': 'SQL', '.tf': 'Terraform', '.proto': 'Protobuf', '.sol': 'Solidity',
  '.vue': 'Vue', '.svelte': 'Svelte', '.dart': 'Dart', '.r': 'R', '.jl': 'Julia',
}

// Root-level marker files → what they tell us. Names only; contents untouched
// except the two manifest reads below.
const MARKERS: Array<[string, string]> = [
  ['package.json', 'Node package'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
  ['deno.json', 'Deno'],
  ['pyproject.toml', 'Python project'],
  ['requirements.txt', 'Python requirements'],
  ['setup.py', 'Python setup.py'],
  ['Pipfile', 'pipenv'], ['poetry.lock', 'poetry'], ['uv.lock', 'uv'],
  ['go.mod', 'Go module'],
  ['Cargo.toml', 'Rust crate'],
  ['Gemfile', 'Ruby bundler'],
  ['pom.xml', 'Maven'], ['build.gradle', 'Gradle'], ['build.gradle.kts', 'Gradle'],
  ['CMakeLists.txt', 'CMake'], ['Makefile', 'Make'], ['justfile', 'just'],
  ['Dockerfile', 'Docker'], ['docker-compose.yml', 'docker-compose'],
  ['docker-compose.yaml', 'docker-compose'],
  ['flake.nix', 'Nix flake'], ['shell.nix', 'Nix shell'],
  ['tsconfig.json', 'TypeScript config'],
  ['.eslintrc.json', 'ESLint'], ['eslint.config.js', 'ESLint'], ['eslint.config.mjs', 'ESLint'],
  ['vite.config.ts', 'Vite'], ['next.config.js', 'Next.js'], ['next.config.ts', 'Next.js'],
  ['turbo.json', 'Turborepo'], ['nx.json', 'Nx'], ['lerna.json', 'Lerna'],
]

const TEST_DIR_NAMES = new Set(['test', 'tests', '__tests__', 'spec', 'e2e', 'integration'])
const DOC_FILES = ['README.md', 'README.rst', 'README.txt', 'README', 'CONTRIBUTING.md', 'ARCHITECTURE.md', 'CLAUDE.md', 'AGENTS.md']

interface ScanState {
  visited: number
  truncated: boolean
  extCounts: Map<string, number>
  testFiles: number
  testDirs: Set<string>
}

function walk(dir: string, depth: number, state: ScanState, inTestTree: boolean): void {
  if (depth > MAX_DEPTH || state.visited >= MAX_ENTRIES) {
    if (state.visited >= MAX_ENTRIES) state.truncated = true
    return
  }
  let entries: string[]
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return
  }
  for (const name of entries) {
    if (state.visited >= MAX_ENTRIES) { state.truncated = true; return }
    if (name.startsWith('.') && name !== '.github') continue
    const p = join(dir, name)
    let st
    try {
      // lstat, and skip symlinks outright: following a link can walk OUTSIDE
      // the repo (a link into $HOME would fold a foreign tree's shape into the
      // map) — the walk must stay inside the root by construction.
      st = lstatSync(p)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) continue
    state.visited++
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      const isTest = TEST_DIR_NAMES.has(name.toLowerCase())
      if (isTest) state.testDirs.add(name)
      walk(p, depth + 1, state, inTestTree || isTest)
    } else {
      const dot = name.lastIndexOf('.')
      const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
      if (ext) state.extCounts.set(ext, (state.extCounts.get(ext) ?? 0) + 1)
      if (inTestTree || /\.(test|spec)\.[a-z]+$/.test(name) || /^test_.+\.py$/.test(name)) state.testFiles++
    }
  }
}

/** Bounded head read (the splash's readHead class):
 *  readFileSync().slice() reads + decodes the WHOLE file to keep the head; a
 *  badge-heavy multi-hundred-KB README paid its full size for one heading. */
function readHeadBytes(file: string, n: number): string {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(n)
    let got = 0
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, got)
      if (r <= 0) break
      got += r
    }
    return buf.subarray(0, got).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** First `# heading` (or first non-empty line) of the README — the repo's
 *  public title. The one content read besides manifests; capped hard. */
function readmeHeadline(root: string): string | null {
  for (const f of ['README.md', 'README.rst', 'README.txt', 'README']) {
    try {
      const text = readHeadBytes(join(root, f), 4000)
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        return line.replace(/^#+\s*/, '').slice(0, 100)
      }
    } catch {
      /* next */
    }
  }
  return null
}

export interface PkgFacts {
  name?: string
  bin?: string[]
  scripts?: string[]
  workspaces?: boolean
}

function packageFacts(root: string): PkgFacts | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      name?: unknown
      bin?: unknown
      scripts?: unknown
      workspaces?: unknown
    }
    const facts: PkgFacts = {}
    if (typeof pkg.name === 'string') facts.name = pkg.name.slice(0, 80)
    if (typeof pkg.bin === 'string') facts.bin = ['(default)']
    else if (pkg.bin && typeof pkg.bin === 'object') facts.bin = Object.keys(pkg.bin).slice(0, 6)
    if (pkg.scripts && typeof pkg.scripts === 'object') facts.scripts = Object.keys(pkg.scripts).slice(0, 12)
    facts.workspaces = Array.isArray(pkg.workspaces) || (typeof pkg.workspaces === 'object' && pkg.workspaces !== null)
    return facts
  } catch {
    return null
  }
}

/** Per-root memo for the orientation-doc probe: the attachment gate runs
 *  this FIRST on every tool round, and on an unmapped repo (the exact case
 *  the feature targets) it paid three event-loop-blocking stats per round
 *  for the whole session. Once-per-process is the deliberate grain — the
 *  injection is once-per-session anyway (the transcript check), so a doc
 *  created mid-session costs at most one extra map nobody re-injects, and
 *  a doc deleted mid-session was already mapped. */
const orientationDocMemo = new Map<string, boolean>()

/** Does the repo already carry an orientation doc (MERCURY.md, AGENTS.md,
 *  or a CLAUDE.md)? Existence only — the map never loads their content. */
export function hasOrientationDoc(root: string): boolean {
  const memoized = orientationDocMemo.get(root)
  if (memoized !== undefined) return memoized
  let found = false
  for (const name of ['MERCURY.md', 'AGENTS.md', 'CLAUDE.md']) {
    try {
      statSync(join(root, name))
      found = true
      break
    } catch {
      // keep looking
    }
  }
  orientationDocMemo.set(root, found)
  return found
}

/** The structured result of one bounded surface scan — the SAME walk that
 *  backs the markdown map, exposed as facts so higher layers (the project
 *  snapshot) compose this owner instead of re-walking the tree.
 *  Structure-only discipline unchanged: names, counts, extension stats. */
export interface RepoSurfaceFacts {
  headline: string | null
  pkg: PkgFacts | null
  topDirs: string[]
  /** Top languages by file count, descending, ≤5. */
  topLangs: Array<[string, number]>
  /** Deduped stack-marker labels, MARKERS order. */
  markerLabels: string[]
  /** The marker FILES present at root, MARKERS order. */
  markerFiles: string[]
  docs: string[]
  ci: number
  testFiles: number
  /** Sorted test-directory names. */
  testDirs: string[]
  visited: number
  truncated: boolean
}

/** Run the bounded scan for `root`. Returns null for a tree with nothing to
 *  say (no files at all) — callers treat null as "skip". Never throws. */
/** Home-shape markers: a root carrying two or more of these is an OS home
 *  (or a home-like profile dir), not a project — orientation means nothing
 *  there and the walk costs seconds on an HDD. */
const HOME_SHAPE_MARKERS = ['Desktop', 'Documents', 'Downloads', 'Library', 'AppData']

/** Boot-cost guard: the scan is a
 *  REPO orientation aid — never walk the home directory or a home-shaped
 *  root at boot. */
export function isHomeShapedRoot(root: string): boolean {
  try {
    if (resolve(root) === resolve(homedir())) return true
  } catch {
    /* fall through to the marker check */
  }
  try {
    const entries = new Set(readdirSync(root))
    let markers = 0
    for (const m of HOME_SHAPE_MARKERS) if (entries.has(m)) markers++
    return markers >= 2
  } catch {
    return false
  }
}

export function scanRepoSurface(root: string): RepoSurfaceFacts | null {
  if (isHomeShapedRoot(root)) return null
  try {
    const state: ScanState = {
      visited: 0,
      truncated: false,
      extCounts: new Map(),
      testFiles: 0,
      testDirs: new Set(),
    }

    // Top-level shape first (sorted for determinism).
    let topEntries: string[]
    try {
      topEntries = readdirSync(root).sort()
    } catch {
      return null
    }
    const topDirs: string[] = []
    for (const name of topEntries) {
      if (name.startsWith('.') && name !== '.github') continue
      if (SKIP_DIRS.has(name)) continue
      try {
        if (statSync(join(root, name)).isDirectory()) topDirs.push(name)
      } catch {
        /* skip */
      }
    }

    walk(root, 0, state, false)
    if (state.visited === 0) return null

    // Language histogram → top languages by file count.
    const langCounts = new Map<string, number>()
    for (const [ext, n] of state.extCounts) {
      const lang = LANG_BY_EXT[ext]
      if (lang) langCounts.set(lang, (langCounts.get(lang) ?? 0) + n)
    }
    const topLangs = [...langCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)

    const markers = MARKERS.filter(([f]) => {
      try {
        statSync(join(root, f))
        return true
      } catch {
        return false
      }
    })

    const docs = DOC_FILES.filter(f => {
      try {
        statSync(join(root, f))
        return true
      } catch {
        return false
      }
    })

    let ci = 0
    try {
      ci = readdirSync(join(root, '.github', 'workflows')).filter(f => /\.ya?ml$/.test(f)).length
    } catch {
      /* none */
    }

    return {
      headline: readmeHeadline(root),
      pkg: packageFacts(root),
      topDirs,
      topLangs,
      markerLabels: [...new Set(markers.map(([, w]) => w))],
      markerFiles: markers.map(([f]) => f),
      docs,
      ci,
      testFiles: state.testFiles,
      testDirs: [...state.testDirs].sort(),
      visited: state.visited,
      truncated: state.truncated,
    }
  } catch {
    return null
  }
}

/** Render the markdown surface map from scanned facts. Pure. */
export function renderRepoSurfaceMap(facts: RepoSurfaceFacts): string {
  const lines: string[] = []
  lines.push(`# Repo surface map`)
  if (facts.headline) lines.push(`> ${facts.headline}`)
  lines.push('')
  if (facts.pkg?.name)
    lines.push(`- **package**: ${facts.pkg.name}${facts.pkg.workspaces ? ' (workspaces monorepo)' : ''}`)
  if (facts.topLangs.length > 0)
    lines.push(`- **languages**: ${facts.topLangs.map(([l, n]) => `${l} (${n})`).join(' · ')}`)
  if (facts.markerLabels.length > 0)
    lines.push(`- **stack markers**: ${facts.markerLabels.join(' · ')}`)
  if (facts.pkg?.bin && facts.pkg.bin.length > 0) lines.push(`- **bin**: ${facts.pkg.bin.join(' · ')}`)
  if (facts.pkg?.scripts && facts.pkg.scripts.length > 0)
    lines.push(`- **scripts**: ${facts.pkg.scripts.join(' · ')}`)
  if (facts.topDirs.length > 0)
    lines.push(`- **top-level dirs**: ${facts.topDirs.slice(0, 16).join(' · ')}`)
  if (facts.testFiles > 0 || facts.testDirs.length > 0)
    lines.push(`- **tests**: ~${facts.testFiles} test files${facts.testDirs.length ? ` (dirs: ${facts.testDirs.join(', ')})` : ''}`)
  if (facts.ci > 0) lines.push(`- **CI**: ${facts.ci} GitHub workflow${facts.ci === 1 ? '' : 's'}`)
  if (facts.docs.length > 0) lines.push(`- **docs present**: ${facts.docs.join(' · ')}`)
  lines.push('')
  lines.push(
    `_${facts.visited} entries scanned${facts.truncated ? ` (CAPPED at ${MAX_ENTRIES} — large repo, map is partial)` : ''}, depth ≤ ${MAX_DEPTH}. Structure only — no file contents. Regenerate: /orient_`,
  )

  const md = lines.join('\n')
  return md.length > MAX_MAP_CHARS ? md.slice(0, MAX_MAP_CHARS - 1) + '…' : md
}

/** Build the surface map for `root` (= render ∘ scan; byte-identical to the
 *  pre-split builder). Returns null for a tree with nothing to say. */
export function buildRepoSurfaceMap(root: string): string | null {
  const facts = scanRepoSurface(root)
  return facts ? renderRepoSurfaceMap(facts) : null
}
