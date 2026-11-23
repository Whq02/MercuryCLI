import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from './support.ts'

const DEPARTED_DEPENDENCIES: Record<string, string> = {
  '@anthropic-ai/sdk': resolve(import.meta.dir, 'base-stubs/anthropic-sdk.ts'),
  '@anthropic-ai/sdk/error': resolve(import.meta.dir, 'base-stubs/anthropic-sdk.ts'),
  '@anthropic-ai/sandbox-runtime': resolve(import.meta.dir, 'base-stubs/sandbox-runtime.ts'),
}
const BASE_LAYOUT: Record<string, string> = {
  'platform/native/color-diff/index.ts': 'native-ts/color-diff/index.ts',
  'screen/renderer/root.js': 'ink/root.js',
  'screen/renderer/elements/Box.js': 'ink/components/Box.js',
  'screen/renderer/elements/Text.js': 'ink/components/Text.js',
  'screen/renderer/elements/AlternateScreen.js': 'ink/components/AlternateScreen.js',
  'screen/renderer/bindings/use-input.js': 'ink/hooks/use-input.js',
  'screen/renderer/bindings/use-app.js': 'ink/hooks/use-app.js',
}

export async function buildScene(sourceRoot: string, outdir: string, entry = 'scripts/engine-pass/scene.tsx'): Promise<string> {
  const src = resolve(sourceRoot, 'src')
  const pkg = JSON.parse(readFileSync(resolve(sourceRoot, 'package.json'), 'utf8'))
  const repo = (pkg.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')
  const probe = (base: string): string | null => {
    const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']
    for (const file of [base, ...extensions.map(ext => stem + ext), ...extensions.map(ext => `${stem}/index${ext}`)]) {
      try { if (statSync(file).isFile()) return file } catch {}
    }
    return null
  }
  const placed = (path: string): string | null => probe(resolve(src, path)) ?? (BASE_LAYOUT[path] === undefined ? null : probe(resolve(src, BASE_LAYOUT[path])))
  mkdirSync(outdir, { recursive: true })
  const result = await Bun.build({
    entrypoints: [resolve(ROOT, entry)],
    outdir, naming: 'scene.mjs', target: 'node', format: 'esm',
    define: {
      MACRO: JSON.stringify({ VERSION: pkg.version, PACKAGE_URL: repo, NATIVE_PACKAGE_URL: `${repo}/releases`, FEEDBACK_CHANNEL: '/feedback', BUILD_TIME: 'frame-cost', VERSION_CHANGELOG: '', ISSUES_EXPLAINER: 'report the issue with /feedback' }),
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
    plugins: [{
      name: 'scene-product-resolves',
      setup(build) {
        build.onResolve({ filter: /^(src\/|\.\.\/\.\.\/src\/)/ }, args => {
          const found = placed(args.path.replace(/^(src\/|\.\.\/\.\.\/src\/)/, ''))
          return found ? { path: found } : undefined
        })
        build.onResolve({ filter: /^color-diff-napi$/ }, () => ({ path: placed('platform/native/color-diff/index.ts') ?? resolve(src, 'platform/native/color-diff/index.ts') }))
        build.onResolve({ filter: /^@anthropic-ai\/(?:sdk|sdk\/error|sandbox-runtime)$/ }, args => ({ path: DEPARTED_DEPENDENCIES[args.path]! }))
        build.onResolve({ filter: /\.node$/ }, args => ({ path: args.path, external: true }))
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: resolve(ROOT, 'node_modules/jsonc-parser/lib/esm/main.js') }))
      },
    }],
  })
  if (!result.success) throw new Error(result.logs.map(String).join('\n'))
  return resolve(outdir, 'scene.mjs')
}
