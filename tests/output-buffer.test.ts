import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_BUFFER_CHARS, MAX_BUFFER_CHUNKS, OUTPUT_TRUNCATION_MARKER, stripAnsi, useOutputBuffer } from '../src/renderer/src/composables/useOutputBuffer'
import type { ValueSnapshot } from '../src/shared/types'

afterEach(() => vi.unstubAllGlobals())

describe('output buffer ownership and bounds', () => {
  it('merges adjacent plain fragments only for the same run, source revision, line, and stream', () => {
    const buffer = useOutputBuffer()
    buffer.append('one', 'stdout', 2, { runId: 'first', sourceRevision: 1 })
    buffer.append(' two', 'stdout', 2, { runId: 'first', sourceRevision: 1 })
    expect(buffer.chunks.value).toHaveLength(1)
    expect(buffer.chunks.value[0]!.text).toBe('one two')
    buffer.append('next run', 'stdout', 2, { runId: 'second', sourceRevision: 1 })
    buffer.append('edited', 'stdout', 2, { runId: 'second', sourceRevision: 2 })
    buffer.append('other line', 'stdout', 3, { runId: 'second', sourceRevision: 2 })
    buffer.append('error', 'stderr', 3, { runId: 'second', sourceRevision: 2 })
    expect(buffer.chunks.value).toHaveLength(5)
    expect(buffer.revision.value).toBe(6)
  })

  it('preserves rich-only output and detaches nested values and locations from later mutations', () => {
    const buffer = useOutputBuffer()
    const values: ValueSnapshot[] = [{ kind: 'object', preview: 'Object', children: [{ key: 'answer', value: { kind: 'number', preview: '42' } }] }]
    const location = { file: 'scratch.ts', line: 3, column: 7 }
    buffer.append('', 'stdout', 3, { values, location, runId: 'run' })
    values[0]!.children![0]!.value.preview = 'changed'
    location.line = 100
    expect(buffer.hasOutput.value).toBe(true)
    expect(buffer.chunks.value[0]!.values![0]!.children![0]!.value.preview).toBe('42')
    expect(buffer.chunks.value[0]!.location!.line).toBe(3)
    expect(Object.isFrozen(buffer.chunks.value[0]!.values![0]!.children)).toBe(true)
    buffer.append('next', 'stdout', 3, { runId: 'run' })
    expect(buffer.chunks.value).toHaveLength(2)
  })

  it('removes ANSI escapes, ignores empty plain chunks, and treats invalid source lines as unmapped', () => {
    const buffer = useOutputBuffer()
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red')
    buffer.append('\u001b[31m\u001b[0m')
    expect(buffer.chunks.value).toHaveLength(0)
    expect(buffer.revision.value).toBe(0)
    buffer.append('unmapped', 'stderr', -4)
    expect(buffer.chunks.value[0]!.sourceLine).toBeUndefined()
  })

  it('caps chunk count while visibly marking omitted output for the active run', () => {
    const buffer = useOutputBuffer()
    for (let index = 0; index < MAX_BUFFER_CHUNKS + 5; index++) buffer.append(String(index), 'stdout', index + 1, { runId: 'run' })
    expect(buffer.chunks.value).toHaveLength(MAX_BUFFER_CHUNKS)
    expect(buffer.chunks.value[0]).toMatchObject({ text: OUTPUT_TRUNCATION_MARKER, stream: 'system', runId: 'run' })
    expect(buffer.chunks.value.at(-1)!.text).toBe(String(MAX_BUFFER_CHUNKS + 4))
  })

  it('caps total encoded content and a single huge escaped chunk', () => {
    const buffer = useOutputBuffer()
    buffer.append('old', 'stdout', 1, { runId: 'run' })
    buffer.append('"'.repeat(MAX_BUFFER_CHARS), 'stdout', 2, { runId: 'run' })
    expect(buffer.chunks.value.reduce((sum, chunk) => sum + JSON.stringify(chunk).length, 0)).toBeLessThanOrEqual(MAX_BUFFER_CHARS)
    expect(buffer.chunks.value[0]!.text).toBe(OUTPUT_TRUNCATION_MARKER)
    expect(buffer.chunks.value.at(-1)!.text.length).toBeLessThan(MAX_BUFFER_CHARS)
    expect(buffer.chunks.value.at(-1)!.text.endsWith('"')).toBe(true)
  })

  it('accounts for rich values and locations, handles malformed metadata, and resets its budget after clear', () => {
    const buffer = useOutputBuffer()
    for (let index = 0; index < 4; index++) buffer.append('', 'stdout', index + 1, {
      values: [{ kind: 'string', preview: 'x'.repeat(3 * 1024 * 1024) }], runId: 'rich', location: { line: 1, column: 1, file: 'x'.repeat(4096) }
    })
    expect(buffer.chunks.value.reduce((sum, chunk) => sum + JSON.stringify(chunk).length, 0)).toBeLessThanOrEqual(MAX_BUFFER_CHARS)
    expect(buffer.chunks.value[0]!.text).toBe(OUTPUT_TRUNCATION_MARKER)
    const cyclic: ValueSnapshot = { kind: 'object', preview: 'Object', children: [] }
    cyclic.children!.push({ key: 'self', value: cyclic })
    expect(() => buffer.append('safe text', 'stdout', undefined, { values: [cyclic] })).not.toThrow()
    buffer.clear()
    buffer.append('fresh', 'stdout')
    expect(buffer.chunks.value.map(chunk => chunk.text)).toEqual(['fresh'])
  })

  it('PURGE clears only output and changes neither preferences nor browser storage', () => {
    const preferences = new Map([['offlineJsLab.clearOutputOnRun', 'false'], ['offlineJsLab.alignOutputToSource', 'true']])
    const setItem = vi.fn((key: string, value: string) => preferences.set(key, value))
    const removeItem = vi.fn((key: string) => preferences.delete(key))
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => preferences.get(key) ?? null, setItem, removeItem } })
    const buffer = useOutputBuffer()
    buffer.append('before')
    const revision = buffer.revision.value
    buffer.clear()
    expect(buffer.chunks.value).toEqual([])
    expect(buffer.hasOutput.value).toBe(false)
    expect(buffer.revision.value).toBe(revision + 1)
    expect([...preferences]).toEqual([['offlineJsLab.clearOutputOnRun', 'false'], ['offlineJsLab.alignOutputToSource', 'true']])
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
  })
})
