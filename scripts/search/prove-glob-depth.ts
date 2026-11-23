import assert from 'node:assert/strict'
import { globSearchDepth, normalizeGlobPattern, splitGrepGlobField } from '../../src/tools/glob/globPattern.ts'

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
  assert.equal(globSearchDepth(patterns), expected, `${JSON.stringify(patterns)}: globSearchDepth in src/tools/glob/globPattern.ts returned a different depth than the table row expects; fix its brace and wildcard counting there`)
}
assert.equal(globSearchDepth(splitGrepGlobField('src\\lib\\*.ts *.md', 'win32')), 3, 'splitGrepGlobField in src/tools/glob/globPattern.ts must split a space-separated win32 field and turn backslashes into slashes so globSearchDepth reads depth 3')
assert.equal(globSearchDepth([normalizeGlobPattern('src\\**\\*.ts', 'win32')]), undefined, 'normalizeGlobPattern in src/tools/glob/globPattern.ts must turn win32 backslashes into slashes so ** is seen and globSearchDepth returns undefined')
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
const { GrepTool } = await import('../../src/tools/grep/GrepTool.ts')
const { GlobTool } = await import('../../src/tools/glob/GlobTool.ts')
const { getEmptyToolPermissionContext } = await import('../../src/tools/kit/tool.ts')
const { runWithCwdOverride } = await import('../../src/platform/files/cwd.ts')
const context = { abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), alwaysDenyRules: { userSettings: ['Read(denied.ts)'] } } }) } as never
try {
  await runWithCwdOverride(root, async () => {
    for (const pattern of ['src/services', 'src/services/', 'src/{services,tools}', 'src/*']) {
      const grep = await GrepTool.call({ pattern: 'needle', path: root, glob: pattern }, context)
      const glob = await GlobTool.call({ pattern, path: root }, context)
      const grepPaths = grep.data.filenames.map(file => resolve(root, file))
      const globPaths = glob.data.filenames.map(file => resolve(root, file))
      assert.ok(grepPaths.includes(service), `Grep directory scope ${pattern}: ${grepPaths}; the glob handling in the call of src/tools/grep/GrepTool.ts must reach files under the named folder`)
      assert.ok(globPaths.includes(service), `Glob directory scope ${pattern}: ${globPaths}; the call of src/tools/glob/GlobTool.ts must list files under the named folder`)
      assert.ok(!grepPaths.includes(denied) && !globPaths.includes(denied), 'directory scopes retain read denies: the Read(denied.ts) deny rule must still filter results in the call of src/tools/grep/GrepTool.ts and src/tools/glob/GlobTool.ts')
      assert.ok(!grepPaths.some(file => file.endsWith('/.env')), 'directory scope does not read unnamed .env files: the .env guard in src/tools/grep/GrepTool.ts (envFileTargetsInGlob) must keep src/services/.env out unless the glob names it')
      if (pattern.includes('{') || pattern.includes('*')) assert.ok(grepPaths.includes(tool) && globPaths.includes(tool), `${pattern}: a wildcard or brace folder scope must reach src/tools/deep/tool.ts in both src/tools/grep/GrepTool.ts and src/tools/glob/GlobTool.ts (grep ${grepPaths}; glob ${globPaths})`)
    }
    const top = put('pkg/top.ts')
    const inner = put('pkg/inner/deep.ts')
    const mixedGrep = await GrepTool.call({ pattern: 'needle', path: root, glob: 'pkg/*' }, context)
    const mixedGlob = await GlobTool.call({ pattern: 'pkg/*', path: root }, context)
    assert.deepEqual(mixedGrep.data.filenames.map(file => resolve(root, file)).sort(), [inner, top].sort(), 'Grep glob pkg/* reaches the files inside its folders: the glob handling in the call of src/tools/grep/GrepTool.ts must search below the matched folders')
    assert.deepEqual(mixedGlob.data.filenames.map(file => resolve(root, file)), [top], 'Glob pkg/* still lists only the files directly in pkg: src/tools/glob/GlobTool.ts must not apply the Grep folder deepening to Glob')
    for (const pattern of ['src/app/[id]/page.tsx', 'src/app/[id]/*.tsx']) {
      const grep = await GrepTool.call({ pattern: 'needle|wrong route', path: root, glob: pattern }, context)
      const glob = await GlobTool.call({ pattern, path: root }, context)
      assert.deepEqual(grep.data.filenames.map(file => resolve(root, file)), [route], `Grep literal brackets: ${pattern}; src/tools/grep/GrepTool.ts must treat an existing bracket-named folder as a literal path`)
      assert.deepEqual(glob.data.filenames.map(file => resolve(root, file)), [route], `Glob literal brackets: ${pattern}; src/tools/glob/GlobTool.ts must treat an existing bracket-named folder as a literal path`)
    }
    const absolute = await GlobTool.call({ pattern: route }, context)
    assert.deepEqual(absolute.data.filenames.map(file => resolve(root, file)), [route], 'absolute bracket-bearing Glob pattern: src/tools/glob/GlobTool.ts must match an absolute pattern whose path exists literally')
    const named = await GrepTool.call({ pattern: 'needle', path: route }, context)
    assert.deepEqual(named.data.filenames.map(file => resolve(root, file)), [route], 'literal bracket-bearing Grep path: src/tools/grep/GrepTool.ts must search an existing path containing brackets as given')
    const classes = await GlobTool.call({ pattern: 'src/app/[di]/page.tsx', path: root }, context)
    assert.equal(classes.data.numFiles, 2, 'a nonexistent literal bracket path retains character-class matching: src/tools/glob/GlobTool.ts must fall back to character-class matching when the literal path does not exist')
  })
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log('glob depth and directory/bracket scopes: all checks passed')
