
import { advanceStableBoundary } from '../../components/Markdown.js'
import type { BoundaryScanner } from '../stablePrefix.js'

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
