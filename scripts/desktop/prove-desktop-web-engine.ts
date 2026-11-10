#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-web-engine-')))

let checks = 0
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
  if (!cond) failures++
}

const { bundleWebEngine } = await import('../../src/services/desktop/webEngine.ts')

function bundle(name: string, files: string[]): string {
  const root = join(SCRATCH, name)
  mkdirSync(root, { recursive: true })
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), '')
  }
  return root
}

const reads = (rows: Array<[string, string, boolean | undefined]>): string => rows.filter(([, path, expected]) => bundleWebEngine(path) !== expected).map(([words, path, expected]) => `${words}: ${String(bundleWebEngine(path))}, expected ${String(expected)}`).join(' · ')

console.log('\nan application bundle: the engine is read from what the bundle carries, whatever it is called')
{
  const flat = 'Contents/Frameworks/Any Name.framework/Resources'
  const carrying: Array<[string, string, boolean | undefined]> = [
    ['a framework whose resources hold the ICU data beside a resource pack', bundle('Voyager.app', ['Contents/MacOS/Voyager', `${flat}/icudtl.dat`, `${flat}/resources.pak`]), true],
    ['the same under an embedded-framework name with another pack', bundle('Embedder.app', ['Contents/MacOS/Embedder', 'Contents/Frameworks/Embedded Framework.framework/Resources/icudtl.dat', 'Contents/Frameworks/Embedded Framework.framework/Resources/embedded_100_percent.pak']), true],
    ['XUL beside the executable', bundle('Fox.app', ['Contents/MacOS/fox', 'Contents/MacOS/XUL', 'Contents/Resources/omni.ja']), true],
  ]
  check('a Chromium framework and a Gecko library are an engine', reads(carrying) === '', reads(carrying))
  const versioned = bundle('Versioned.app', ['Contents/MacOS/Versioned', 'Contents/Frameworks/Versioned Framework.framework/Versions/9.0.1/Resources/icudtl.dat', 'Contents/Frameworks/Versioned Framework.framework/Versions/9.0.1/Resources/resources.pak'])
  let linked = true
  try {
    symlinkSync(join('Versions', '9.0.1', 'Resources'), join(versioned, 'Contents', 'Frameworks', 'Versioned Framework.framework', 'Resources'), 'dir')
  } catch {
    linked = false
  }
  if (linked) check("a versioned framework is read through its Resources link, as the vendors' bundles are laid out", bundleWebEngine(versioned) === true, String(bundleWebEngine(versioned)))
  else console.log('  [SKIP] this platform refused a directory link; the versioned layout is read on the others')
  const without: Array<[string, string, boolean | undefined]> = [
    ['an executable alone', bundle('Notes.app', ['Contents/MacOS/Notes', 'Contents/Info.plist']), false],
    ['frameworks that carry no engine', bundle('Editor.app', ['Contents/MacOS/Editor', 'Contents/Frameworks/Updater.framework/Resources/Info.plist', 'Contents/Frameworks/Charts.framework/Resources/Assets.car']), false],
    ['ICU data with no resource pack beside it', bundle('Toolkit.app', ['Contents/MacOS/Toolkit', 'Contents/Frameworks/Toolkit.framework/Resources/icudtl.dat']), false],
    ['a pack with no ICU data beside it', bundle('Game.app', ['Contents/MacOS/Game', 'Contents/Frameworks/Assets.framework/Resources/data.pak']), false],
    ['ICU data and a pack in two different frameworks', bundle('Split.app', ['Contents/MacOS/Split', 'Contents/Frameworks/One.framework/Resources/icudtl.dat', 'Contents/Frameworks/Two.framework/Resources/data.pak']), false],
  ]
  check('a bundle that carries neither is read as holding no engine', reads(without) === '', reads(without))
}

console.log("\nan image's folder: the same reading where an application is a folder beside its executable")
{
  const carrying: Array<[string, string, boolean | undefined]> = [
    ['the packs beside the executable', bundle('shell', ['Shell.exe', 'icudtl.dat', 'resources.pak', 'chrome_100_percent.pak']), true],
    ['the packs in a version folder beside it', bundle('browser/Application', ['browser.exe', '142.0.7444.60/browser.dll', '142.0.7444.60/icudtl.dat', '142.0.7444.60/resources.pak']), true],
    ['the names in another case', bundle('upper', ['UPPER.EXE', 'ICUDTL.DAT', 'RESOURCES.PAK']), true],
    ['xul.dll beside the executable', bundle('fox', ['fox.exe', 'xul.dll']), true],
    ['the system web view loader beside the executable', bundle('host', ['Host.exe', 'WebView2Loader.dll']), true],
    ["the system web view's projection beside the executable", bundle('packaged', ['Packaged.exe', 'Microsoft.Web.WebView2.Core.dll']), true],
  ]
  check('an engine, or the loader of the system web view, beside the image is read', reads(carrying) === '', reads(carrying))
  const without: Array<[string, string, boolean | undefined]> = [
    ['an executable and its own library', bundle('notepad', ['Notepad.exe', 'Notepad.dll']), false],
    ['a version folder that holds no engine', bundle('updater', ['App.exe', '1.2.3/plugin.dll']), false],
    ['packs in a folder that is no version folder', bundle('game', ['Game.exe', 'data/icudtl.dat', 'data/resources.pak']), false],
  ]
  check('a folder that carries none is read as holding no engine', reads(without) === '', reads(without))
}

console.log('\nwhat cannot be read is not answered, and a bundle is read once')
{
  const late = join(SCRATCH, 'Late.app')
  check('a path that does not exist is not answered', bundleWebEngine(late) === undefined, String(bundleWebEngine(late)))
  const file = join(bundle('Plain.app', ['Contents/MacOS/Plain']), 'Contents', 'MacOS', 'Plain')
  check('a path that is a file is not answered', bundleWebEngine(file) === undefined, String(bundleWebEngine(file)))
  bundle('Late.app', ['Contents/MacOS/Late'])
  check('a path that could not be read is read again when it is asked again', bundleWebEngine(late) === false, String(bundleWebEngine(late)))
  const once = bundle('Once.app', ['Contents/MacOS/Once', 'Contents/Frameworks/Once Framework.framework/Resources/icudtl.dat', 'Contents/Frameworks/Once Framework.framework/Resources/resources.pak'])
  const first = bundleWebEngine(once)
  rmSync(once, { recursive: true, force: true })
  check('a bundle that was read is not read again', first === true && bundleWebEngine(once) === true, `${String(first)} then ${String(bundleWebEngine(once))}`)
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\nprove-desktop-web-engine: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
