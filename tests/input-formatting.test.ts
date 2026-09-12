import { describe, expect, it } from 'vitest'
import { formatJsonInput } from '../src/renderer/src/composables/inputFormatting'

describe('lossless JSON input formatting', () => {
  it('preserves large integers, exponent spelling, negative zero and duplicate keys', () => {
    const input = '{"id":9007199254740993,"amount":1.2300e+22,"zero":-0,"same":1,"same":2}'
    const formatted = formatJsonInput(input)
    expect(formatted).toContain('9007199254740993')
    expect(formatted).toContain('1.2300e+22')
    expect(formatted).toContain('"zero": -0')
    expect(formatted.match(/"same"/g)).toHaveLength(2)
    expect(JSON.parse(formatted)).toEqual(JSON.parse(input))
  })

  it('handles delimiters inside strings, escapes, nested containers and empty collections', () => {
    const input = '{"text":"hello { \\\"world\\\" }\\n中文","items":[{},[],{"a":true}],"nothing":null}'
    const formatted = formatJsonInput(input)
    expect(JSON.parse(formatted)).toEqual(JSON.parse(input))
    expect(formatted).toContain('hello { \\\"world\\\" }\\n中文')
    expect(formatted).toContain('{},\n')
    expect(formatJsonInput(' [ ] ')).toBe('[]')
    expect(formatJsonInput(' true ')).toBe('true')
  })

  it('rejects invalid JSON and fails before deeply nested formatting can expand without bound', () => {
    expect(() => formatJsonInput('{')).toThrow()
    expect(() => formatJsonInput('')).toThrow()
    expect(() => formatJsonInput('['.repeat(1000) + '0' + ']'.repeat(1000), 512)).toThrow('容量限制')
    expect(() => formatJsonInput('{"long":"unchanged"}', 10)).toThrow('容量限制')
  })
})
