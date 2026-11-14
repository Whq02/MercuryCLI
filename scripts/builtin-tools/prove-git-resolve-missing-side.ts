import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gitClient, gitFixture } from './gitFixture.ts'

let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = '') => { checks++; if (!ok) failures++; console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`) }
const world = gitFixture('git-missing-side-')
let client: Awaited<ReturnType<typeof gitClient>> | undefined
const long = 'a/deep/folder/with/a/long/name/and-more-of-it/added-on-both-sides.txt'
try {
  const put = (file: string, text: string | null) => {
    if (text === null) return rmSync(join(world.root, file), { force: true })
    mkdirSync(dirname(join(world.root, file)), { recursive: true })
    world.put(file, text)
  }
  const commit = (side: string, files: Record<string, string | null>, moved?: [string, string]) => {
    for (const [file, text] of Object.entries(files)) put(file, text)
    if (moved) world.git(['mv', moved[0], moved[1]])
    world.git(['add', '-A']); world.git(['commit', '--quiet', '-m', side])
  }
  commit('base', { 'gone.txt': 'base\n', 'lost.txt': 'base\n', 'both.txt': 'base\n', 'f.txt': 'one\ntwo\nthree\nfour\nfive\n' })
  world.git(['switch', '--quiet', '-c', 'other'])
  commit('theirs', { 'added.txt': 'theirs\n', [long]: 'theirs\n', 'gone.txt': null, 'lost.txt': 'theirs\n', 'both.txt': 'theirs\n' }, ['f.txt', 'b.txt'])
  world.git(['switch', '--quiet', 'main'])
  commit('ours', { 'added.txt': 'ours\n', [long]: 'ours\n', 'gone.txt': 'ours\n', 'lost.txt': null, 'both.txt': 'ours\n' }, ['f.txt', 'a.txt'])
  try { world.git(['merge', '--no-edit', 'other']) } catch {}
  const codes = Object.fromEntries(world.git(['status', '--porcelain=v2']).split('\n').filter(line => line.startsWith('u ')).map(line => [line.split(' ').slice(10).join(' '), line.split(' ')[1]]))
  const kinds = (held: Record<string, string>): string => Object.entries(held).map(([file, code]) => `${code} ${file}`).sort().join(', ')
  check('the fixture holds each kind of conflict', kinds(codes) === kinds({ [long]: 'AA', 'a.txt': 'AU', 'added.txt': 'AA', 'b.txt': 'UA', 'both.txt': 'UU', 'f.txt': 'DD', 'gone.txt': 'UD', 'lost.txt': 'DU' }), kinds(codes))
  const tree = (): string => readdirSync(world.root, { recursive: true }).map(String).filter(name => !name.startsWith('.git')).sort().map(name => { try { return `${name}=${readFileSync(join(world.root, name)).toString('hex')}` } catch { return name } }).join('|')
  const before = tree()
  const unmerged = world.git(['ls-files', '--unmerged'])
  client = await gitClient(world)
  const rows: Array<[string, 'base' | 'both', string]> = [['added.txt', 'base', 'base'], [long, 'base', 'base'], ['a.txt', 'base', 'base'], ['a.txt', 'both', 'theirs'], ['b.txt', 'base', 'base'], ['b.txt', 'both', 'ours'], ['f.txt', 'both', 'ours'], ['gone.txt', 'both', 'theirs'], ['lost.txt', 'both', 'ours']]
  for (const [file, take, missing] of rows) {
    const answer = await client.call('Git', { op: 'resolve', path: file, take })
    check(`${codes[file]} ${file}: take ${take} names the side this conflict does not hold`, answer === `resolve refused: '${file}' has no ${missing} version in this conflict — nothing written`, answer)
  }
  check('no refusal wrote a byte, moved the index or left a temporary', tree() === before && world.git(['ls-files', '--unmerged']) === unmerged && readdirSync(join(world.root, '.git')).every(name => !name.startsWith('mercury-resolve-')))
  const resolved = async (file: string, take: string, text: string) => {
    const answer = await client!.call('Git', { op: 'resolve', path: file, take })
    const staged = (): string => { try { return world.git(['show', `:${file}`]) } catch { return '(not staged)' } }
    check(`${codes[file]} ${file}: take ${take} is held and resolves`, answer.startsWith(`resolved '${file}' — staged;`) && world.get(file) === text && staged() === text, `${answer}; ${staged()}`)
  }
  await resolved('added.txt', 'both', 'ours\ntheirs\n')
  await resolved('gone.txt', 'base', 'base\n')
  await resolved('lost.txt', 'base', 'base\n')
  await resolved('f.txt', 'base', 'one\ntwo\nthree\nfour\nfive\n')
  await resolved('both.txt', 'both', 'ours\ntheirs\n')
} finally { await client?.close(); world.dispose() }
console.log(`Git resolve missing side: ${checks - failures}/${checks}`)
process.exitCode = failures ? 1 : 0
