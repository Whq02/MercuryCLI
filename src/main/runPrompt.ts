import { writeSync } from 'node:fs'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { failCli, writeErr, type RootOptions } from './cli.js'

export async function readRunPrompt({ opts, inputPrompt, runMode, runnerDoor, inputFormat, mainThreadAgentDefinition, cliName }: {
  opts: RootOptions
  inputPrompt: string | undefined
  runMode: boolean
  runnerDoor: boolean
  inputFormat: string
  mainThreadAgentDefinition: AgentDefinition | undefined
  cliName: string
}): Promise<{ prompt: string | AsyncIterable<string> | undefined; syntaxInput: string | undefined }> {
  let prompt: string | AsyncIterable<string> | undefined = inputPrompt
  let syntaxInput: string | undefined
  if (runnerDoor) {
    prompt = noStdinChunks()
  } else if (!process.stdin.isTTY) {
    if (inputFormat === 'rows') {
      prompt = readStdinChunks()
    } else {
      const collected = await readStdinWithPeek(runMode ? (inputPrompt === undefined ? -1 : 1_000) : 3000)
      if (collected === null && runMode && inputPrompt === undefined) failCli('mercury run could not read its prompt from stdin', 1)
      if (collected === null && inputPrompt === undefined) {
        writeErr(
          'No stdin data arrived within 3s; proceeding without piped input. Redirect from the null device to skip the wait, or keep the pipe open longer to include its data.',
        )
      }
      const pieces = [inputPrompt, collected ?? undefined].filter(
        (piece): piece is string => typeof piece === 'string' && piece.length > 0,
      )
      if (runMode && collected) syntaxInput = inputPrompt ?? ''
      prompt = runMode && inputPrompt && collected
        ? `${inputPrompt}\n\n<stdin>\n${collected}${collected.endsWith('\n') ? '' : '\n'}</stdin>`
        : pieces.length > 0 ? pieces.join('\n') : undefined
    }
  }

  if (
    (runMode || !process.stdout.isTTY) &&
    prompt === undefined &&
    !opts.resume &&
    !opts.continue &&
    !opts.pr &&
    inputFormat !== 'rows' &&
    mainThreadAgentDefinition?.initialPrompt == null
  ) {
    const variadicCandidates: Array<[string, unknown]> = [
      ['--allowed-tools', opts.allowedTools],
      ['--block-tools', opts.blockTools],
      ['--toolset', opts.toolset],
      ['--mcp', opts.mcp],
      ['--provider-preview', opts.providerPreview],
    ]
    const multi = variadicCandidates.filter(
      (pair): pair is [string, string[]] => Array.isArray(pair[1]) && pair[1].length >= 2,
    )
    const lastArgvToken = process.argv[process.argv.length - 1]
    const swallower =
      multi.find(([, values]) => values[values.length - 1] === lastArgvToken) ?? multi[0]
    if (swallower) {
      const [flag, values] = swallower
      const lastValue = values[values.length - 1] ?? ''
      failCli(
        `No prompt reached run, and the list flag ${flag} captured ${values.length} values — ` +
          `its last value ${JSON.stringify(lastValue)} may have been meant as the prompt ` +
          `(a variadic flag consumes every following bare argument). ` +
          `Put the prompt before the flag, or end the list with -- : ` +
          `${cliName} run ${flag} "..." -- "your prompt". ` +
          `If every value really is a list entry, provide the prompt via stdin or as a positional argument.`,
      )
    }
  }

  if (mainThreadAgentDefinition?.initialPrompt) {
    if (typeof prompt === 'string') {
      prompt = `${mainThreadAgentDefinition.initialPrompt}\n${prompt}`
      if (syntaxInput !== undefined) syntaxInput = `${mainThreadAgentDefinition.initialPrompt}\n${syntaxInput}`
    } else if (prompt === undefined) {
      prompt = mainThreadAgentDefinition.initialPrompt
    }
  }

  if (runMode && inputFormat === 'text' && (prompt === undefined || (typeof prompt === 'string' && !prompt.trim())) && !opts.resume && !opts.continue && !opts.pr) {
    const debugFilter = typeof opts.debug === 'string' && /\s/.test(opts.debug.trim()) ? opts.debug : null
    const usage = debugFilter !== null
      ? `No prompt reached run: --debug took ${JSON.stringify(debugFilter)} as its category filter. Put the prompt before --debug, or use -d: mercury run ${JSON.stringify(debugFilter)} --debug`
      : 'Usage: mercury run "<prompt>" or pipe a prompt to mercury run -'
    if (process.stdin.isTTY) {
      writeSync(2, `${usage}\n`)
      process.exit(2)
    }
    failCli(usage)
  }
  return { prompt, syntaxInput }
}

async function* readStdinChunks(): AsyncIterable<string> {
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) yield chunk as string
}

async function* noStdinChunks(): AsyncIterable<string> {}

function readStdinWithPeek(timeoutMs: number): Promise<string | null> {
  return new Promise(resolvePeek => {
    const chunks: string[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    const armSilence = (): void => {
      if (timeoutMs < 0) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => finish(null), timeoutMs)
    }
    const onData = (chunk: string): void => {
      chunks.push(chunk)
      armSilence()
    }
    const finish = (empty: string | null): void => {
      if (timer !== undefined) clearTimeout(timer)
      process.stdin.pause()
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('error', onError)
      resolvePeek(chunks.length > 0 ? chunks.join('') : empty)
    }
    const onEnd = (): void => finish('')
    const onError = (): void => finish(null)
    armSilence()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.once('error', onError)
  })
}
