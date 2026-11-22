import { stat } from 'node:fs/promises'
import type { ToolUseContext } from '../../../Tool.js'
import { isRemotePath } from '../../../utils/remoteFiles/target.js'
import { PDF_TARGET_RAW_SIZE } from '../../../constants/apiLimits.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../../utils/imageResizer.js'
import { createUserMessage } from '../../../utils/messages/factories.js'
import { extractPDFPages, readPDF, removePDFPages } from '../../../utils/pdf.js'
import { extractPdfText, renderPdfText } from '../../../utils/pdfText.js'
import { recognisePdfPage, renderOcr } from '../../../services/ocr.js'
import { isPDFSupported, parsePDFPageRange } from '../../../services/pdfUtils.js'
import { resolveModelCapabilities } from '../../../utils/model/capabilities.js'
import { readRegularFile } from '../../../utils/regularFile.js'
import { getFsImplementation } from '../../../utils/fsOperations.js'
import type { ContentBlockParam } from '../../../types/wire.js'
import type { FileReadingLimits } from '../../../utils/fileReadLimits.js'
import { MAX_PDF_PAGES_PER_REQUEST } from '../../../constants/tools/fileRead.js'
import { selectedPages, type Input, type Output, type LaneResult } from './schema.js'
import { parseLineRangesList } from './target.js'
import { readRichFormatLane } from './richFormatLane.js'
import { recogniseImageCaption } from './image.js'
import { passedOverAs } from '../../../utils/passedOver.js'
import { notBuilt } from '../../../pi/holes.js'

export async function readPdfLane(
  resolvedPath: string,
  keyPath: string,
  input: Input,
  context: ToolUseContext,
  declared: FileReadingLimits,
  ownRead: boolean,
  reserve: () => FileReadingLimits,
): Promise<LaneResult> {
  return notBuilt('src/tools/FileReadTool/read/pdfLane.ts:23')
}
