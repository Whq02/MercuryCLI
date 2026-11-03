import { changeTransactionEnabled } from '../../services/changeTransaction/contracts.js'

export const AST_EDIT_TOOL_NAME = 'AstEdit'

export function getAstEditDescription(): string {
  return `Rewrites every match of a syntax pattern across files as one change: each match is replaced by the rewrite built from its captures. A call without apply is a dry run that returns the unified diff per file and a plan token and writes nothing; the same call with apply: true and that plan writes the change after the edit permission ask, atomically with rollback and a re-read of every file, and returns one change receipt${changeTransactionEnabled() ? " naming each file's new anchor" : ''}.`
}
