import { posix } from 'node:path'
import { sep } from 'node:path'

/**
 * Linguist-style classifier for generated/vendored files, used to exclude
 * them from authorship attribution. The tables are the behaviour.
 */

const GENERATED_FILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  'bun.lock',
  'composer.lock',
  'gemfile.lock',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'shrinkwrap.json',
  'npm-shrinkwrap.json',
])

const GENERATED_EXTENSIONS = new Set([
  '.lock',
  '.min.js',
  '.min.css',
  '.min.html',
  '.bundle.js',
  '.bundle.css',
  '.generated.ts',
  '.generated.js',
  '.d.ts',
])

// Matched anywhere in the path with separators on both sides.
const GENERATED_DIRECTORIES = [
  'dist',
  'build',
  'out',
  'output',
  'node_modules',
  'vendor',
  'vendored',
  'third_party',
  'third-party',
  'external',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '__pycache__',
  '.tox',
  'venv',
  '.venv',
  'target/release',
  'target/debug',
]

// In every pattern the trailing `*` stands for LETTERS ONLY and runs to the
// end of the name — `app.min.js` matches, `app.min.js.map` does not.
const GENERATED_NAME_PATTERNS: RegExp[] = [
  /\.min\.[a-z]+$/,
  /-min\.[a-z]+$/,
  /\.bundle\.[a-z]+$/,
  /\.generated\.[a-z]+$/,
  /\.gen\.[a-z]+$/,
  /\.auto\.[a-z]+$/,
  /_generated\.[a-z]+$/,
  /_gen\.[a-z]+$/,
  /\.pb\.(go|js|ts|py|rb)$/,
  /_pb2?\.py$/,
  /\.pb\.h$/,
  /\.grpc\.[a-z]+$/,
  /\.swagger\.[a-z]+$/,
  /\.openapi\.[a-z]+$/,
]

export function isGeneratedFile(filePath: string): boolean {
  // Rewrite the PLATFORM separators to forward slashes (a backslash in a
  // name on a POSIX host is left alone) and prepend a leading slash for
  // the directory check.
  const normalized = '/' + filePath.split(sep).join('/')
  const fileName = posix.basename(normalized).toLowerCase()

  if (GENERATED_FILE_NAMES.has(fileName)) return true

  const segments = fileName.split('.')
  // Extensions require a NON-EMPTY stem: a dotfile whose entire name
  // equals an extension entry (a file literally named `.lock`) is not
  // extension-matched.
  if (segments.length >= 2 && (segments[0] as string) !== '') {
    const simpleExtension = `.${segments[segments.length - 1]}`
    if (GENERATED_EXTENSIONS.has(simpleExtension)) return true
    if (segments.length >= 3) {
      const compoundExtension = `.${segments.slice(-2).join('.')}`
      if (GENERATED_EXTENSIONS.has(compoundExtension)) return true
    }
  }

  // Directory-segment matching is CASE-SENSITIVE; only the basename
  // comparisons above are case-insensitive.
  for (const directory of GENERATED_DIRECTORIES) {
    if (normalized.includes(`/${directory}/`)) return true
  }

  return GENERATED_NAME_PATTERNS.some(pattern => pattern.test(fileName))
}

/** The non-generated subset of a list. */
export function filterGeneratedFiles(files: string[]): string[] {
  return files.filter(file => !isGeneratedFile(file))
}
