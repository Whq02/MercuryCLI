
export interface BoundaryScanner {
  advance(body: string): number
  reset(): void
}

export class BlankLineBoundary implements BoundaryScanner {
  private scanned = 0
  private fences = 0
  private safeCut = 0

  advance(body: string): number {
    let i = this.scanned
    while (i < body.length) {
      const nl = body.indexOf('\n', i)
      if (nl === -1) break
      const line = body.slice(i, nl)
      if (/^\s*```/.test(line)) this.fences++
      if (line.length === 0 && this.fences % 2 === 0) this.safeCut = nl + 1
      i = nl + 1
    }
    this.scanned = i
    return this.safeCut
  }

  reset(): void {
    this.scanned = 0
    this.fences = 0
    this.safeCut = 0
  }
}

export interface StreamRender {
  rows: readonly string[]
  stableRows: number
}

export class StreamBodyCache {
  private prefixText = ''
  private prefixRows: string[] = []
  private lastBody = ''
  private width = -1
  private promotions = 0
  private renderedChars = 0

  constructor(
    private readonly render: (text: string, width: number) => string[],
    private readonly boundary: BoundaryScanner = new BlankLineBoundary(),
  ) {}

  prefixPromotions(): number {
    return this.promotions
  }

  charsRendered(): number {
    return this.renderedChars
  }

  update(body: string, width: number): StreamRender {
    if (width !== this.width || !body.startsWith(this.lastBody)) {
      this.prefixText = ''
      this.prefixRows = []
      this.width = width
      this.boundary.reset()
    }
    this.lastBody = body
    const cut = this.boundary.advance(body)
    if (cut > this.prefixText.length) {
      const delta = body.slice(this.prefixText.length, cut)
      const deltaRows = this.render(delta, width)
      this.renderedChars += delta.length
      this.promotions++
      this.prefixRows = this.prefixRows.concat(deltaRows)
      this.prefixText = body.slice(0, cut)
    }
    const tail = body.slice(this.prefixText.length)
    let tailRows: string[] = []
    if (tail.length > 0) {
      tailRows = this.render(tail, width)
      this.renderedChars += tail.length
    }
    return {
      rows: this.prefixRows.concat(tailRows),
      stableRows: this.prefixRows.length,
    }
  }

  reset(): void {
    this.prefixText = ''
    this.prefixRows = []
    this.lastBody = ''
    this.width = -1
    this.boundary.reset()
  }
}
