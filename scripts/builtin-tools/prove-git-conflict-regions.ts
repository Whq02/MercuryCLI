import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitClient, gitFixture } from './gitFixture.ts'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`)
}
const world = gitFixture('git-regions-')
const names = ['multi.txt', 'two.txt', 'crlf.txt', 'tail.txt', 'bad.txt', 'duplicate.txt', 'wide.txt', 'same.txt', 'mode.sh', 'latin-base.txt', 'latin-both.txt']
const block = (ours: string, theirs: string, base?: string, eol = '\n') => [
  '<<<<<<< HEAD', ours, ...(base === undefined ? [] : ['||||||| base', base]), '=======', theirs, '>>>>>>> branch', '',
].join(eol)
const first = block('ours-one', 'theirs-one', 'base-one')
const second = block('ours-two', 'theirs-two', 'base-two')
const nested = '<<<<<<<<< Temporary merge branch 1\nx\n=========\ny\n>>>>>>>>> Temporary merge branch 2\n'
const wide = `<<<<<<< HEAD\nTitle\n==========\nours\n||||||| base\n${nested}=======\nTitle\n==========\ntheirs\n>>>>>>> branch\n`
const latin = (label: string) => Buffer.concat([Buffer.from([0xe9, 0x20]), Buffer.from(`${label}\n`)])
const putLatin = (label: string) => ['latin-base.txt', 'latin-both.txt'].forEach(name => writeFileSync(join(world.root, name), latin(label)))
let client: Awaited<ReturnType<typeof gitClient>> | undefined
try {
  for (const name of names) world.put(name, 'base\n')
  putLatin('base')
  chmodSync(join(world.root, 'mode.sh'), 0o755)
  world.git(['add', '--', ...names])
  world.git(['commit', '--quiet', '-m', 'base'])
  world.git(['switch', '--quiet', '-c', 'other'])
  for (const name of names) world.put(name, 'theirs\n')
  putLatin('theirs')
  world.git(['add', '--', ...names])
  world.git(['commit', '--quiet', '-m', 'other'])
  world.git(['switch', '--quiet', 'main'])
  for (const name of names) world.put(name, 'ours\n')
  putLatin('ours')
  world.git(['add', '--', ...names])
  world.git(['commit', '--quiet', '-m', 'ours'])
  try { world.git(['merge', '--no-edit', 'other']) } catch {}
  const initial = {
    'multi.txt': `prefix\n${first}middle\n${second}suffix\n`,
    'two.txt': block('OURS', 'THEIRS'),
    'crlf.txt': `start\r\n${block('OURS', 'THEIRS', 'BASE', '\r\n')}end\r\n`,
    'tail.txt': `before\n${first}last-no-newline`,
    'bad.txt': ' <<<<<<< indented\nours\n=======\ntheirs\n>>>>>>> x\n<<<<<<< incomplete\nours\n',
    'duplicate.txt': `${first}gap\n${first}`,
    'wide.txt': `${wide}gap\n${block('a', 'b')}`,
    'mode.sh': block('a', 'b'),
    'same.txt': `<<<<<<< HEAD\nTitle\n=======\nours\n=======\ntheirs\n>>>>>>> branch\ngap\n${block('a', 'b')}`,
  }
  for (const [name, text] of Object.entries(initial)) world.put(name, text)
  world.git(['config', 'core.filemode', 'false'])
  chmodSync(join(world.root, 'mode.sh'), 0o644)
  const initialIndex = readFileSync(join(world.root, '.git/index'))
  client = await gitClient(world)
  const git = (args: Record<string, unknown>) => client!.call('Git', args)
  const conflictText = await git({ op: 'conflicts' })
  const fileId = (file: string) => conflictText.match(new RegExp(`(gc-[a-f0-9]+) ${file.replace('.', '\\.')}`))?.[1]
  const ids = (text: string, file: string): string[] => {
    const at = text.indexOf(` ${file} (`)
    if (at < 0) return []
    return [...new Set(text.slice(at, text.indexOf('\n  gc-', at) < 0 ? undefined : text.indexOf('\n  gc-', at)).match(/gr-[a-f0-9]+/g) ?? [])]
  }
  const multi = ids(conflictText, 'multi.txt')
  const two = ids(conflictText, 'two.txt')
  const crlf = ids(conflictText, 'crlf.txt')
  const tail = ids(conflictText, 'tail.txt')
  const duplicates = ids(conflictText, 'duplicate.txt')
  const wider = ids(conflictText, 'wide.txt')
  const same = ids(conflictText, 'same.txt')
  const mode = ids(conflictText, 'mode.sh')
  check('M01 every complete diff3/two-way region has an identity', multi.length === 2 && two.length === 1 && crlf.length === 1 && tail.length === 1 && duplicates.length === 2, conflictText)
  check('M01 incomplete and indented lookalikes do not become regions', ids(conflictText, 'bad.txt').length === 0, conflictText)
  check('M01 duplicate blocks have distinct identities', duplicates.length === 2 && duplicates[0] !== duplicates[1])
  check('M01 source coordinates are displayed', conflictText.includes('lines 2-8'), conflictText)
  check('M01 a line of marker characters longer than the marker is content of its side, not a marker', wider.length === 2 && conflictText.includes(`${wider[0]} lines 1-15`), conflictText)
  check('M01 repeated reads preserve identities', JSON.stringify(ids(await git({ op: 'conflicts' }), 'multi.txt')) === JSON.stringify(multi) && multi.length === 2)
  const corpus = JSON.parse(readFileSync(join(import.meta.dir, '../tool-economy/fixtures/definition-corpus.json'), 'utf8')).definitions.find((d: { name: string }) => d.name === 'Git')
  const definition = (await client.request('tools/list', {})).result?.tools?.find(t => t.name === 'Git')
  check('published Git prompt matches its corpus; typed definition fits the original budget', definition?.description === corpus.description && definition.description.length + JSON.stringify(definition.inputSchema).length <= 4404)
  if (multi.length === 2 && two.length === 1 && crlf.length === 1 && tail.length === 1 && duplicates.length === 2) {
    const read = (file: string, id: string, selector = '') => client!.call('Read', { file_path: `mercury://git/conflict/${fileId(file)}/${id}${selector}` })
    for (const [side, value] of [['ours', 'ours-one'], ['theirs', 'theirs-one'], ['base', 'base-one']]) {
      const out = await read('multi.txt', multi[0]!, `?child=${side}`)
      check(`M02 ${side} reads its own region with source coordinates`, out.includes(value!) && /[0-9]+\t|line|source/.test(out), out)
    }
    const raw = await read('multi.txt', multi[0]!, '?limit=2')
    check('M02 raw region pages without manufacturing a partial block', raw.includes('<<<<<<< HEAD') && !raw.includes('theirs-one') && /cursor|more|page/.test(raw), raw)
    const later = await read('multi.txt', multi[0]!, '?cursor=2&limit=2')
    check('M02 continuation is relative to region and retains original coordinates', later.includes('||||||| base') && later.includes('base-one'), later)
    const absent = await read('two.txt', two[0]!, '?child=base')
    check('M02 missing base is explicit', absent.includes('no base section'), absent)
    const resolve = (resolutions: unknown[]) => git({ op: 'resolve', resolutions })
    check('B01 preview changes neither file nor index', world.get('multi.txt') === initial['multi.txt'] && readFileSync(join(world.root, '.git/index')).equals(initialIndex))
    const landed = await resolve([{ region: multi[0], take: 'base' }])
    check('M03 one region changes and clean surroundings remain', world.get('multi.txt') === `prefix\nbase-one\nmiddle\n${second}suffix\n`, landed)
    check('B02 partial resolution leaves unmerged index unchanged', world.git(['ls-files', '--unmerged', '--', 'multi.txt']).length > 0 && readFileSync(join(world.root, '.git/index')).equals(initialIndex))
    check('M04 receipt names the unresolved remainder and no staging', landed.includes(multi[1]!) && landed.includes('staged: (none)'), landed)
    const reread = await git({ op: 'conflicts' })
    check('M05 unchanged region retains its identity after line shift', ids(reread, 'multi.txt').includes(multi[1]!), reread)
    const retired = await resolve([{ region: multi[0], take: 'ours' }])
    check('M05 retired region cannot resolve', /absent|stale|obsolete/.test(retired), retired)
    const repeated = 'middle\nLITERAL\nsuffix\n'
    const final = await resolve([{ region: multi[1], content: repeated }, { region: two[0], take: 'both' }])
    check('M03/B03 literal repetition is not trimmed', world.get('multi.txt') === `prefix\nbase-one\nmiddle\n${repeated}suffix\n`, final)
    check('M03 both means ours followed by theirs', world.get('two.txt') === 'OURS\nTHEIRS\n', final)
    check('B02 resolving last regions stages only those files', world.git(['ls-files', '--unmerged', '--', 'multi.txt', 'two.txt']) === '' && world.git(['show', ':multi.txt']) === world.get('multi.txt') && world.git(['ls-files', '--unmerged', '--', 'crlf.txt']).length > 0, final)
    const oldTail = world.get('tail.txt')
    world.put('crlf.txt', world.get('crlf.txt').replace('OURS', 'DRIFT'))
    const beforeStaleIndex = readFileSync(join(world.root, '.git/index'))
    const staleApply = await resolve([{ region: crlf[0], take: 'base' }, { region: tail[0], content: '' }])
    check('B01 one stale member writes no member and preserves index', world.get('tail.txt') === oldTail && world.get('crlf.txt').includes('DRIFT') && readFileSync(join(world.root, '.git/index')).equals(beforeStaleIndex) && /stale/.test(staleApply), staleApply)
    const obsolete = await resolve([{ region: crlf[0], take: 'ours' }])
    check('M05 altered block rejects obsolete identity', /absent|stale|obsolete/.test(obsolete), obsolete)
    const refreshed = ids(await git({ op: 'conflicts' }), 'crlf.txt')[0]
    const newlineApply = await resolve([{ region: refreshed, take: 'theirs' }, { region: tail[0], content: '' }])
    check('M06 CRLF side replacement stays CRLF', world.get('crlf.txt') === 'start\r\nTHEIRS\r\nend\r\n', newlineApply)
    check('M03/M06 empty replacement keeps missing final newline', world.get('tail.txt') === 'before\nlast-no-newline', newlineApply)
    await resolve([{ region: duplicates[0], take: 'ours' }])
    check('M05 remaining identical region retains its own identity', ids(await git({ op: 'conflicts' }), 'duplicate.txt').includes(duplicates[1]!))
    await resolve([{ region: duplicates[1], take: 'theirs' }])
    check('M03/M05 both identical regions resolve independently', world.get('duplicate.txt') === 'ours-one\ngap\ntheirs-one\n')
    const underlined = wider.length === 2 ? await resolve([{ region: wider[0], take: 'ours' }, { region: wider[1], take: 'theirs' }]) : 'the wider region is not listed'
    const wholeBase = await git({ op: 'resolve', path: 'latin-base.txt', take: 'base' })
    const wholeBoth = await git({ op: 'resolve', path: 'latin-both.txt', take: 'both' })
    check('a whole file taken as base or both is written with the bytes its stages hold, not a decoded copy', readFileSync(join(world.root, 'latin-base.txt')).equals(latin('base')) && readFileSync(join(world.root, 'latin-both.txt')).equals(Buffer.concat([latin('ours'), latin('theirs')])) && world.git(['ls-files', '--unmerged', '--', 'latin-base.txt', 'latin-both.txt']) === '', `${wholeBase} ${wholeBoth} ${readFileSync(join(world.root, 'latin-base.txt')).toString('hex')} ${readFileSync(join(world.root, 'latin-both.txt')).toString('hex')}`)
    const executable = mode.length === 1 ? await resolve([{ region: mode[0], take: 'theirs' }]) : 'one region expected'
    check('B02 where the repository does not trust the file mode the staged entry keeps the mode the index held', world.git(['ls-files', '--stage', '--', 'mode.sh']).startsWith('100755 ') && world.git(['show', ':mode.sh']) === 'b\n', `${executable} ${world.git(['ls-files', '--stage', '--', 'mode.sh'])}`)
    const beside = same.length === 1 ? await resolve([{ region: same[0], take: 'ours' }]) : 'one region expected beside the ambiguous block'
    check('B02 a file that still holds a marker block without an identity is written and left unmerged', world.get('same.txt') === '<<<<<<< HEAD\nTitle\n=======\nours\n=======\ntheirs\n>>>>>>> branch\ngap\na\n' && world.git(['ls-files', '--unmerged', '--', 'same.txt']).length > 0 && beside.includes('staged: (none)'), beside)
    check('M03 a side holding longer marker characters is taken whole and the file is staged without a marker', world.get('wide.txt') === 'Title\n==========\nours\ngap\nb\n' && world.git(['ls-files', '--unmerged', '--', 'wide.txt']) === '', underlined)
  } else {
    for (const row of ['M02 side/raw paged reads', 'M03 individual side/literal choices', 'M04 subset remainder', 'M05 relocation/stale identity', 'M06 newlines', 'B01 frozen multi-file transaction', 'B02 truthful staging', 'B03 exact repetition']) check(row, false, 'region discovery unavailable')
  }
} finally {
  await client?.close()
  world.dispose()
}
console.log(`git conflict regions: ${checks - failures}/${checks}`)
process.exitCode = failures ? 1 : 0
