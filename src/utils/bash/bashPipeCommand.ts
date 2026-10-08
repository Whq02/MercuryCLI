export function rearrangePipeCommand(command: string): string {
  return `'${command.split("'").join("'\\''")}' < /dev/null`
}
