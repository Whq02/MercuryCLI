import * as fs from 'node:fs'
import * as path from 'node:path'
import type * as TS from 'typescript'
import { RPC_INTERNAL_ERROR } from '../../../sidecarFraming.js'
import { fromUri } from '../lsp.js'
import { positionLabel } from '../renameSafety.js'
import { fileTextChangesToDocumentChanges, declarationNamesOf, FORMAT_OPTIONS } from '../convert.js'
import type { DocContext } from '../needs.js'

export function moveToFileRequest(params: unknown, docContext: DocContext): unknown {
  const { st, project, file, offset } = docContext(params)
  const p = params as { targetUri: string }
  const refuse = (message: string): never => {
    throw Object.assign(new Error(message), { rpcCode: RPC_INTERNAL_ERROR })
  }
  const targetFile = st.normalize(fromUri(p.targetUri))
  if (targetFile === file) return refuse('the target must differ from the source file')
  const sourceExt = path.extname(file).toLowerCase()
  const targetExt = path.extname(targetFile).toLowerCase()
  const families = [['.ts', '.tsx'], ['.js', '.jsx'], ['.mts'], ['.cts'], ['.mjs'], ['.cjs']]
  const family = families.find(f => f.includes(sourceExt))
  if (!family || !family.includes(targetExt)) {
    return refuse(
      `the target must be a ${(family ?? [sourceExt]).join(' or ')} file to match ${path.basename(file)} (got '${targetExt || 'no extension'}')`,
    )
  }
  let targetIsDirectory = false
  try {
    targetIsDirectory = fs.statSync(targetFile).isDirectory()
  } catch {
    targetIsDirectory = false
  }
  if (targetIsDirectory) return refuse(`the target ${targetFile} is a directory — name a file`)
  const sourceFile = project.service.getProgram()?.getSourceFile(file)
  if (!sourceFile) return refuse('the source file is not part of the project')
  const statement = sourceFile.statements.find(
    s => s.getStart(sourceFile) <= offset && offset < s.end,
  )
  if (!statement) {
    return refuse(
      'the position is not inside a top-level statement — point at the name of the declaration to move',
    )
  }
  const names = declarationNamesOf(st.ts, statement, sourceFile)
  if (names.length === 0) {
    return refuse(
      `the statement at the position (${st.ts.SyntaxKind[statement.kind]}) is not a declaration that can move — point at the name of a function, class, interface, type, enum or variable declared at the top level`,
    )
  }
  const headerEnd = Math.max(...names.map(n => n.end))
  if (offset > headerEnd) {
    const text = st.textOf(file) ?? ''
    return refuse(
      `the position is inside the body of '${names[0]!.name}' — point at its name (${positionLabel(st.workspaceRoot, file, text, names[0]!.start)}) to move the whole declaration`,
    )
  }
  const range = { pos: statement.getStart(sourceFile), end: statement.end }
  let info: TS.RefactorEditInfo | undefined
  try {
    info = project.service.getEditsForRefactor(
      file,
      FORMAT_OPTIONS,
      range,
      'Move to file',
      'Move to file',
      { allowTextChangesInNewFiles: true },
      { targetFile },
    )
  } catch (e) {
    return refuse(`the service refused the move: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!info) return refuse('the service offered no move for this declaration')
  if (info.notApplicableReason) return refuse(`the service refused the move: ${info.notApplicableReason}`)
  return fileTextChangesToDocumentChanges(st, info.edits)
}
