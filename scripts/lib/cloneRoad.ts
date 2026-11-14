import { spawn, spawnSync } from 'node:child_process'
import { constants, copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function volumeClones(dir: string): boolean {
  const from = join(dir, `.clone-probe-${process.pid}-a`)
  const to = join(dir, `.clone-probe-${process.pid}-b`)
  try {
    writeFileSync(from, 'probe\n')
    copyFileSync(from, to, constants.COPYFILE_FICLONE_FORCE)
    return readFileSync(to, 'utf8') === 'probe\n'
  } catch {
    return false
  } finally {
    rmSync(from, { force: true })
    rmSync(to, { force: true })
  }
}

export function cloneRoadExpected(dir: string): boolean {
  return (process.platform === 'darwin' || process.platform === 'linux') && volumeClones(dir)
}

const CONTENT_IDENTIFIER_SCRIPT = [
  'function run() {',
  "  ObjC.import('Foundation')",
  '  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile',
  '  var paths = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)))',
  "  var keys = $.NSArray.arrayWithArray(['NSURLFileContentIdentifierKey'])",
  '  var identifiers = []',
  '  for (var i = 0; i < paths.length; i++) {',
  '    var values = $.NSURL.fileURLWithPath(paths[i]).resourceValuesForKeysError(keys, null)',
  '    var plain = values.isNil() ? null : ObjC.deepUnwrap(values)',
  '    identifiers.push(plain === null || plain.NSURLFileContentIdentifierKey === undefined ? null : String(plain.NSURLFileContentIdentifierKey))',
  '  }',
  '  return JSON.stringify(identifiers)',
  '}',
].join('\n')

export function contentShared(pairs: ReadonlyArray<readonly [string, string]>): boolean[] | null {
  if (process.platform !== 'darwin') return null
  const answer = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CONTENT_IDENTIFIER_SCRIPT], { input: JSON.stringify(pairs.flat()), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (answer.status !== 0) return null
  try {
    const identifiers = JSON.parse(answer.stdout.trim()) as Array<string | null>
    if (identifiers.length !== pairs.length * 2) return null
    return pairs.map((_, index) => identifiers[2 * index] !== null && identifiers[2 * index] === identifiers[2 * index + 1])
  } catch {
    return null
  }
}

const CLONE_WHOLE_SCRIPT = [
  'function run() {',
  "  ObjC.import('Foundation')",
  "  ObjC.bindFunction('clonefile', ['int', ['char *', 'char *', 'int']])",
  '  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile',
  '  var pairs = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)))',
  '  var rows = []',
  '  for (var i = 0; i < pairs.length; i++) {',
  '    var began = Date.now()',
  '    rows.push($.clonefile(pairs[i][0], pairs[i][1], 1) === 0 ? Date.now() - began : -1)',
  '  }',
  '  return JSON.stringify(rows)',
  '}',
].join('\n')

export function cloneWholeFolders(pairs: ReadonlyArray<readonly [string, string]>): Promise<number[] | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  return new Promise(resolve => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CLONE_WHOLE_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.on('data', chunk => (out += String(chunk)))
    child.on('error', () => resolve(null))
    child.on('close', code => {
      try {
        const rows = JSON.parse(out.trim()) as number[]
        resolve(code === 0 && rows.length === pairs.length && rows.every(ms => ms >= 0) ? rows : null)
      } catch {
        resolve(null)
      }
    })
    child.stdin.end(JSON.stringify(pairs))
  })
}
