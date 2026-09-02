// ============================================================================
//  render-engine/cockpit/markdownBoundary.ts — the product's markdown-safe
//  boundary, plugged into the engine's BoundaryScanner seam (spec 02; the
//  engine receipt's point 3: "plug your markdown-safe boundary via the
//  BoundaryScanner interface; the blank-line+fence scanner is the
//  conservative floor").
//
//  The cockpit already owns the richer scanner: StreamingMarkdown's
//  advanceStableBoundary lexes ONLY the suffix past the last boundary,
//  advances to the last COMPLETED top-level block (an open fence is not a
//  completed block, so no cut ever lands inside one), skips the lexer
//  entirely for marker-free prose, and never retreats. This adapter carries
//  exactly that function behind the engine's interface so the engine's
//  StreamBodyCache and the pane's live renderer share ONE boundary truth.
// ============================================================================

import { advanceStableBoundary } from '../../components/Markdown.js'
import type { BoundaryScanner } from '../stablePrefix.js'

/** The markdown-lexer boundary as a BoundaryScanner: monotonic, fence-safe,
 *  O(suffix) per advance. */
export class MarkdownBlockBoundary implements BoundaryScanner {
  private boundary = 0

  advance(body: string): number {
    this.boundary = advanceStableBoundary(body, this.boundary)
    return this.boundary
  }

  reset(): void {
    this.boundary = 0
  }
}
