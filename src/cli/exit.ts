
export function cliError(msg?: string): never {
  if (msg !== undefined) {
    console.error(msg)
  }
  process.exit(1)
  return undefined as never
}

export function cliOk(msg?: string): never {
  if (msg !== undefined) {
    process.stdout.write(`${msg}\n`)
  }
  process.exit(0)
  return undefined as never
}
