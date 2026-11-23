import { posix, sep } from 'node:path'

const GENERATED_FILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'shrinkwrap.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
  'Package.resolved',
  'Podfile.lock',
  'pubspec.lock',
  'mix.lock',
  'uv.lock',
  'pdm.lock',
])

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

const GENERATED_EXTENSIONS = new Set([
  '.map',
  '.pyc',
  '.pyo',
  '.class',
  '.o',
  '.obj',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.wasm',
  '.tsbuildinfo',
  '.lock',
  '.lockb',
  '.snap',
])

const GENERATED_NAME_PATTERNS: readonly RegExp[] = [
  /\.min\.(?:js|mjs|cjs|css)$/i,
  /\.bundle\.(?:js|mjs|cjs|css)$/i,
  /\.chunk\.(?:js|mjs|cjs|css)$/i,
  /\.pb\.(?:go|ts|js|py|cc|h|java|rb|cs)$/i,
  /_pb2\.py$/i,
  /\.generated\.[^/]+$/i,
  /\.g\.(?:dart|cs)$/i,
  /\.freezed\.dart$/i,
  /\.designer\.cs$/i,
]

export function isGeneratedFile(filePath: string): boolean {
  const slashPath = (sep === '/' ? filePath : filePath.split(sep).join('/')).replaceAll('\\', '/')
  const normalized = posix.normalize(slashPath).replace(/^\.\//, '')
  const base = posix.basename(normalized)
  if (GENERATED_FILE_NAMES.has(base)) return true
  const lowerNormalized = normalized.toLowerCase()
  for (const dir of GENERATED_DIRECTORIES) {
    if (
      lowerNormalized === dir ||
      lowerNormalized.startsWith(`${dir}/`) ||
      lowerNormalized.includes(`/${dir}/`)
    ) {
      return true
    }
  }
  const ext = posix.extname(base).toLowerCase()
  if (ext !== '' && GENERATED_EXTENSIONS.has(ext)) return true
  for (const pattern of GENERATED_NAME_PATTERNS) {
    if (pattern.test(base)) return true
  }
  return false
}
