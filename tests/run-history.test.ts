import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  compareResults, HISTORY_CHARS, HISTORY_LIMIT, HISTORY_TRUNCATION_MARKER, PIN_CHARS, PIN_KEY,
  resultText, useRunHistory
} from '../src/renderer/src/composables/useRunHistory'
import { MAX_INPUT_LENGTH, parseScriptInput } from '../src/shared/input'
import { INPUT_TEXT_LIMIT } from '../src/renderer/src/composables/useDocumentSession'
import type { OutputChunk, RunSnapshot } from '../src/shared/types'

let values: Map<string, string>
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> }
beforeEach(() => {
  values = new Map()
  storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key))
  }
  vi.stubGlobal('window', { localStorage: storage })
})
afterEach(() => vi.unstubAllGlobals())

function snapshot(id = 'first', text = '42\n'): RunSnapshot {
  return {
    id, revision: 1, code: 'console.log(lab.input)', language: 'typescript', input: { format: 'json', text: '{"answer":42}' },
    createdAt: 100, filePath: null, status: 'completed',
    chunks: [{ id: 1, runId: id, stream: 'stdout', text, values: [{ kind: 'object', preview: 'Object', children: [{ key: 'answer', value: { kind: 'number', preview: '42' } }] }] }]
  }
}

describe('run history and fixed baseline', () => {
  it('captures immutable code, input and nested output during begin, update and pin', () => {
    const history = useRunHistory()
    const source = snapshot()
    history.begin(source)
    source.input.text = '{}'
    source.chunks[0]!.values![0]!.children![0]!.value.preview = '100'
    expect(history.runs.value[0]!.input.text).toBe('{"answer":42}')
    expect(history.runs.value[0]!.chunks[0]!.values![0]!.children![0]!.value.preview).toBe('42')
    history.update(source.id, source.chunks, 'failed')
    const captured = history.runs.value[0]!
    expect(history.pin(captured)).toBe(true)
    source.chunks[0]!.text = 'changed later'
    source.chunks[0]!.values![0]!.children![0]!.value.preview = '200'
    expect(captured.chunks[0]!.text).toBe('42\n')
    expect(captured.chunks[0]!.values![0]!.children![0]!.value.preview).toBe('100')
    expect(history.pinned.value!.chunks[0]!.values![0]!.children![0]!.value.preview).toBe('100')
    expect(Object.isFrozen(history.pinned.value)).toBe(true)
    expect(Object.isFrozen(history.pinned.value!.chunks[0]!.values![0]!.children)).toBe(true)
    expect(() => { history.pinned.value!.input.text = 'mutated' }).toThrow()
  })

  it('only changes pinned memory after storage succeeds, including unpin', () => {
    const history = useRunHistory()
    expect(history.pin(snapshot())).toBe(true)
    const original = history.pinned.value
    const persisted = values.get(PIN_KEY)
    storage.setItem.mockImplementation(() => { throw new Error('quota exceeded') })
    expect(history.pin(snapshot('second'))).toBe(false)
    expect(history.pinned.value).toBe(original)
    expect(values.get(PIN_KEY)).toBe(persisted)
    storage.removeItem.mockImplementation(() => { throw new Error('storage unavailable') })
    expect(history.unpin()).toBe(false)
    expect(history.pinned.value).toBe(original)
    expect(values.get(PIN_KEY)).toBe(persisted)
    storage.removeItem.mockImplementation((key: string) => values.delete(key))
    expect(history.unpin()).toBe(true)
    expect(history.pinned.value).toBeNull()
    expect(values.has(PIN_KEY)).toBe(false)
  })

  it('rejects oversized, malformed and unserializable pins while retaining the baseline', () => {
    const history = useRunHistory()
    history.pin(snapshot())
    const original = history.pinned.value
    expect(history.pin(snapshot('large', 'x'.repeat(PIN_CHARS)))).toBe(false)
    expect(history.pin({ ...snapshot(), revision: -1 })).toBe(false)
    expect(history.pin({ ...snapshot(), chunks: [{ id: 1, stream: 'invalid', text: 'x' }] } as unknown as RunSnapshot)).toBe(false)
    const cyclic = snapshot('cyclic')
    cyclic.chunks[0]!.values![0]!.children!.push({ key: 'cycle', value: cyclic.chunks[0]!.values![0]! })
    expect(history.pin(cyclic)).toBe(false)
    expect(history.pinned.value).toBe(original)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  it('restores a text-only baseline and safely rejects corrupt persisted records', () => {
    const source = snapshot()
    values.set(PIN_KEY, JSON.stringify(source))
    const restored = useRunHistory().pinned.value!
    expect(restored).toMatchObject({ id: source.id, code: source.code, input: source.input })
    expect(restored.chunks[0]!.values).toBeUndefined()
    expect(Object.isFrozen(restored.input)).toBe(true)
    for (const raw of ['{', 'null', JSON.stringify({ ...source, status: 4 }), JSON.stringify({ ...source, revision: -1 }),
      JSON.stringify({ ...source, createdAt: null }), JSON.stringify({ ...source, filePath: {} }),
      JSON.stringify({ ...source, input: { format: 'yaml', text: '{}' } }),
      JSON.stringify({ ...source, chunks: [{ id: 1, text: 'unsafe', stream: 'anything' }] }), ' '.repeat(PIN_CHARS + 1)]) {
      values.set(PIN_KEY, raw)
      expect(useRunHistory().pinned.value).toBeNull()
      expect(values.get(PIN_KEY)).toBe(raw)
    }
  })

  it('keeps one entry per run id, expires old selections, and limits history count', () => {
    const history = useRunHistory()
    history.begin(snapshot('same'))
    history.begin(snapshot('same', 'replacement'))
    expect(history.runs.value).toHaveLength(1)
    expect(history.runs.value[0]!.chunks[0]!.text).toBe('replacement')
    for (let index = 0; index < HISTORY_LIMIT + 3; index++) history.begin(snapshot(String(index)))
    expect(history.runs.value).toHaveLength(HISTORY_LIMIT)
    expect(history.runs.value.map(run => run.id)).not.toContain('same')
    history.selectedId.value = 'expired-id'
    history.update(history.runs.value[0]!.id, [])
    expect(history.selectedId.value).toBe('')
    const before = history.runs.value
    history.update('unknown', [{ id: 1, stream: 'stdout', text: 'ignored' }])
    expect(history.runs.value).toBe(before)
  })

  it('enforces the aggregate history budget, including rich metadata and JSON escaping', () => {
    const history = useRunHistory()
    for (let index = 0; index < 5; index++) history.begin(snapshot(String(index), 'x'.repeat(3 * 1024 * 1024)))
    expect(history.runs.value.length).toBeLessThan(5)
    expect(history.runs.value.reduce((sum, run) => sum + JSON.stringify(run).length, 0)).toBeLessThanOrEqual(HISTORY_CHARS)
    history.update('4', [{ id: 1, stream: 'stdout', text: '', values: [{ kind: 'string', preview: '"'.repeat(4 * 1024 * 1024) }] }])
    expect(history.runs.value.reduce((sum, run) => sum + JSON.stringify(run).length, 0)).toBeLessThanOrEqual(HISTORY_CHARS)
  })

  it('marks even a single oversized result as truncated and preserves restorable source/input', () => {
    const history = useRunHistory()
    const large = snapshot('large', 'x'.repeat(HISTORY_CHARS))
    history.begin(large)
    const kept = history.runs.value[0]!
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(HISTORY_CHARS)
    expect(kept.code).toBe(large.code)
    expect(kept.input).toEqual(large.input)
    expect(resultText(kept.chunks)).toContain(HISTORY_TRUNCATION_MARKER)
    expect(compareResults(resultText(kept.chunks), resultText(kept.chunks)).truncated).toBe(true)
  })
})

describe('result comparison', () => {
  it('aligns additions and deletions without shifting the remaining matching lines', () => {
    const compared = compareResults('first\nremoved\nlast', 'first\nadded\nlast')
    expect(compared.truncated).toBe(false)
    expect(compared.rows.filter(row => row.kind === 'same').map(row => row.left)).toEqual(['first', 'last'])
    expect(compared.rows).toContainEqual({ left: 'removed', right: null, kind: 'removed' })
    expect(compared.rows).toContainEqual({ left: null, right: 'added', kind: 'added' })
    expect(compareResults('', 'new').rows).toEqual([{ left: null, right: 'new', kind: 'added' }])
    expect(compareResults('old', '').rows).toEqual([{ left: 'old', right: null, kind: 'removed' }])
    expect(compareResults('', '').rows).toEqual([])
  })

  it('feeds the visual diff the exact bounded text without removing meaningful whitespace', () => {
    const compared = compareResults(' total: 7 \r\n\r\n', ' total: 9\n\n')
    expect(compared.leftText).toBe(' total: 7 \n\n')
    expect(compared.rightText).toBe(' total: 9\n\n')
    expect(compareResults('', '').leftText).toBe('')
    const limited = compareResults('x'.repeat(100_001), Array.from({ length: 501 }, (_, i) => String(i)).join('\n'))
    expect(limited.leftText).toHaveLength(100_000)
    expect(limited.rightText.split('\n')).toHaveLength(500)
    expect(limited.rightText.endsWith('\n499')).toBe(true)
    expect(limited.truncated).toBe(true)
  })

  it('normalizes Windows line endings, ignores system noise, and exposes comparison limits', () => {
    expect(compareResults('a\r\nb', 'a\nb').rows.every(row => row.kind === 'same')).toBe(true)
    const chunks: OutputChunk[] = [{ id: 1, stream: 'system', text: 'elapsed 20ms' }, { id: 2, stream: 'stdout', text: 'value\n' }, { id: 3, stream: 'package', text: 'npm chatter' }]
    expect(resultText(chunks)).toBe('value\n')
    const manyLines = compareResults('line\n'.repeat(2000), 'line\n'.repeat(2000))
    expect(manyLines.truncated).toBe(true)
    expect(manyLines.rows).toHaveLength(500)
    const longLine = compareResults('x'.repeat(100_001), 'x'.repeat(100_000) + 'different')
    expect(longLine.truncated).toBe(true)
    expect(longLine.rows[0]!.left!.length).toBe(100_000)
  })
})

describe('input panel and runtime validation contract', () => {
  it('uses valid default JSON, rejects blank JSON consistently, and preserves empty text', () => {
    expect(parseScriptInput()).toEqual({ input: {}, inputText: '{}' })
    for (const text of ['', ' ', '\n', '{']) expect(() => parseScriptInput({ format: 'json', text })).toThrow('有效 JSON')
    expect(parseScriptInput({ format: 'text', text: '' })).toEqual({ input: '', inputText: '' })
    expect(parseScriptInput({ format: 'json', text: 'null' })).toEqual({ input: null, inputText: 'null' })
    expect(parseScriptInput({ format: 'json', text: 'false' })).toEqual({ input: false, inputText: 'false' })
  })

  it('enforces the same 512K character limit on every input format', () => {
    expect(INPUT_TEXT_LIMIT).toBe(MAX_INPUT_LENGTH)
    const maximum = 'x'.repeat(MAX_INPUT_LENGTH)
    expect(parseScriptInput({ format: 'text', text: maximum }).inputText.length).toBe(MAX_INPUT_LENGTH)
    for (const format of ['json', 'text'] as const) expect(() => parseScriptInput({ format, text: maximum + 'x' })).toThrow('512 KB')
  })
})
