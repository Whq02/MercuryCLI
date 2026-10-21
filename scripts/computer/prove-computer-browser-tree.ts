import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { check, finish, scratchDir, section, sourceText } from './computerProofKit.ts'

const { DESKTOP_ADDON_EXPORTS } = await import('../../src/services/desktop/pack.ts')
const { resolveNativeDesktopDriver, resetNativeDesktopDriverForTest } = await import('../../src/services/desktop/nativeDriver.ts')
const scratch = scratchDir('browser-tree')
const trace = join(scratch, 'trace.jsonl')
const addon = join(scratch, 'fixture.cjs')
const app = { identity: 'com.google.Chrome', name: 'Chrome', pid: 2468, title: 'Page', windowId: 'front', bounds: { x: 0, y: 0, width: 800, height: 600 } }
writeFileSync(addon, `const fs=require('node:fs'); const trace=${JSON.stringify(trace)}; const out={}; for(const key of ${JSON.stringify(DESKTOP_ADDON_EXPORTS)}) out[key]=()=>{throw new Error('unexpected live-shaped call '+key)}; out.packVersion=()=>'fixture'; out.permissions=()=>({session:'desktop',screenCapture:'granted',input:'granted'}); out.accessibilityTree=(pid,depth,count,scope,request)=>{ fs.appendFileSync(trace,JSON.stringify({pid,depth,count,scope,request})+'\\n'); return {elements:[{depth:0,role:'AXTextField',title:'Search',value:'ready',frame:{x:1,y:2,width:80,height:20},focused:true}],truncated:false,scope:scope||null,webContent:request?'pending':'available',webAccessibility:request===true}; }; module.exports=out;`)
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
if (begin >= 0 && end > begin) {
  const source = join(scratch, 'tree-order.rs')
  const binary = join(scratch, 'tree-order')
  writeFileSync(source, lib.slice(begin, end))
  const built = spawnSync('rustc', ['--edition=2021', '--test', source, '-o', binary], { encoding: 'utf8', env: process.env })
  check('the real native ordering code compiles without desktop APIs', built.status === 0, built.stderr)
  if (built.status === 0) {
    const tested = spawnSync(binary, ['--test-threads=1'], { encoding: 'utf8', env: process.env })
    check('focused-window ordering and unknown-window refusal pass in Rust', tested.status === 0 && tested.stdout.includes('1 passed'), tested.stdout + tested.stderr)
  }
}
delete process.env.MERCURY_DESKTOP_PACK_DIR
resetNativeDesktopDriverForTest()
finish('prove-computer-browser-tree')
