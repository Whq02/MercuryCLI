import type { Tools } from './tool.js'
import type { assembleToolPool, getAllBaseTools } from './toolList.js'

type ToolTable = {
  getAllBaseTools: typeof getAllBaseTools
  assembleToolPool: typeof assembleToolPool
}

let toolTable: ToolTable | undefined

export function tellTheToolTable(table: ToolTable): void {
  toolTable = table
}

export function baseToolsOfTheTable(): Tools {
  return toolTable === undefined ? [] : toolTable.getAllBaseTools()
}

export const toolPoolOfTheTable: ToolTable['assembleToolPool'] = (...call) => toolTable!.assembleToolPool(...call)
