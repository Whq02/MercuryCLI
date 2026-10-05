import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { ROOT } from './support.ts'

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
          const found = probe(resolve(src, args.path.replace(/^(src\/|\.\.\/\.\.\/src\/)/, '')))
          return found ? { path: found } : undefined
        })
        build.onResolve({ filter: /^color-diff-napi$/ }, () => ({ path: resolve(src, 'native-ts/color-diff/index.ts') }))
        build.onResolve({ filter: /\.node$/ }, args => ({ path: args.path, external: true }))
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: resolve(ROOT, 'node_modules/jsonc-parser/lib/esm/main.js') }))
      },
    }],
  })
  if (!result.success) throw new Error(result.logs.map(String).join('\n'))
  return resolve(outdir, 'scene.mjs')
}
