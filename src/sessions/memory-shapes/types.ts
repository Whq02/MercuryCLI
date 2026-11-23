export const INSTRUCTION_FILE_TYPE_VALUES = ['User', 'Project', 'Local', 'Managed'] as const

export type InstructionFileType = (typeof INSTRUCTION_FILE_TYPE_VALUES)[number]
