import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitClient, gitFixture } from './gitFixture.ts'

let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
const marker = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n'
const slashed = (file: string) => file.replaceAll('\\', '/')
const held = (root: string) => readdirSync(join(root, '.git')).filter(name => name.startsWith('mercury-resolve-'))
const head = (file: string, bytes: number): string => {
  const from = openSync(file, 'r')
  try {
    const piece = Buffer.alloc(bytes)
    return piece.subarray(0, readSync(from, piece, 0, bytes, 0)).toString()
  } finally { closeSync(from) }
}
function conflicted(label: string, file: string) {
  const world = gitFixture(label)
  world.put('.gitattributes', `${file} filter=shaped -text\n`)
  const seed = (side: string) => { world.put(file, `${side}\n`); world.git(['add', '-A']); world.git(['commit', '--quiet', '-m', side]) }
  seed('base'); world.git(['switch', '--quiet', '-c', 'other']); seed('theirs'); world.git(['switch', '--quiet', 'main']); seed('ours')
  try { world.git(['merge', '--no-edit', 'other']) } catch {}
  world.put(file, marker)
  const filter = (kind: 'smudge' | 'clean', command: string) => world.git(['config', '--global', `filter.shaped.${kind}`, command])
  const script = (name: string, text: string): string => { const at = join(world.scratch, name); writeFileSync(at, text); return `"${slashed(process.execPath)}" "${slashed(at)}"` }
  return { world, filter, script }
}
const inflate = "const fs = require('node:fs')\nconst piece = Buffer.alloc(1 << 20, 46)\nlet left = Number(process.argv[2])\nconst pour = () => { while (left-- > 0) if (!process.stdout.write(piece)) return void process.stdout.once('drain', pour) }\nprocess.stdout.write(fs.readFileSync(0), pour)\n"
const deflate = "let first = null\nprocess.stdin.on('data', chunk => { if (first === null) first = chunk.subarray(0, chunk.indexOf(10) + 1) })\nprocess.stdin.on('end', () => process.stdout.write(first ?? ''))\n"

{
  const pieces = 260
  const { world, filter, script } = conflicted('git-streams-large-', 'big.dat')
  let client: Awaited<ReturnType<typeof gitClient>> | undefined
  try {
    filter('smudge', `${script('inflate.cjs', inflate)} ${pieces}`)
    filter('clean', script('deflate.cjs', deflate))
    client = await gitClient(world)
    const answer = await client.call('Git', { op: 'resolve', path: 'big.dat', take: 'base' })
    const size = statSync(join(world.root, 'big.dat')).size
    check(`base: a side whose checkout form is ${pieces} MiB is resolved`, answer.startsWith("resolved 'big.dat' — staged;"), answer.slice(0, 300))
    check('base: the working file is the whole checkout form', size === 5 + pieces * (1 << 20) && head(join(world.root, 'big.dat'), 8) === 'base\n...', `${size} bytes, ${JSON.stringify(head(join(world.root, 'big.dat'), 8))}`)
    const staged = (): string => { try { return world.git(['show', ':big.dat']) } catch { return '(not staged)' } }
    check('base: the staged blob is the stored side and the path left the unmerged index', staged() === 'base\n' && world.git(['ls-files', '--unmerged']) === '', staged())
    check('base: no temporary is left in the git folder', held(world.root).length === 0, held(world.root).join(', '))
  } finally { await client?.close(); world.dispose() }
}

{
  const { world, filter, script } = conflicted('git-streams-both-', 'two.dat')
  let client: Awaited<ReturnType<typeof gitClient>> | undefined
  try {
    filter('smudge', `${script('inflate.cjs', inflate)} 3`)
    filter('clean', script('deflate.cjs', deflate))
    client = await gitClient(world)
    const answer = await client.call('Git', { op: 'resolve', path: 'two.dat', take: 'both' })
    const written = readFileSync(join(world.root, 'two.dat'))
    const side = (name: string) => Buffer.concat([Buffer.from(`${name}\n`), Buffer.alloc(3 << 20, 46)])
    check('both: the two sides are written whole, ours then theirs', answer.startsWith("resolved 'two.dat' — staged;") && written.equals(Buffer.concat([side('ours'), side('theirs')])), `${answer.slice(0, 200)}; ${written.length} bytes`)
    check('both: no temporary is left in the git folder', held(world.root).length === 0, held(world.root).join(', '))
  } finally { await client?.close(); world.dispose() }
}

{
  const { world, filter, script } = conflicted('git-streams-failed-', 'bad.dat')
  let client: Awaited<ReturnType<typeof gitClient>> | undefined
  try {
    filter('smudge', script('fail.cjs', "process.stdout.write('partial\\n', () => process.exit(3))\n"))
    world.git(['config', '--global', 'filter.shaped.required', 'true'])
    client = await gitClient(world)
    for (const take of ['base', 'both']) {
      const answer = await client.call('Git', { op: 'resolve', path: 'bad.dat', take })
      check(`${take}: a side that cannot be read is refused and nothing is written`, answer.startsWith('resolve refused: resolve failed:') && world.get('bad.dat') === marker && world.git(['ls-files', '--unmerged']).includes('bad.dat'), `${answer.slice(0, 200)}; ${JSON.stringify(world.get('bad.dat'))}`)
      check(`${take}: the failed resolve leaves no temporary`, held(world.root).length === 0 && readdirSync(world.root).sort().join(' ') === '.git .gitattributes bad.dat', `${held(world.root).join(', ')}; ${readdirSync(world.root).join(' ')}`)
    }
  } finally { await client?.close(); world.dispose() }
}

if (process.platform === 'win32') console.log('[SKIP] a resolve whose git is ended by a signal — the fixture reads its parent from a POSIX shell')
else {
  const { world, filter } = conflicted('git-streams-cut-', 'cut.dat')
  let client: Awaited<ReturnType<typeof gitClient>> | undefined
  const stop = join(world.scratch, 'stop')
  let filterPid = 0
  try {
    const hang = join(world.scratch, 'hang.sh')
    const pids = join(world.scratch, 'pids')
    writeFileSync(hang, `#!/bin/sh\nprintf 'partial\\n'\necho "$PPID $$" > '${pids}'\nwhile [ ! -e '${stop}' ] && kill -0 "$PPID" 2>/dev/null; do sleep 0.1; done\n`)
    chmodSync(hang, 0o755)
    filter('smudge', hang)
    client = await gitClient(world)
    const pending = client.call('Git', { op: 'resolve', path: 'cut.dat', take: 'base' })
    for (let waited = 0; waited < 200 && !existsSync(pids); waited++) await new Promise(resolve => setTimeout(resolve, 100))
    const [parent, own] = existsSync(pids) ? readFileSync(pids, 'utf8').trim().split(' ').map(Number) : [0, 0]
    filterPid = own ?? 0
    const ps = (field: string, pid: number): string => execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], { encoding: 'utf8' }).trim()
    let git = parent ?? 0
    for (let hop = 0; hop < 3 && git > 1 && !/git/.test(ps('comm', git)); hop++) git = Number(ps('ppid', git))
    const during = held(world.root)
    check('while a side streams, its temporary stands in the git folder and the work tree holds no new file', during.length === 1 && /^mercury-resolve-\d+-\d+-1$/.test(during[0]!) && readdirSync(world.root).sort().join(' ') === '.git .gitattributes cut.dat' && world.get('cut.dat') === marker, `${during.join(', ')}; ${readdirSync(world.root).join(' ')}`)
    check('the fixture found the git that streams the side', git > 1 && /git/.test(ps('comm', git)), String(git))
    process.kill(git, 'SIGTERM')
    const answer = await pending
    check('a resolve whose git is ended while it streams is refused and nothing is written', answer.startsWith('resolve refused: resolve failed:') && world.get('cut.dat') === marker && world.git(['ls-files', '--unmerged']).includes('cut.dat'), answer.slice(0, 200))
    check('the cut resolve leaves no temporary', held(world.root).length === 0, held(world.root).join(', '))
  } finally {
    writeFileSync(stop, '')
    if (filterPid > 1) try { process.kill(filterPid, 'SIGKILL') } catch {}
    await client?.close()
    world.dispose()
  }
}
console.log(`Git resolve streams its sides: ${checks - failures}/${checks}`)
process.exitCode = failures ? 1 : 0
