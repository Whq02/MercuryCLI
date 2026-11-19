import { posix } from 'node:path'
import { type ReadCommand, UNREAD_PART, layersOf, wordKnown } from '../../wards/wardsShellRead.js'
import { mercurySecretPath } from './paths.js'
import { UNREAD_ADVICE, readOperands, unreadWords, verb } from './words.js'
import { inlineScriptReads } from './inlineScripts.js'
import { expandShellConstants, walkShellCommands } from './walk.js'
import { GLOB_PART, SECRET_NAME_SAMPLES, UPLOADERS, couldNameSecret, globNamesStore, holdsMercuryHome, mercuryHomes, namesMercuryHome, readForFloors, secretNameBehindUnread, secretsHeld, spellingsOf, underOtherHomes } from './homes.js'
import { foldersAfter, foldersRead } from './folders.js'
import { FILE_READERS, FIND_NON_READERS, POWERSHELL_LISTERS, callsUnreadName, filesSentOrPrinted, findMaxDepth, findNamesASecret, findstrFolderFiles, gitGrepRoots, joinedUnderStanding, keychainItemRead, namesNoSecret, powershellListing, readsHandedFiles, readsWholeTree, receivesListing, ripgrepReachesHidden, searcherOf, searchesNamesAsText, searchesTextOfListing, sharesEarlierStage, stagesApart, standingSpelled, storeBelowDepth, treeReadRoots } from './listings.js'

export async function readSecretReach(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  const read = await readForFloors(command, powershell, cwd)
  if (read === null) return null
  const homes = mercuryHomes()
  const fed = new Set<number>()
  for (const reader of read.commands) for (const at of [...reader.inner.flat(), ...reader.inputInner]) fed.add(at)
  const handed = new Map<number, boolean>()
  const handedToReader = (at: number, simple: ReadCommand): boolean => {
    const known = handed.get(at)
    if (known !== undefined) return known
    const answer = read.commands.some(other => {
      const readers = layersOf(other.argv).filter(found => FILE_READERS.has(found.program))
      if (readers.length === 0) return false
      return [...other.inner.flat(), ...other.inputInner].includes(at) || (sharesEarlierStage(simple, other) && readers.some(found => found.wrappers.includes('xargs')))
    })
    handed.set(at, answer)
    return answer
  }
  const endsInside = (simple: ReadCommand): boolean => {
    const last = read.commands.find(other => other !== simple && stagesApart(simple, other) !== undefined && other.stages.at(-1)!.stage === read.pipelineSizes[other.stages.at(-1)!.pipeline]! - 1)
    return last !== undefined && FIND_NON_READERS.has(layersOf(last.argv)[0]?.program ?? '')
  }
  const loopedToReader = (at: number, simple: ReadCommand): boolean =>
    ((simple.substituted === true && !fed.has(at) && !endsInside(simple)) || read.commands.some(later => sharesEarlierStage(simple, later) && layersOf(later.argv).some(found => found.program === 'read'))) &&
    read.commands.some((later, index) => index > at && layersOf(later.argv).some(found => FILE_READERS.has(found.program) && found.argv.slice(1).some(word => !wordKnown(word))))
  const whereItStays = (here: string): string => `the whole of ${here}, where this line stays if the cd before it fails (join them with && so the read runs only after the cd)`
  for (const { at, simple, here, stayed } of read.commands.flatMap((simple, at) => {
    const stands = foldersRead(read, at, cwd).folders
    return foldersAfter(read, at, cwd).folders.map(here => ({ at, simple, here, stayed: !powershell && !stands.includes(here) }))
  })) {
    const words = powershell ? simple.argv.map((word, index) => joinedUnderStanding(word, simple.inner[index], read)) : simple.argv
    const layers = layersOf(words)
    const fedNames = layers.some(layer => FILE_READERS.has(layer.program) && layer.wrappers.includes('xargs'))
    for (const redirect of simple.redirects) {
      if (redirect.op !== '<') continue
      for (const candidate of spellingsOf(redirect.target)) {
        if (mercurySecretPath(candidate, here) !== null || couldNameSecret(candidate, here, homes, !wordKnown(candidate))) return redirect.target
        if (secretNameBehindUnread(candidate, homes)) return candidate.replaceAll(UNREAD_PART, '$(…)')
      }
    }
    for (const word of simple.input === undefined ? [] : simple.input.split(/\s+/)) {
      for (const candidate of spellingsOf(word)) {
        if (mercurySecretPath(candidate, here) !== null || (fedNames && couldNameSecret(candidate, here, homes, !wordKnown(candidate)))) return word
        if (fedNames && secretNameBehindUnread(candidate, homes)) return candidate.replaceAll(UNREAD_PART, '$(…)')
      }
    }
    for (const layer of layers) {
      const item = keychainItemRead(layer)
      if (item !== null) return item
      const roots = layer.findRoots !== undefined && layer.argv !== words ? layer.findRoots : []
      const tree = readsWholeTree(layer)
      const sent = filesSentOrPrinted(layer)
      const lists = layer.program === 'find' || layer.program === 'ls' || layer.program === 'get-childitem' || layer.program === 'gci' || layer.program === 'dir'
      const listing = powershell && POWERSHELL_LISTERS.has(layer.program) ? powershellListing(layer.argv) : null
      const listed = listing !== null && read.commands.some((later, index) => index > at && ((callsUnreadName(later) && receivesListing(at, simple, later, index, read)) || layersOf(later.argv).some(found => readsHandedFiles(found) && !(listing.names && searchesNamesAsText(simple, later, found, read)) && !searchesTextOfListing(simple, later, found, read.commands)))) ? listing : null
      const feeds = lists && (fed.has(at) || listed !== null || read.commands.some(later => sharesEarlierStage(simple, later) && layersOf(later.argv).some(found => found.wrappers.includes('xargs') || found.program === 'xargs')) || (!powershell && layer.program === 'find' && loopedToReader(at, simple)))
      for (const word of [...layer.argv.slice(1), ...roots, ...(listed === null ? [] : listed.roots), ...(layer.program === 'findstr' ? findstrFolderFiles(layer.argv.slice(1)) : []), ...(gitGrepRoots(layer, here) ?? []), ...(layer.program === 'find' && layer.findRoots?.length === 0 ? ['.'] : []), ...(!powershell && !fed.has(at) && (layer.program === 'ls' || layer.program === 'dir') && layer.argv.slice(1).every(word => word.startsWith('-')) ? ['.'] : [])]) {
        for (const candidate of [...spellingsOf(powershell ? standingSpelled(word) : word), ...underOtherHomes(word, read.homes)]) {
          if (mercurySecretPath(candidate, here) !== null || ((FILE_READERS.has(layer.program) || sent.has(word) || handedToReader(at, simple)) && couldNameSecret(candidate, here, homes, !wordKnown(candidate)))) return word
          if ((FILE_READERS.has(layer.program) || UPLOADERS.has(layer.program) || sent.has(word)) && secretNameBehindUnread(candidate, homes)) return candidate.replaceAll(UNREAD_PART, '$(…)')
          if ((tree || feeds) && namesMercuryHome(candidate, here, homes)) return stayed && word === '.' ? whereItStays(here) : word
        }
      }
      const searcher = searcherOf(layer)
      const piped = simple.input !== undefined || simple.stages.some(stage => stage.stage > 0) || simple.redirects.some(redirect => redirect.op === '<')
      if (searcher !== undefined && !piped && namesMercuryHome('.', here, homes) && treeReadRoots(searcher, false, here, true).includes('.')) return stayed ? whereItStays(here) : '.'
      const finder = layer.program === 'find' ? layer : layer.findRoots === undefined ? undefined : layers.find(outer => outer.program === 'find')
      const whole = finder === undefined ? tree || (listed !== null && !listed.sifts.some(patterns => namesNoSecret(patterns, homes)) && (listed.deep || listed.patterned.some(word => globNamesStore(word, here, homes, true, true)))) : findNamesASecret(finder.argv, homes) && (layer === finder ? feeds : !FIND_NON_READERS.has(layer.program))
      if (!whole) continue
      const handed = simple.input !== undefined || simple.stages.some(stage => stage.stage > 0) || simple.redirects.some(redirect => redirect.op === '<')
      const hidden = layer.program !== 'rg' || ripgrepReachesHidden(layer, simple, read)
      const held = finder !== undefined ? (finder.findRoots === undefined || finder.findRoots.length === 0 ? ['.'] : finder.findRoots) : listed !== null ? listed.roots : treeReadRoots(layer, handed, here, holdsMercuryHome('.', here, homes, hidden))
      const depth = finder === undefined || (layer !== finder && tree) || layers.filter(found => found.program === 'find').length !== 1 ? undefined : findMaxDepth(finder.argv)
      for (const root of held.flatMap(one => (powershell && !wordKnown(standingSpelled(one)) ? [one, '.'] : [one]))) {
        for (const candidate of [...spellingsOf(powershell ? standingSpelled(root) : root), ...underOtherHomes(root, read.homes)]) {
          if (depth !== undefined && wordKnown(candidate) && !GLOB_PART.test(candidate) && storeBelowDepth(candidate, here, homes, depth)) continue
          if (holdsMercuryHome(candidate, here, homes, hidden) || globNamesStore(candidate, here, homes, hidden)) return stayed && root === '.' ? whereItStays(here) : `the whole of ${root === '.' || (powershell && standingSpelled(root) === '.') ? 'this folder' : root} (name a folder beneath it)`
        }
      }
    }
  }
  for (const [at, simple] of read.commands.entries()) {
    if (!foldersAfter(read, at, cwd).lost) continue
    for (const word of [...simple.redirects.filter(redirect => redirect.op === '<').map(redirect => redirect.target), ...layersOf(simple.argv).flatMap(layer => layer.argv.slice(1))]) {
      if (word === '' || /^(?:[/~-]|[A-Za-z]:)/.test(word) || word.includes(UNREAD_PART)) continue
      for (const home of homes) if (mercurySecretPath(word, home) !== null) return word
    }
  }
  const words = unreadWords(read, command, powershell)
  if (words.length > 0) {
    const stands = namesMercuryHome('.', cwd, homes)
    const needles = [...SECRET_NAME_SAMPLES, ...homes.flatMap(secretsHeld), ...homes.map(home => posix.basename(home))].map(name => name.toLowerCase())
    for (const word of words) {
      const lower = word.toLowerCase()
      if (!needles.some(needle => lower.includes(needle)) && !/^[~$%]/.test(word) && !(stands && (word === '.' || word.startsWith('./') || GLOB_PART.test(word)))) continue
      for (const candidate of spellingsOf(powershell ? standingSpelled(word) : word)) {
        const names = mercurySecretPath(candidate, cwd) !== null || namesMercuryHome(candidate, cwd, homes) || (wordKnown(candidate) && couldNameSecret(candidate, cwd, homes)) || (!/^(?:[/~-]|[A-Za-z]:)/.test(candidate) && homes.some(home => mercurySecretPath(candidate, home) !== null))
        if (names) return `${word} (${UNREAD_ADVICE})`
      }
    }
  }
  return null
}

export async function namedMercurySecretPath(command: string, powershell: boolean, cwd: string): Promise<string | null> {
  const expanded = expandShellConstants(command, powershell)
  const pending = [expanded]
  while (pending.length) {
    const text = pending.pop()!
    for (const match of text.matchAll(/"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'();|<>=]+)/g)) {
      const token = match[1] ?? match[2] ?? match[3]!
      if (mercurySecretPath(token, cwd) !== null) return token
      if (token.length < text.length && /["']/.test(token)) pending.push(token)
    }
  }
  return walkShellCommands(command, powershell, ({ argv, cwd, text, powershell: ps }) => {
    if (ps) {
      for (const call of text.matchAll(/(?:^|[;\n])\s*\[(?:System\.)?IO\.File\]::(?:ReadAllText|ReadAllBytes|ReadAllLines|ReadLines|OpenRead)\s*\(\s*(['"])([^'"\r\n]+)\1/gi)) {
        const hit = mercurySecretPath(call[2]!, cwd)
        if (hit !== null) return hit
      }
    }
    for (const path of readOperands(argv)) {
      const hit = mercurySecretPath(path, cwd)
      if (hit !== null) return path.includes('/') || path.includes('\\') ? path : hit
    }
    const name = verb(argv[0] ?? '')
    const flag = argv.findIndex((word, i) => i > 0 && /^-(?:e|c|p|command)$/i.test(word))
    if (/^(?:node|bun|python[\d.]*|ruby|perl)$/.test(name) && flag >= 0) {
      const script = argv.slice(flag + 1).join(' ')
      for (const target of inlineScriptReads(script)) {
        const hit = mercurySecretPath(target, cwd)
        if (hit !== null) return target.includes('/') || target.includes('\\') ? target : hit
      }
    }
    return null
  }, cwd)
}
