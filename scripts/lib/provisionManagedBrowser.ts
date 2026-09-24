import { installManagedBrowser, planBrowserInstall } from '../../src/services/browser/browserInstall.ts'

export type ProvisionOutcome = { ok: true; buildId: string; executablePath: string } | { ok: false; note: string }

export async function provisionManagedBrowserForTheGate(log: (line: string) => void): Promise<ProvisionOutcome> {
  try {
    const plan = await planBrowserInstall()
    log(`  provisioning the managed browser for this gate: ${plan.consentLine}`)
    let reported = 0
    const installed = await installManagedBrowser(plan.buildId, (done, total) => {
      if (total > 0 && done - reported >= 40 * 1024 * 1024) {
        reported = done
        log(`  … ${Math.round(done / 1048576)} of ${Math.round(total / 1048576)} MB`)
      }
    })
    log(`  provisioned Chrome for Testing ${installed.buildId} at ${installed.executablePath}`)
    return { ok: true, buildId: installed.buildId, executablePath: installed.executablePath }
  } catch (err) {
    return { ok: false, note: err instanceof Error ? err.message : String(err) }
  }
}
