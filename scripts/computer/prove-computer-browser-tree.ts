import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { check, finish, scratchDir, section, sourceText } from './computerProofKit.ts'

const { DESKTOP_ADDON_EXPORTS } = await import('../../src/services/desktop/pack.ts')
const { resolveNativeDesktopDriver, resetNativeDesktopDriverForTest } = await import('../../src/services/desktop/nativeDriver.ts')
const scratch = scratchDir('browser-tree')
const trace = join(scratch, 'trace.jsonl')
const addon = join(scratch, 'fixture.cjs')
const app = { identity: 'com.google.Chrome', name: 'Chrome', pid: 2468, title: 'Page', windowId: 'front', bounds: { x: 0, y: 0, width: 800, height: 600 } }
writeFileSync(addon, `const fs=require('node:fs'); const trace=${JSON.stringify(trace)}; const staged=${JSON.stringify(scratch)}; const out={}; for(const key of ${JSON.stringify(DESKTOP_ADDON_EXPORTS)}) out[key]=()=>{throw new Error('unexpected live-shaped call '+key)}; out.packVersion=()=>'fixture'; out.permissions=()=>({session:'desktop',screenCapture:'granted',input:'granted'}); out.frontmostApplication=()=>JSON.parse(fs.readFileSync(staged+'/front.json','utf8')); out.accessibilityTree=(pid,depth,count,scope,request)=>{ const page=staged+'/page-'+pid; if(fs.existsSync(page)){ const staged=JSON.parse(fs.readFileSync(page,'utf8')); return {elements:[{depth:0,role:'AXWindow',title:'Draft'}],truncated:false,scope:scope||null,webContent:staged.webContent,webSurface:staged.webSurface===true,webAccessibility:staged.accepts===true&&request===true,windowId:staged.windowId||null}; } fs.appendFileSync(trace,JSON.stringify({pid,depth,count,scope,request})+'\\n'); return {elements:[{depth:0,role:'AXTextField',title:'Search',value:'ready',frame:{x:1,y:2,width:80,height:20},focused:true}],truncated:false,scope:scope||null,webContent:request?'pending':'available',webAccessibility:request===true}; }; module.exports=out;`)
writeFileSync(join(scratch, '.vendor-manifest.json'), JSON.stringify({ name: 'mercury-desktop', version: 'fixture', platform: `${process.platform}-${process.arch}`, addon: 'fixture.cjs', addonSha256: '0'.repeat(64), sourceTreeDigest: '0'.repeat(64), treeDigest: '0'.repeat(64), fileCount: 1, cargo: '', crates: [] }))
process.env.MERCURY_DESKTOP_PACK_DIR = scratch
resetNativeDesktopDriverForTest()
const resolution = resolveNativeDesktopDriver()
if (resolution.state !== 'ok') throw new Error(resolution.note)
const driver = resolution.driver
section('native adapter transports scope, focus and once-only web activation without real desktop calls')
const first = await driver.accessibilityTree(app, { depth: 32, count: 2000, scope: 'window' } as never, new AbortController().signal)
const second = await driver.accessibilityTree(app, { depth: 32, count: 2000, scope: 'window' } as never, new AbortController().signal)
const third = await driver.accessibilityTree({ ...app, pid: 2469 }, { depth: 8, count: 200, scope: 'app' } as never, new AbortController().signal)
const rows = readFileSync(trace, 'utf8').trim().split('\n').map(row => JSON.parse(row))
check('window and app scopes cross the addon boundary unchanged', rows[0]?.scope === 'window' && rows[2]?.scope === 'app', JSON.stringify(rows))
check('activation is requested once per process, not on every poll', rows[0]?.request === true && rows[1]?.request === false && rows[2]?.request === true, JSON.stringify(rows))
check('focus survives the adapter', first.ok && (first.value.elements[0] as { focused?: boolean })?.focused === true, JSON.stringify(first))
check('pending and available page content survive the adapter', first.ok && (first.value as { webContent?: string }).webContent === 'pending' && second.ok && (second.value as { webContent?: string }).webContent === 'available' && third.ok, JSON.stringify([first, second]))
const controller = new AbortController()
controller.abort()
const count = rows.length
await driver.accessibilityTree(app, { depth: 8, count: 200 }, controller.signal)
check('aborted reads never request web activation', readFileSync(trace, 'utf8').trim().split('\n').length === count)

section('native implementation names real AX requests and focuses before traversing')
const native = sourceText('native/desktop/src/mac.rs')
check('both supported web accessibility requests use the app element', native.includes('AXEnhancedUserInterface') && native.includes('AXManualAccessibility') && native.includes('AXUIElementSetAttributeValue(app,'))
check('focus uses the accessibility API, not guessed coordinates', native.includes('ax_attribute(app, "AXFocusedUIElement")') && native.includes('CFEqual(element, focused)'))
check('window scope chooses AXFocusedWindow before walking children', native.includes('ax_attribute(app, "AXFocusedWindow")') && native.includes('tree_child_order('))
const lib = sourceText('native/desktop/src/lib.rs')
check('native tree order has no-input regression tests', lib.includes('focused_window_precedes_other_windows_and_menus'))
const begin = lib.indexOf('pub fn tree_child_order(')
const end = lib.indexOf('#[napi(object)]\npub struct CursorAnswer', begin)
check('the native ordering source boundaries are present', begin >= 0 && end > begin)
const compiler = Bun.which('rustc')
if (compiler === null) {
  console.log('  [SKIP] native ordering compile and Rust tests need rustc on PATH; install the Rust toolchain to run this leg. Adapter and source checks still ran.')
} else if (begin >= 0 && end > begin) {
  const source = join(scratch, 'tree-order.rs')
  const binary = join(scratch, 'tree-order')
  writeFileSync(source, lib.slice(begin, end))
  const built = spawnSync(compiler, ['--edition=2021', '--test', source, '-o', binary], { encoding: 'utf8', env: process.env })
  check('the real native ordering code compiles without desktop APIs', built.status === 0, `${built.error?.message ?? ''} ${built.stderr ?? ''} status=${built.status} signal=${built.signal}`)
  if (built.status === 0) {
    const tested = spawnSync(binary, ['--test-threads=1'], { encoding: 'utf8', env: process.env })
    check('focused-window ordering and unknown-window refusal pass in Rust', tested.status === 0 && tested.stdout.includes('1 passed'), tested.stdout + tested.stderr)
  }
}

section("the adapter states what the application's bundle carries and what the window's tree has shown")
{
  const bundle = (name: string, files: string[]): string => {
    for (const file of files) {
      mkdirSync(dirname(join(scratch, name, file)), { recursive: true })
      writeFileSync(join(scratch, name, file), '')
    }
    return join(scratch, name)
  }
  const carrying = bundle('Shell.app', ['Contents/MacOS/Shell', 'Contents/Frameworks/Shell Framework.framework/Resources/icudtl.dat', 'Contents/Frameworks/Shell Framework.framework/Resources/resources.pak'])
  const plain = bundle('Notes.app', ['Contents/MacOS/Notes'])
  const frontOf = async (record: Record<string, unknown>) => {
    writeFileSync(join(scratch, 'front.json'), JSON.stringify({ ...app, ...record }))
    return driver.frontmostApplication()
  }
  const shell = await frontOf({ identity: 'com.example.shell', name: 'Shell', bundlePath: carrying })
  const notes = await frontOf({ identity: 'com.example.notes', name: 'Notes', bundlePath: plain })
  const bare = await frontOf({ identity: 'com.example.bare', name: 'Bare' })
  const lost = await frontOf({ identity: 'com.example.lost', name: 'Lost', bundlePath: join(scratch, 'Lost.app') })
  check('an engine in the bundle, none in it, no bundle stated and a bundle that cannot be read reach the tool as true, false and unstated', shell.ok && shell.value.webEngine === true && notes.ok && notes.value.webEngine === false && bare.ok && !('webEngine' in bare.value) && lost.ok && !('webEngine' in lost.value), JSON.stringify([shell, notes, bare, lost]))
  const page = (pid: number, state: Record<string, unknown>): void => writeFileSync(join(scratch, `page-${pid}`), JSON.stringify(state))
  const read = async (pid: number, scope: 'window' | 'app' = 'window') => {
    const tree = await driver.accessibilityTree({ ...app, identity: 'com.example.reader', pid }, { depth: 32, count: 2000, scope } as never, new AbortController().signal)
    return tree.ok ? tree.value : null
  }
  page(3001, { webContent: 'absent', windowId: 'w1' })
  const before = await read(3001)
  page(3001, { webContent: 'available', windowId: 'w1' })
  const carried = await read(3001)
  page(3001, { webContent: 'absent', windowId: 'w1' })
  const dropped = await read(3001)
  page(3001, { webContent: 'absent', windowId: 'w2' })
  const other = await read(3001)
  check('a window whose tree has carried a web area is stated as one that has shown a page surface from then on, and only that window: the tree read names the window it walked', before?.webContent === 'absent' && before.webSurface === undefined && carried?.webContent === 'available' && carried.webSurface === true && dropped?.webContent === 'absent' && dropped.webSurface === true && other?.webContent === 'absent' && other.webSurface === undefined, JSON.stringify([before, carried, dropped, other]))
  page(3005, { webContent: 'available' })
  const wholeApplication = await read(3005, 'app')
  page(3005, { webContent: 'absent', windowId: 'w1' })
  const nativeWindow = await read(3005)
  page(3005, { webContent: 'absent' })
  const applicationAgain = await read(3005, 'app')
  check("a web area that an application-scope read found in another window marks the application's later application-scope reads, never the focused window's own", wholeApplication?.webContent === 'available' && nativeWindow?.webContent === 'absent' && nativeWindow.webSurface === undefined && applicationAgain?.webContent === 'absent' && applicationAgain.webSurface === true, JSON.stringify([wholeApplication, nativeWindow, applicationAgain]))
  page(3006, { webContent: 'available' })
  const unnamed = await read(3006)
  page(3006, { webContent: 'absent' })
  const unnamedLater = await read(3006)
  check('a window read that names no window keeps no history: a second window cannot inherit the first one\'s page', unnamed?.webContent === 'available' && unnamedLater?.webContent === 'absent' && unnamedLater.webSurface === undefined, JSON.stringify([unnamed, unnamedLater]))
  page(3002, { webContent: 'absent', webSurface: true, windowId: 'w1' })
  const surfaced = await read(3002)
  check("an engine's element the native walk reports reaches the tool on a tree that carries no page", surfaced?.webContent === 'absent' && surfaced.webSurface === true, JSON.stringify(surfaced))
  page(3003, { webContent: 'absent', accepts: true, windowId: 'w1' })
  const asked = await read(3003)
  const within = await read(3003)
  const clock = Date.now
  Date.now = () => clock() + 2001
  const after = await read(3003)
  Date.now = clock
  page(3004, { webContent: 'absent', windowId: 'w1' })
  const unasked = await read(3004)
  check('a tree with no page reads as still starting for the two seconds after its application accepted the web accessibility request, as absent after them, and as absent at once where no request was accepted', asked?.webContent === 'pending' && within?.webContent === 'pending' && after?.webContent === 'absent' && unasked?.webContent === 'absent', JSON.stringify([asked?.webContent, within?.webContent, after?.webContent, unasked?.webContent]))
}
delete process.env.MERCURY_DESKTOP_PACK_DIR
resetNativeDesktopDriverForTest()
finish('prove-computer-browser-tree')
