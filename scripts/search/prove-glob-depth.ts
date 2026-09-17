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
console.log('glob depth: 17 checks passed')
