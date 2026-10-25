import assert from 'node:assert/strict'
import { globSearchDepth, normalizeGlobPattern, splitGrepGlobField } from '../../src/utils/globPattern.ts'

for (const [patterns, expected] of [
  [['*.ts'], 1],
  [['./*.ts'], 1],
  [['/README.md'], 1],
  [['src/*.ts'], 2],
  [['src/*/*.ts'], 3],
  [['src/{lib,tests/deep}/*.ts'], 4],
  [['{src/lib,tests}/*.ts'], 3],
  [['{src,{tests/unit,tests/integration}}/*.ts'], 3],
  [['*.ts', 'lib/*/*.js'], 3],
  [['*.ts', '!**/excluded/**'], 1],
  [['!*.ts'], undefined],
  [[], undefined],
  [['**/*.ts'], undefined],
  [['*.ts', 'lib/**/*.js'], undefined],
  [['a\\[1\\].ts'], 1],
] as const) {
  assert.equal(globSearchDepth(patterns), expected, JSON.stringify(patterns))
}
assert.equal(globSearchDepth(splitGrepGlobField('src\\lib\\*.ts *.md', 'win32')), 3)
assert.equal(globSearchDepth([normalizeGlobPattern('src\\**\\*.ts', 'win32')]), undefined)
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { dirname, join, resolve } = await import('node:path')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'glob-scopes-')))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'config')
const root = join(scratch, 'work')
const put = (file: string, body = 'needle\n') => { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); return path }
const service = put('src/services/deep/service.ts')
const tool = put('src/tools/deep/tool.ts')
const route = put('src/app/[id]/page.tsx')
put('src/app/i/page.tsx', 'wrong route\n')
put('src/app/d/page.tsx', 'wrong route\n')
const denied = put('src/services/deep/denied.ts')
put('src/services/.env', 'needle secret\n')
const { GrepTool } = await import('../../src/tools/GrepTool/GrepTool.ts')
const { GlobTool } = await import('../../src/tools/GlobTool/GlobTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
const { runWithCwdOverride } = await import('../../src/utils/cwd.ts')
const context = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), alwaysDenyRules: { userSettings: ['Read(denied.ts)'] } } }) } as never
try {
  await runWithCwdOverride(root, async () => {
    for (const pattern of ['src/services', 'src/services/', 'src/{services,tools}', 'src/*']) {
      const grep = await GrepTool.call({ pattern: 'needle', path: root, glob: pattern }, context)
      const glob = await GlobTool.call({ pattern, path: root }, context)
      const grepPaths = grep.data.filenames.map(file => resolve(root, file))
      const globPaths = glob.data.filenames.map(file => resolve(root, file))
      assert.ok(grepPaths.includes(service), `Grep directory scope ${pattern}: ${grepPaths}`)
      assert.ok(globPaths.includes(service), `Glob directory scope ${pattern}: ${globPaths}`)
      assert.ok(!grepPaths.includes(denied) && !globPaths.includes(denied), 'directory scopes retain read denies')
      assert.ok(!grepPaths.some(file => file.endsWith('/.env')), 'directory scope does not read unnamed .env files')
      if (pattern.includes('{') || pattern.includes('*')) assert.ok(grepPaths.includes(tool) && globPaths.includes(tool), pattern)
    }
    const top = put('pkg/top.ts')
    const inner = put('pkg/inner/deep.ts')
    const mixedGrep = await GrepTool.call({ pattern: 'needle', path: root, glob: 'pkg/*' }, context)
    const mixedGlob = await GlobTool.call({ pattern: 'pkg/*', path: root }, context)
    assert.deepEqual(mixedGrep.data.filenames.map(file => resolve(root, file)).sort(), [inner, top].sort(), 'Grep glob pkg/* reaches the files inside its folders')
    assert.deepEqual(mixedGlob.data.filenames.map(file => resolve(root, file)), [top], 'Glob pkg/* still lists only the files directly in pkg')
    for (const pattern of ['src/app/[id]/page.tsx', 'src/app/[id]/*.tsx']) {
      const grep = await GrepTool.call({ pattern: 'needle|wrong route', path: root, glob: pattern }, context)
      const glob = await GlobTool.call({ pattern, path: root }, context)
      assert.deepEqual(grep.data.filenames.map(file => resolve(root, file)), [route], `Grep literal brackets: ${pattern}`)
      assert.deepEqual(glob.data.filenames.map(file => resolve(root, file)), [route], `Glob literal brackets: ${pattern}`)
    }
    const absolute = await GlobTool.call({ pattern: route }, context)
    assert.deepEqual(absolute.data.filenames.map(file => resolve(root, file)), [route], 'absolute bracket-bearing Glob pattern')
    const named = await GrepTool.call({ pattern: 'needle', path: route }, context)
    assert.deepEqual(named.data.filenames.map(file => resolve(root, file)), [route], 'literal bracket-bearing Grep path')
    const classes = await GlobTool.call({ pattern: 'src/app/[di]/page.tsx', path: root }, context)
    assert.equal(classes.data.numFiles, 2, 'a nonexistent literal bracket path retains character-class matching')
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log('glob depth and directory/bracket scopes: all checks passed')
