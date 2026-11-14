import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitClient, gitFixture } from './gitFixture.ts'

let checks = 0
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail}` : ''}`)
}
const world = gitFixture('git-resolve-edit-deny-')
const names = ['open.txt', 'control.txt', 'free.txt', 'alias.txt', 'locked/region.txt', 'locked/whole.txt', 'locked/side.txt', 'locked/target.txt', 'secret/read.txt']
const marker = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n'
let client: Awaited<ReturnType<typeof gitClient>> | undefined
try {
  mkdirSync(join(world.root, 'locked'))
  mkdirSync(join(world.root, 'secret'))
  const commit = (label: string): void => {
    for (const name of names) world.put(name, `${label}\n`)
    world.git(['add', '--', ...names])
    world.git(['commit', '--quiet', '-m', label])
  }
  commit('base')
  world.git(['switch', '--quiet', '-c', 'other'])
  commit('theirs')
  world.git(['switch', '--quiet', 'main'])
  commit('ours')
  const linked = join(world.scratch, 'linked')
  world.git(['worktree', 'add', '--quiet', '-b', 'side', linked, 'main'])
  const inLinked = (args: string[]): string => execFileSync('git', args, { cwd: linked, env: world.env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  try { inLinked(['merge', '--no-edit', 'other']) } catch {}
  try { world.git(['merge', '--no-edit', 'other']) } catch {}
  for (const name of names) world.put(name, marker)
  rmSync(join(world.root, 'alias.txt'))
  symlinkSync(join('locked', 'target.txt'), join(world.root, 'alias.txt'))
  const via = join(world.scratch, 'via')
  symlinkSync(world.root, via)
  const index = () => readFileSync(join(world.root, '.git/index'))
  const before = index()
  const unmerged = (file: string, at = world.git): boolean => at(['ls-files', '--unmerged', '--', file]).length > 0
  const denyEdit = `Edit(/${world.root}/locked/**)`
  writeFileSync(join(world.home, 'settings.json'), JSON.stringify({ guardrails: { allow: ['Git', 'Read', 'Inspect'], deny: [denyEdit, `Edit(/${linked}/locked/**)`, `Read(/${world.root}/secret/**)`] } }))
  client = await gitClient(world)
  const git = (args: Record<string, unknown>) => client!.call('Git', args)
  const regionOf = (text: string, file: string): string => text.slice(text.indexOf(` ${file} (`)).match(/gr-[a-f0-9]+/)?.[0] ?? ''
  const listed = await git({ op: 'conflicts' })
  const open = regionOf(listed, 'open.txt')
  const control = regionOf(listed, 'control.txt')
  const region = regionOf(listed, 'locked/region.txt')
  const withheld = '  1 file withheld: a permission rule denies reading it'
  check('conflicts lists the files a Read rule leaves readable and counts the one it withholds', listed.includes(' open.txt (') && !listed.includes('secret/read.txt') && listed.endsWith(`\n${withheld}`), listed)
  const refusedBy = (out: string, file: string): boolean => out.includes(`Editing ${join(world.root, file)} is denied by the rule ${denyEdit}`)

  const mixed = await git({ op: 'resolve', resolutions: [{ region: open, take: 'ours' }, { region, content: 'model text\n' }] })
  check('region road: an Edit deny rule on one file of the call refuses the resolve in the rule\'s own sentence', refusedBy(mixed, 'locked/region.txt'), mixed)
  check('region road: the whole call is refused, no file written and the index untouched', world.get('open.txt') === marker && world.get('locked/region.txt') === marker && index().equals(before), mixed)
  const sided = await git({ op: 'resolve', resolutions: [{ region, take: 'theirs' }] })
  check('region road: taking a side into a denied file is refused as supplied text is', refusedBy(sided, 'locked/region.txt') && world.get('locked/region.txt') === marker, sided)
  const whole = await git({ op: 'resolve', path: 'locked/whole.txt', content: 'model text\n' })
  check('whole-file road: supplied text for a denied file is refused, the file unchanged and still unmerged', refusedBy(whole, 'locked/whole.txt') && world.get('locked/whole.txt') === marker && unmerged('locked/whole.txt'), whole)
  const wholeSide = await git({ op: 'resolve', path: 'locked/side.txt', take: 'theirs' })
  check('whole-file road: taking a side into a denied file is refused, the file unchanged and still unmerged', refusedBy(wholeSide, 'locked/side.txt') && world.get('locked/side.txt') === marker && unmerged('locked/side.txt'), wholeSide)
  const throughLink = await git({ op: 'resolve', path: 'alias.txt', content: 'through the link\n' })
  check('a conflicted path that is a link into a denied folder is judged as Edit judges it, by where the link leads', throughLink.includes(`is denied by the rule ${denyEdit}`) && world.get('locked/target.txt') === marker && unmerged('alias.txt'), `${throughLink} ${JSON.stringify(world.get('locked/target.txt'))}`)
  const byLinkedFolder = await git({ op: 'resolve', cwd: via, path: 'locked/whole.txt', content: 'by another spelling\n' })
  check('the repository reached through a linked folder meets the same rule', byLinkedFolder.includes(`is denied by the rule ${denyEdit}`) && world.get('locked/whole.txt') === marker, byLinkedFolder)
  const linkedListed = await git({ op: 'conflicts', cwd: linked })
  const linkedRegion = await git({ op: 'resolve', cwd: linked, resolutions: [{ region: regionOf(linkedListed, 'locked/region.txt'), content: 'model text\n' }] })
  const linkedWhole = await git({ op: 'resolve', cwd: linked, path: 'locked/whole.txt', content: 'model text\n' })
  const linkedText = (file: string): string => readFileSync(join(linked, file), 'utf8')
  check('a linked worktree meets its own rule on both roads', [linkedRegion, linkedWhole].every(out => out.includes(`is denied by the rule Edit(/${linked}/locked/**)`)) && linkedText('locked/region.txt').includes('<<<<<<<') && linkedText('locked/whole.txt').includes('<<<<<<<') && unmerged('locked/region.txt', inLinked) && unmerged('locked/whole.txt', inLinked), `${linkedRegion} ${linkedWhole}`)

  const readDenied = await git({ op: 'resolve', path: 'secret/read.txt', take: 'ours' })
  check('a Read deny rule answers a resolve as it did', readDenied.includes(`Reading ${join(world.root, 'secret/read.txt')} is denied by the rule Read(/${world.root}/secret/**)`) && !listed.includes('secret/read.txt') && unmerged('secret/read.txt'), readDenied)
  const allowedRegion = await git({ op: 'resolve', resolutions: [{ region: control, content: 'kept\n' }] })
  check('a file no rule names resolves by region with the receipt unchanged', /^resolved regions — bytes written: control\.txt; staged: control\.txt; unresolved regions: \(none\); evidence mercury:\/\/evidence\/ev-[a-f0-9]+$/.test(allowedRegion) && world.get('control.txt') === 'kept\n' && !unmerged('control.txt'), allowedRegion)
  const allowedWhole = await git({ op: 'resolve', path: 'free.txt', content: 'kept whole\n' })
  check('a file no rule names resolves whole with the receipt unchanged', /^resolved 'free\.txt' — staged; evidence mercury:\/\/evidence\/ev-[a-f0-9]+$/.test(allowedWhole) && world.get('free.txt') === 'kept whole\n' && !unmerged('free.txt'), allowedWhole)
  await client.close()
  client = undefined
  for (const name of names) if (!name.startsWith('secret/')) world.git(['add', '--', name])
  const onlyWithheld = async (deny: string[]): Promise<string> => {
    writeFileSync(join(world.home, 'settings.json'), JSON.stringify({ guardrails: { allow: ['Git', 'Read', 'Inspect'], deny } }))
    client = await gitClient(world)
    const out = await client.call('Git', { op: 'conflicts' })
    await client.close()
    client = undefined
    return out
  }
  const silent = await onlyWithheld([`Read(/${world.root}/secret/**)`])
  check('with the only conflicted file withheld the answer is the withheld line, not silence', silent === withheld, JSON.stringify(silent))
  const unruled = await onlyWithheld([])
  check('with no deny rule the answer names the file and no withheld line', unruled.includes(' secret/read.txt (') && !unruled.includes('withheld'), unruled)
} finally {
  await client?.close()
  world.dispose()
}
console.log(`git resolve edit deny: ${checks - failures}/${checks}`)
process.exitCode = failures ? 1 : 0
