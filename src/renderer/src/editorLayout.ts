export const SOURCE_LINE_HEIGHT = 21
export const SOURCE_PADDING_TOP = 15
export const SOURCE_PADDING_BOTTOM = 24

/** Renderer-only geometry, reported by the real Monaco view (including folding). */
export interface SourceViewport {
  scrollTop: number
  scrollHeight: number
  height: number
  lines: { line: number; top: number }[]
}
