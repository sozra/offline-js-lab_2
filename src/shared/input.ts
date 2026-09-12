import type { ScriptInput } from './types'

export const MAX_INPUT_LENGTH = 512 * 1024
export const EMPTY_INPUT: ScriptInput = { format: 'json', text: '{}' }

export function parseScriptInput(input: ScriptInput = EMPTY_INPUT): { input: unknown; inputText: string } {
  if (!input || (input.format !== 'json' && input.format !== 'text') || typeof input.text !== 'string') {
    throw new Error('输入数据格式无效。')
  }
  if (input.text.length > MAX_INPUT_LENGTH) throw new Error('输入数据不能超过 512 KB 字符。')
  if (input.format === 'text') return { input: input.text, inputText: input.text }
  try {
    return { input: JSON.parse(input.text), inputText: input.text }
  } catch {
    throw new Error('输入数据不是有效 JSON，请修正输入面板中的内容。')
  }
}
