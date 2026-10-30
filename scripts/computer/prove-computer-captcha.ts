import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, finish, scratchDir } from './computerProofKit.ts'
import { allowEverything, resultOf, toolContext, toolUseTurn, withScreenshot } from './computerToolKit.ts'

const { ComputerTool } = await import('../../src/tools/ComputerTool/ComputerTool.ts')
const { resolveDesktopDriver, resetDesktopDriverForTest } = await import('../../src/services/desktop/resolveDriver.ts')
const scratch = scratchDir('captcha')
let calls = 0
for (const marker of ['reCAPTCHA', 'hCaptcha', 'Turnstile', 'Verify you are human']) {
  const scene = join(scratch, `${calls}.json`)
  writeFileSync(scene, JSON.stringify({ tree: [{ role: 'AXGroup', title: marker, frame: { x: 100, y: 100, width: 250, height: 100 } }] }))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
  resetDesktopDriverForTest()
  const resolved = resolveDesktopDriver()
  if (resolved.state !== 'ok') throw new Error(resolved.note)
  const driver = resolved.driver as typeof resolved.driver & { acts: { act: string }[] }
  const context = (await withScreenshot(ComputerTool as never, toolContext(), `captcha-${++calls}`)).context
  const input = { action: 'click', x: 120, y: 120, capture: false }
  await ComputerTool.checkPermissions(input as never, context)
  const out = resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`captcha-act-${calls}`, 'Computer', input)))
  check(`${marker}: named challenges hand off to the operator`, out.outcome === 'failed' && /captcha/i.test(out.result) && /operator/i.test(out.result), out.result)
  check(`${marker}: no input is sent`, !driver.acts.some(a => ['click', 'typeText', 'keyTap'].includes(a.act)))
}
const badge = [
  { role: 'AXLink', title: 'Pages', frame: { x: 20, y: 200, width: 100, height: 20 } },
  { role: 'AXGroup', title: 'reCAPTCHA', frame: { x: 100, y: 900, width: 250, height: 60 } },
  { role: 'AXStaticText', title: 'protected by ', frame: { x: 110, y: 910, width: 80, height: 20 } },
  { role: 'AXStaticText', title: 'reCAPTCHA', frame: { x: 190, y: 910, width: 80, height: 20 } },
  { role: 'AXLink', title: 'Privacy', frame: { x: 110, y: 935, width: 50, height: 20 } },
  { role: 'AXLink', title: 'Terms', frame: { x: 170, y: 935, width: 50, height: 20 } },
]
for (const [label, tree, refused] of [
  ['the attribution badge alone', badge, false],
  ['the badge beside a real checkbox', [...badge, { role: 'AXCheckBox', title: "I'm not a robot", frame: { x: 100, y: 400, width: 200, height: 40 } }], true],
] as const) {
  const scene = join(scratch, `${++calls}.json`)
  writeFileSync(scene, JSON.stringify({ tree }))
  process.env.MERCURY_DESKTOP_FAKE_SCENE = scene
  resetDesktopDriverForTest()
  const resolved = resolveDesktopDriver()
  if (resolved.state !== 'ok') throw new Error(resolved.note)
  const driver = resolved.driver as typeof resolved.driver & { acts: { act: string }[] }
  const context = (await withScreenshot(ComputerTool as never, toolContext(), `captcha-${calls}`)).context
  const input = { action: 'click', x: 60, y: 210, capture: false }
  await ComputerTool.checkPermissions(input as never, context)
  const out = resultOf(await ComputerTool.call(input as never, context, allowEverything, toolUseTurn(`captcha-act-${calls}`, 'Computer', input)))
  const clicked = driver.acts.some(a => a.act === 'click')
  if (refused) check(`${label}: the click is refused and nothing is sent`, out.outcome === 'failed' && /captcha/i.test(out.result) && !clicked, out.result)
  else check(`${label}: the click goes through (a brand name beside "protected by" is attribution, not a challenge)`, out.outcome !== 'failed' && !/captcha/i.test(out.result) && clicked, out.result)
}
const context = toolContext()
const screenshotChallenge = { action: 'click', x: 10, y: 10, captcha: true, capture: false }
const explicit = await ComputerTool.validateInput!(screenshotChallenge as never, context)
check('a challenge reported from screenshot pixels is a code refusal', explicit.result === false && /captcha/i.test(explicit.message) && /operator/i.test(explicit.message), JSON.stringify(explicit))
const prompt = await ComputerTool.prompt({ getToolPermissionContext: async () => context.getAppState().toolPermissionContext, tools: [], agents: [] })
check('prompt forbids solving visual and accessible captchas', /never solve/i.test(prompt) && prompt.includes('captcha:true') && /screenshot/i.test(prompt), prompt)
finish('prove-computer-captcha')
