import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '../..')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const command = (await import('../../src/commands/status/index.js')).default
const popup = await import('../../src/utils/cockpit/settingsPopup.js')
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
}
check('status is a private local screen command', command.type === 'local' && command.seat === 'screen' && command.userPrivate === true && command.supportsNonInteractive === false)
if (command.type === 'local') {
  const { getDefaultMainLoopModel } = await import('../../src/utils/model/model.js')
  const context = { messages: [], options: { mainLoopModel: getDefaultMainLoopModel() } } as never
  const loaded = await command.load()
  let first = ''
  for (const args of ['', 'anything']) {
    popup.closeSettingsPopup()
    const result = await loaded.call(args, context)
    const request = popup.settingsPopupRequest()
    check(`/status ${args}: the popup opens without a dialog or receipt`, result.type === 'skip' && request?.view === 'status' && request.width === 110 && request.rows === null)
    const body = request?.body({ width: 110, inner: 106, rowBudget: 44 }) as { props?: { width: number; rowBudget: number; onClose: () => void } } | undefined
    check(`/status ${args}: the shell geometry reaches the body unchanged`, body?.props?.width === 106 && body.props.rowBudget === 44)
    check(`/status ${args}: the context and hint use the page grammar`, /^session snapshot · \d{2}:\d{2} · .+ · .+$/.test(request?.line ?? '') && request?.hint === 'esc or click outside closes · /accounts · /usage · /health')
    const snapshot = JSON.stringify(request && { view: request.view, width: request.width, rows: request.rows, hint: request.hint, bodyType: (body as { type?: { name?: string } })?.type?.name, inner: body?.props?.width, rowBudget: body?.props?.rowBudget })
    if (args === '') first = snapshot
    else check('an argument opens the same popup road as bare status', snapshot === first)
    body?.props?.onClose()
    check(`/status ${args}: the body close callback closes the same store`, !popup.isSettingsPopupOpen())
  }
}
check('the two retired face modules are absent', !existsSync(join(ROOT, 'src/components/Settings/Status.tsx')) && !existsSync(join(ROOT, 'src/commands/status/status.tsx')))
const stale: string[] = []
function census(dir: string): void {
  for (const file of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, file.name)
    if (file.isDirectory()) census(path)
    else if (/\.tsx?$/.test(file.name)) {
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)) {
        const target = resolve(dirname(path), match[2]!)
        if (target === join(ROOT, 'src/components/Settings/Status.js') || target === join(ROOT, 'src/commands/status/status.js')) stale.push(path.slice(ROOT.length + 1))
      }
    }
  }
}
census(join(ROOT, 'src'))
check('no source module imports either retired face', stale.length === 0, stale.join(', '))
console.log(`one status face: ${failures} failures`)
process.exit(failures ? 1 : 0)
