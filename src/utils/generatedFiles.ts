import { posix, sep } from 'node:path'

const GENERATED_FILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'shrinkwrap.yaml',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'gemfile.lock',
  'poetry.lock',
  'pipfile.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
  'package.resolved',
  'podfile.lock',
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
  '.min.js',
  '.min.mjs',
  '.min.cjs',
  '.min.css',
  '.bundle.js',
  '.bundle.mjs',
  '.bundle.cjs',
  '.bundle.css',
  '.chunk.js',
  '.chunk.css',
  '.pb.go',
  '.pb.ts',
  '.pb.js',
  '.pb.py',
  '.pb.cc',
  '.pb.h',
  '.g.dart',
  '.g.cs',
  '.freezed.dart',
  '.designer.cs',
  '.generated.ts',
  '.generated.tsx',
  '.generated.js',
  '.generated.jsx',
  '.generated.go',
  '.generated.py',
  '.generated.cs',
  '.auto.ts',
  '.auto.js',
  '.auto.go',
  '.auto.py',
])

const GENERATED_NAME_PATTERNS: readonly RegExp[] = [
  /\.min\.[^/]+$/i,
  /\.bundle\.[^/]+$/i,
  /\.chunk\.[^/]+$/i,
  /\.pb\.[^/]+$/i,
  /_pb2(?:_grpc)?\.py$/i,
  /[._-]generated\.[^/]+$/i,
  /\.auto\.[^/]+$/i,
  /\.g\.(?:dart|cs)$/i,
  /\.freezed\.dart$/i,
  /\.designer\.cs$/i,
  /(?:^|[._-])(?:openapi|swagger)[._-].*$/i,
]

export function isGeneratedFile(filePath: string): boolean {
  const slashPath = (sep === '/' ? filePath : filePath.split(sep).join('/')).replaceAll('\\', '/')
  const normalized = posix.normalize(slashPath).replace(/^\.\//, '')
  const lowerBase = posix.basename(normalized).toLowerCase()
  if (GENERATED_FILE_NAMES.has(lowerBase)) return true
  for (const dir of GENERATED_DIRECTORIES) {
    if (normalized.startsWith(`${dir}/`) || normalized.includes(`/${dir}/`)) {
      return true
    }
  }
  const parts = lowerBase.split('.')
  if (parts.length >= 2 && parts[0] !== '') {
    const simpleExt = `.${parts[parts.length - 1]}`
    if (GENERATED_EXTENSIONS.has(simpleExt)) return true
    if (parts.length >= 3) {
      const twoPartExt = `.${parts[parts.length - 2]}.${parts[parts.length - 1]}`
      if (GENERATED_EXTENSIONS.has(twoPartExt)) return true
    }
  }
  for (const pattern of GENERATED_NAME_PATTERNS) {
    if (pattern.test(lowerBase)) return true
  }
  return false
}
