import { INPUT_TEXT_LIMIT } from './useDocumentSession'

/** Pretty-print JSON tokens without rounding numbers, reordering keys or dropping duplicates. */
export function formatJsonInput(text: string, maximumLength = INPUT_TEXT_LIMIT): string {
  JSON.parse(text) // Validate syntax only; never serialize the parsed value back into the input.
  const result: string[] = []
  let outputLength = 0
  let depth = 0
  let inString = false
  let escaped = false
  const append = (value: string): void => {
    if (outputLength + value.length > maximumLength) throw new Error('格式化后的文本超过输入容量限制，已保留原始输入。')
    outputLength += value.length
    result.push(value)
  }
  const newline = (): void => {
    if (outputLength + 1 + depth * 2 > maximumLength) throw new Error('格式化后的文本超过输入容量限制，已保留原始输入。')
    append('\n' + '  '.repeat(depth))
  }
  const whitespace = (character: string | undefined): boolean => character === ' ' || character === '\t' || character === '\r' || character === '\n'
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (inString) {
      append(character)
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (whitespace(character)) continue
    if (character === '"') { inString = true; append(character) }
    else if (character === '{' || character === '[') {
      append(character); depth++
      let following = index + 1
      while (whitespace(text[following])) following++
      if (text[following] !== '}' && text[following] !== ']') newline()
    } else if (character === '}' || character === ']') {
      depth--
      let previous = index - 1
      while (whitespace(text[previous])) previous--
      if (text[previous] !== '{' && text[previous] !== '[') newline()
      append(character)
    } else if (character === ',') { append(character); newline() }
    else if (character === ':') append(': ')
    else append(character)
  }
  return result.join('')
}
