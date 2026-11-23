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
check('an archive member named .cpuprofile is read as the entry it is', entryProfile.includes('1\t{"nodes"') && !entryProfile.includes('ENOENT'), `${entryProfile}\nHint: an archive member path (archive:member) must be read as the entry whatever its name ends in; the automatic profile route in src/tools/read/call/call.ts (automaticProfile, classifyReadTarget kind file) must not claim it.`)
const entrySample = await read(`${archive}:inner.sample.txt`)
check('an archive member named .sample.txt is read as the entry it is', entrySample.includes('1\tprose in an archive') && !entrySample.includes('ENOENT'), `${entrySample}\nHint: an archive member named .sample.txt must read as the entry; the automaticProfile test in src/tools/read/call/call.ts must not claim it.`)
const entryPlain = await read(`${archive}:inner.txt`)
check('an archive member of another name reads as before', entryPlain.includes('1\tplain entry'), `${entryPlain}\nHint: reading a plain archive member (archive:member) has regressed; check the archive entry read path in src/tools/read.`)

const missingText = await read(join(home, 'gone.txt'))
const missingProfile = await read(join(home, 'gone.cpuprofile'))
const missingSample = await read(join(home, 'gone.sample.txt'))
check('a missing text file answers the missing-file sentence', missingText.includes('There is no file at that path'), `${missingText}\nHint: friendlyNotFoundError in src/tools/read/call/target.ts builds this sentence; a missing plain file must still end there.`)
check('a missing .cpuprofile answers the same sentence', missingProfile.includes('There is no file at that path') && !missingProfile.includes('ENOENT'), `${missingProfile}\nHint: a missing .cpuprofile must fall through to friendlyNotFoundError in src/tools/read/call/target.ts; see the automaticProfile branch in read/call.ts.`)
check('a missing .sample.txt answers the same sentence', missingSample.includes('There is no file at that path') && !missingSample.includes('ENOENT'), `${missingSample}\nHint: a missing .sample.txt must fall through to friendlyNotFoundError in src/tools/read/call/target.ts; see the automaticProfile branch in read/call.ts.`)

writeFileSync(join(home, 'settings.sample.txt'), 'a kept example\n')
const near = await read(join(home, 'setings.sample.txt'))
const nearPlain = await read(join(home, 'setings.sample.tx'))
check('a mistyped .sample.txt name is answered as a mistyped name of another kind is', near.includes('ENOENT') === nearPlain.includes('ENOENT') && !near.includes('ENOENT'), `${near}\n${nearPlain}\nHint: a mistyped .sample.txt name must get the same not-found answer as a mistyped name of another kind (friendlyNotFoundError in src/tools/read/call/target.ts), with no raw ENOENT from the profile route in read/call.ts.`)

mkdirSync(join(home, 'folder.cpuprofile'))
writeFileSync(join(home, 'folder.cpuprofile', 'child.txt'), 'x\n')
const folder = await read(join(home, 'folder.cpuprofile'))
check('a folder named .cpuprofile is listed', folder.includes('child.txt') && !folder.includes('ENOENT'), `${folder}\nHint: a directory named .cpuprofile must be listed, not taken for a profile file; check the automaticProfile condition (classifyReadTarget kind file) in src/tools/read/call/call.ts.`)

const real = join(home, 'work.cpuprofile')
writeFileSync(real, cpu)
check('a recognised report is still summarised on a whole read', (await read(real)).includes('(target: profile'), 'Hint: a whole read of a real .cpuprofile must be summarised; check the automaticProfile branch in src/tools/read/call/call.ts.')
const prose = join(home, 'notes.sample.txt')
writeFileSync(prose, 'A sample of the settings a project keeps.\nsecond line\n')
const proseRead = await read(prose)
check('a prose .sample.txt is still its text with an anchor', proseRead.includes('1\tA sample of the settings a project keeps.') && proseRead.includes('(anchor:'), `${proseRead}\nHint: a .sample.txt that is not a report must fall back to the plain text read with its anchor; see the automaticProfile branch in src/tools/read/call/call.ts.`)
const HINT = 'Profile summary: Read('
check('a whole read that found no report offers no profile summary', !proseRead.includes(HINT), `${proseRead}\nHint: profileHint in src/tools/read/call/serialize.ts must be left off a whole read that already tried and found no report (resultWithoutProfileHint).`)
const shaped = join(home, 'ordinary.cpuprofile')
writeFileSync(shaped, '{"ordinary":true}\n')
const shapedRead = await read(shaped)
check('a whole read of other JSON named .cpuprofile offers none', shapedRead.includes('1\t{"ordinary":true}') && !shapedRead.includes(HINT), `${shapedRead}\nHint: profileHint in src/tools/read/call/serialize.ts must be left off a whole read of JSON that is not a profile (resultWithoutProfileHint).`)
check('an archive member offers none, whole', !entryProfile.includes(HINT) && !entrySample.includes(HINT), `${entryProfile}\n${entrySample}\nHint: profileHint in src/tools/read/call/serialize.ts must not be added to an archive member.`)
const entryWindow = await read(`${archive}:inner.cpuprofile`, { offset: 1, limit: 1 })
check('an archive member offers none, by lines', entryWindow.includes('1\t{"nodes"') && !entryWindow.includes(HINT), `${entryWindow}\nHint: profileHint in src/tools/read/call/serialize.ts must not be added to an archive member read by lines.`)
const rawWindow = await read(real, { offset: 1, limit: 1 })
check('an explicit raw read of a plain report still offers the summary', rawWindow.includes(`${HINT}file_path: ${JSON.stringify(`${real}#read?view=profile`)}).`), `${rawWindow}\nHint: profileHint in src/tools/read/call/serialize.ts must offer the summary after an explicit raw window of a plain report.`)
const rawEscape = await read(`${real}#read?view=raw`)
check('the raw escape still offers the summary', rawEscape.includes(HINT), `${rawEscape}\nHint: profileHint in src/tools/read/call/serialize.ts must still be added after the #read?view=raw escape.`)
const proseWindow = await read(prose, { offset: 2, limit: 1 })
check('an explicit raw read of a plain file of the name still offers it', proseWindow.includes('2\tsecond line') && proseWindow.includes(HINT), `${proseWindow}\nHint: profileHint in src/tools/read/call/serialize.ts must be added to an explicit window of a plain file named .sample.txt.`)
kit.finish()
