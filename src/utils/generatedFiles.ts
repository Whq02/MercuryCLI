import { posix } from 'node:path'
import { sep } from 'node:path'


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
  const normalized = '/' + filePath.split(sep).join('/')
  const fileName = posix.basename(normalized).toLowerCase()

  if (GENERATED_FILE_NAMES.has(fileName)) return true

  const segments = fileName.split('.')
  if (segments.length >= 2 && (segments[0] as string) !== '') {
    const simpleExtension = `.${segments[segments.length - 1]}`
    if (GENERATED_EXTENSIONS.has(simpleExtension)) return true
    if (segments.length >= 3) {
      const compoundExtension = `.${segments.slice(-2).join('.')}`
      if (GENERATED_EXTENSIONS.has(compoundExtension)) return true
    }
  }

  for (const directory of GENERATED_DIRECTORIES) {
    if (normalized.includes(`/${directory}/`)) return true
  }

  return GENERATED_NAME_PATTERNS.some(pattern => pattern.test(fileName))
}

export function filterGeneratedFiles(files: string[]): string[] {
  return files.filter(file => !isGeneratedFile(file))
}
