
const COMMON_SWITCHES: string[] = ['-verbose', '-debug']

const COMMON_VALUE_PARAMS: string[] = [
  '-erroraction', '-warningaction', '-informationaction', '-progressaction',
  '-errorvariable', '-warningvariable', '-informationvariable', '-outvariable',
  '-outbuffer', '-pipelinevariable',
]

export const COMMON_PARAMETERS: ReadonlySet<string> = new Set([...COMMON_SWITCHES, ...COMMON_VALUE_PARAMS])
