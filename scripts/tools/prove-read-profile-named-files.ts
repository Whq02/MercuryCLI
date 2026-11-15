import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cpuFixture, isolatedHome, readViewKit } from './readViewKit.js'

const home = isolatedHome(import.meta.filename)
const kit = await readViewKit(home)
const { read, check } = kit
const { zipSync, strToU8 } = await import('fflate')
const cpu = JSON.stringify(cpuFixture())
const archive = join(home, 'bundle.zip')
writeFileSync(archive, zipSync({ 'inner.cpuprofile': strToU8(cpu), 'inner.sample.txt': strToU8('prose in an archive\n'), 'inner.txt': strToU8('plain entry\n') }))

const entryProfile = await read(`${archive}:inner.cpuprofile`)
check('an archive member named .cpuprofile is read as the entry it is', entryProfile.includes('1\t{"nodes"') && !entryProfile.includes('ENOENT'), entryProfile)
const entrySample = await read(`${archive}:inner.sample.txt`)
check('an archive member named .sample.txt is read as the entry it is', entrySample.includes('1\tprose in an archive') && !entrySample.includes('ENOENT'), entrySample)
const entryPlain = await read(`${archive}:inner.txt`)
check('an archive member of another name reads as before', entryPlain.includes('1\tplain entry'), entryPlain)

const missingText = await read(join(home, 'gone.txt'))
const missingProfile = await read(join(home, 'gone.cpuprofile'))
const missingSample = await read(join(home, 'gone.sample.txt'))
check('a missing text file answers the missing-file sentence', missingText.includes('There is no file at that path'), missingText)
check('a missing .cpuprofile answers the same sentence', missingProfile.includes('There is no file at that path') && !missingProfile.includes('ENOENT'), missingProfile)
check('a missing .sample.txt answers the same sentence', missingSample.includes('There is no file at that path') && !missingSample.includes('ENOENT'), missingSample)

writeFileSync(join(home, 'settings.sample.txt'), 'a kept example\n')
const near = await read(join(home, 'setings.sample.txt'))
const nearPlain = await read(join(home, 'setings.sample.tx'))
check('a mistyped .sample.txt name is answered as a mistyped name of another kind is', near.includes('ENOENT') === nearPlain.includes('ENOENT') && !near.includes('ENOENT'), `${near}\n${nearPlain}`)

mkdirSync(join(home, 'folder.cpuprofile'))
writeFileSync(join(home, 'folder.cpuprofile', 'child.txt'), 'x\n')
const folder = await read(join(home, 'folder.cpuprofile'))
check('a folder named .cpuprofile is listed', folder.includes('child.txt') && !folder.includes('ENOENT'), folder)

const real = join(home, 'work.cpuprofile')
writeFileSync(real, cpu)
check('a recognised report is still summarised on a whole read', (await read(real)).includes('(target: profile'))
const prose = join(home, 'notes.sample.txt')
writeFileSync(prose, 'A sample of the settings a project keeps.\nsecond line\n')
const proseRead = await read(prose)
check('a prose .sample.txt is still its text with an anchor', proseRead.includes('1\tA sample of the settings a project keeps.') && proseRead.includes('(anchor:'), proseRead)
const HINT = 'Profile summary: Read('
check('a whole read that found no report offers no profile summary', !proseRead.includes(HINT), proseRead)
const shaped = join(home, 'ordinary.cpuprofile')
writeFileSync(shaped, '{"ordinary":true}\n')
const shapedRead = await read(shaped)
check('a whole read of other JSON named .cpuprofile offers none', shapedRead.includes('1\t{"ordinary":true}') && !shapedRead.includes(HINT), shapedRead)
check('an archive member offers none, whole', !entryProfile.includes(HINT) && !entrySample.includes(HINT), entryProfile)
const entryWindow = await read(`${archive}:inner.cpuprofile`, { offset: 1, limit: 1 })
check('an archive member offers none, by lines', entryWindow.includes('1\t{"nodes"') && !entryWindow.includes(HINT), entryWindow)
const rawWindow = await read(real, { offset: 1, limit: 1 })
check('an explicit raw read of a plain report still offers the summary', rawWindow.includes(`${HINT}file_path: ${JSON.stringify(`${real}#read?view=profile`)}).`), rawWindow)
const rawEscape = await read(`${real}#read?view=raw`)
check('the raw escape still offers the summary', rawEscape.includes(HINT), rawEscape)
const proseWindow = await read(prose, { offset: 2, limit: 1 })
check('an explicit raw read of a plain file of the name still offers it', proseWindow.includes('2\tsecond line') && proseWindow.includes(HINT), proseWindow)
kit.finish()
