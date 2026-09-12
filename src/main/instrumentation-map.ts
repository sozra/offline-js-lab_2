import ts from 'typescript'

export interface SourceEdit { start: number; end: number; text: string }
interface Span { start: number; end: number; originalStart: number; originalEnd: number }

function lineStarts(code: string): number[] {
  const result = [0]
  for (let index = 0; index < code.length; index += 1) {
    if (code[index] === '\n') result.push(index + 1)
  }
  return result
}

function floorIndex(sorted: number[], value: number): number {
  let low = 0
  let high = sorted.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (sorted[middle]! <= value) low = middle
    else high = middle - 1
  }
  return low
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function vlq(value: number): string {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1
  let encoded = ''
  do {
    const digit = rest & 31
    rest >>>= 5
    encoded += BASE64[digit | (rest ? 32 : 0)]
  } while (rest)
  return encoded
}

/** Keep a map through text insertion/replacement, without evaluating user source. */
export function applyMappedEdits(original: string, edits: SourceEdit[], sourceFile: string) {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end)
  const spans: Span[] = []
  const pieces: string[] = []
  let position = 0
  let generatedOffset = 0
  const append = (text: string, originalStart: number, originalEnd: number): void => {
    if (!text) return
    pieces.push(text)
    spans.push({ start: generatedOffset, end: generatedOffset + text.length, originalStart, originalEnd })
    generatedOffset += text.length
  }
  for (const edit of ordered) {
    append(original.slice(position, edit.start), position, edit.start)
    append(edit.text, edit.start, edit.end)
    position = edit.end
  }
  append(original.slice(position), position, original.length)
  const code = pieces.join('')
  const generatedLines = lineStarts(code)
  const originalLines = lineStarts(original)
  const spanStarts = spans.map((span) => span.start)
  const originalOffset = (offset: number): number => {
    const span = spans[floorIndex(spanStarts, offset)]
    if (!span) return 0
    return Math.min(span.originalEnd, span.originalStart + Math.max(0, offset - span.start))
  }
  const positionOf = (offset: number): { line: number; column: number } => {
    const mapped = originalOffset(offset)
    const lineIndex = floorIndex(originalLines, mapped)
    return { line: lineIndex + 1, column: mapped - originalLines[lineIndex]! + 1 }
  }
  const originalPosition = (line: number, column: number): { line: number; column: number } =>
    positionOf((generatedLines[Math.max(0, line - 1)] ?? code.length) + Math.max(0, column - 1))

  // Token boundaries preserve useful error columns without a mapping per UTF-16 code unit.
  const boundaries = new Set(generatedLines)
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code)
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    boundaries.add(scanner.getTokenPos())
    boundaries.add(scanner.getTextPos())
  }
  let currentLine = 0
  let previousColumn = 0
  let previousOriginalLine = 0
  let previousOriginalColumn = 0
  const lines: string[] = []
  let segments: string[] = []
  for (const offset of [...boundaries].sort((a, b) => a - b)) {
    const line = floorIndex(generatedLines, offset)
    while (currentLine < line) {
      lines.push(segments.join(','))
      segments = []
      previousColumn = 0
      currentLine += 1
    }
    const column = offset - generatedLines[line]!
    const mapped = positionOf(offset)
    segments.push(vlq(column - previousColumn) + 'A' +
      vlq(mapped.line - 1 - previousOriginalLine) + vlq(mapped.column - 1 - previousOriginalColumn))
    previousColumn = column
    previousOriginalLine = mapped.line - 1
    previousOriginalColumn = mapped.column - 1
  }
  lines.push(segments.join(','))
  return {
    code,
    originalPosition,
    sourceMap: JSON.stringify({
      version: 3,
      sources: [sourceFile.replace(/\\/g, '/')],
      sourcesContent: [original],
      names: [],
      mappings: lines.join(';')
    })
  }
}
