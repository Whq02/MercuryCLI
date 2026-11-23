import { writeSync } from 'node:fs'
import { setFlagEnv } from '../../platform/substrate/flagRegistry.js'
import { writeErr } from './cli.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { isOneOf } from '../../platform/primitives/isOneOf.js'

export async function healthAction(options: {
  json: boolean
  deep: boolean
  fix: boolean
  only?: string
  yes: boolean
}): Promise<void> {
  const { resolveHealthPresentation, renderPlainCertificate, writeOutAndExit } = await import(
    '../../commands/verbs/healthPresentation.js'
  )
  if (options.fix) {
    const { runHealthFixCli } = await import('../../commands/verbs/healthJson.js')
    await runHealthFixCli({ only: options.only, yes: options.yes })
    return
  }
  const presentation = resolveHealthPresentation(
    { json: options.json },
    { stdoutIsTTY: Boolean(process.stdout.isTTY), stdinIsTTY: Boolean(process.stdin.isTTY) },
  )
  if (presentation.output === 'json') {
    const { runHealthJsonCli } = await import('../../commands/verbs/healthJson.js')
    await runHealthJsonCli({ deep: options.deep, only: options.only })
    return
  }
  if (presentation.output === 'text' || presentation.depth === 'deep' || options.only !== undefined) {
    const { beginReadOnlyDiagnostic } = await import('../../platform/logs/diagnosticReadOnly.js')
    beginReadOnlyDiagnostic(options.only)
    const { runAndRecordHealthReport } = await import('../../platform/health/healthReport.js')
    let completed = 0
    const cert = await runAndRecordHealthReport({
      depth: options.deep ? 'deep' : 'fast',
      onProgress: event => {
        completed++
        process.stderr.write(`[health] ${completed}/${event.total} ${event.check.id}: ${event.check.status}\n`)
      },
    })
    if (options.only !== undefined) {
      const { filterCertificateToCheck, flattenChecks } = await import('../../platform/health/healthCertCore.js')
      const filtered = filterCertificateToCheck(cert, options.only)
      if (filtered === null) {
        writeErr(
          `No health check has id '${options.only}'. Known ids: ${flattenChecks(cert)
            .map(c => c.id)
            .join(', ')}`,
        )
        process.exit(1)
      }
      return writeOutAndExit(renderPlainCertificate(filtered), filtered.verdict === 'fault' ? 3 : 0)
    }
    return writeOutAndExit(renderPlainCertificate(cert), cert.verdict === 'fault' ? 3 : 0)
  }
  const { healthHandler } = await import('../../commands/verbs/setupTokenAndHealth.js')
  const { createRoot } = await import('../../screen/themedRenderer.js')
  await healthHandler(await createRoot())
}

export async function showAction(
  imagePath: string,
  options: { protocol?: string; cols?: number },
): Promise<void> {
  const accepted = ['iterm', 'kitty', 'sixel', 'cells'] as const
  try {
    if (options.protocol !== undefined) {
      if (!isOneOf(accepted, options.protocol)) {
        writeErr(
          `Unknown protocol '${options.protocol}'. Accepted: ${accepted.join(', ')}.`,
        )
        process.exit(1)
      }
      setFlagEnv('MERCURY_IMAGE_PROTOCOL', options.protocol)
    }
    {
      const { readSync: readBytes, openSync: openFd, closeSync: closeFd } = await import('node:fs')
      const head = Buffer.alloc(12)
      try {
        const fd = openFd(imagePath, 'r')
        try {
          readBytes(fd, head, 0, 12, 0)
        } finally {
          closeFd(fd)
        }
      } catch (error) {
        writeErr(`Cannot read ${imagePath}: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
      const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47
      const isJpeg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
      const isGif = head.subarray(0, 3).toString('latin1') === 'GIF'
      const isWebp = head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP'
      if (!isPng && !isJpeg && !isGif && !isWebp) {
        writeErr(`${imagePath} is not an image file (no PNG/JPEG/GIF/WebP signature) — nothing was rendered.`)
        process.exit(1)
      }
    }
    const { renderImageForTerminal } = await import('../../screen/image-display/imageDisplay.js')
    const rendered = await renderImageForTerminal(imagePath, {
      maxCols: options.cols ?? 76,
    })
    const payload = rendered.payload
    await new Promise<void>((resolvePromise, rejectPromise) => {
      process.stdout.write(`${payload}\n`, error => (error ? rejectPromise(error) : resolvePromise()))
    })
    try {
      writeSync(2, `[${rendered.protocol}] ${imagePath}\n`)
    } catch (error) {
      passedOver(error)
    }
    process.exit(0)
  } catch (error) {
    writeErr(`Failed to display the image: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
