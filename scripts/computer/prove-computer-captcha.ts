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
const context = toolContext()
const screenshotChallenge = { action: 'click', x: 10, y: 10, captcha: true, capture: false }
const explicit = await ComputerTool.validateInput!(screenshotChallenge as never, context)
check('a challenge reported from screenshot pixels is a code refusal', explicit.result === false && /captcha/i.test(explicit.message) && /operator/i.test(explicit.message), JSON.stringify(explicit))
const prompt = await ComputerTool.prompt({ getToolPermissionContext: async () => context.getAppState().toolPermissionContext, tools: [], agents: [] })
check('prompt forbids solving visual and accessible captchas', /never solve/i.test(prompt) && prompt.includes('captcha:true') && /screenshot/i.test(prompt), prompt)
finish('prove-computer-captcha')
