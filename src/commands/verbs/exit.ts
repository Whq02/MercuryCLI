export function cliError(msg?: string): never {
  if (msg !== undefined) console.error(msg)
  process.exit(1)
}

export function cliJsonError(msg?: string): never {
  if (msg !== undefined) process.stdout.write(`${msg}\n`)
  process.exit(1)
}

export function cliOk(msg?: string): never {
  if (msg !== undefined) process.stdout.write(`${msg}\n`)
  process.exit(0)
}
