import { describe, expect, it } from 'vitest'
import type { OutputChunk, RunSnapshot, ValueSnapshot } from '../src/shared/types'
import { alignedRunChunks, selectOutputChunks, snapshotJson, snapshotTable } from '../src/renderer/src/composables/outputPresentation'

const chunks: OutputChunk[] = [
  { id: 1, runId: 'first', stream: 'expression', text: 'old result\n', sourceLine: 2 },
  { id: 2, stream: 'package', text: 'npm output\n' },
  { id: 3, runId: 'second', stream: 'expression', text: 'new result\n', sourceLine: 2 }
]
const run: RunSnapshot = {
  id: 'first', revision: 1, createdAt: 1, code: 'old code', language: 'typescript',
  input: { format: 'text', text: '' }, filePath: null, chunks: [chunks[0]!], status: 'completed'
}
const scalar = (value: number): ValueSnapshot => ({ kind: 'number', preview: String(value) })

describe('output presentation boundaries', () => {
  it('preserves complete chronology until a specific run is selected', () => {
    expect(selectOutputChunks(chunks, [run])).toEqual(chunks)
    expect(selectOutputChunks([], [run], 'first')).toEqual([chunks[0]])
    expect(selectOutputChunks(chunks, [], 'second')).toEqual([chunks[2]])
    expect(selectOutputChunks(chunks, [], 'missing')).toEqual([])
  })

  it('aligns one run only even when earlier results share the same source line', () => {
    expect(alignedRunChunks(chunks, 'second')).toEqual([chunks[2]])
    expect(alignedRunChunks(chunks, 'first')).toEqual([chunks[0]])
    expect(selectOutputChunks(chunks, [])).toHaveLength(3)
  })

  it('copies inert plain values while retaining unsupported types and truncation markers', () => {
    const values: ValueSnapshot[] = [{ kind: 'object', preview: 'Object', children: [
      { key: 'answer', value: scalar(42) },
      { key: 'name', value: { kind: 'string', preview: '"hello"' } },
      { key: 'getter', value: { kind: 'accessor', preview: '[Getter]' } },
      { key: 'large', value: { kind: 'bigint', preview: '999n' } },
      { key: 'partial', value: { kind: 'array', preview: 'Array(100)', children: [{ key: '0', value: scalar(1) }], truncated: true } }
    ] }]
    expect(JSON.parse(snapshotJson(values))).toEqual({ answer: 42, name: 'hello', getter: { $type: 'accessor', preview: '[Getter]' }, large: { $type: 'bigint', preview: '999n' }, partial: { $snapshot: '已截断', value: [1] } })
  })

  it('preserves a literal __proto__ field without assigning to an object prototype', () => {
    const value: ValueSnapshot = { kind: 'object', preview: 'Object', children: [{ key: '__proto__', value: { kind: 'string', preview: '"literal"' } }] }
    expect(Object.keys(JSON.parse(snapshotJson([value])))).toEqual(['__proto__'])
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })

  it('retains sparse array indices and custom properties instead of changing positions during copy', () => {
    const sparse: ValueSnapshot = { kind: 'array', preview: 'Array(3)', children: [{ key: '2', value: { kind: 'string', preview: '"last"' } }] }
    expect(JSON.parse(snapshotJson([sparse]))).toEqual({ $type: 'array', length: 3, entries: [{ key: '2', value: 'last' }] })
    const withProperty: ValueSnapshot = { kind: 'array', preview: 'Array(1)', children: [{ key: '0', value: scalar(1) }, { key: 'label', value: { kind: 'string', preview: '"sample"' } }] }
    expect(JSON.parse(snapshotJson([withProperty]))).toEqual({ $type: 'array', length: 1, entries: [{ key: '0', value: 1 }, { key: 'label', value: 'sample' }] })
    expect(JSON.parse(snapshotJson([{ kind: 'array', preview: 'Array(2)', children: [{ key: '0', value: scalar(1) }, { key: '1', value: scalar(2) }] }]))).toEqual([1, 2])
  })

  it('preserves duplicate snapshot labels and never coerces an unquoted string preview into another type', () => {
    const duplicate: ValueSnapshot = { kind: 'object', preview: 'Object', children: [{ key: 'Symbol(x)', value: scalar(1) }, { key: 'Symbol(x)', value: scalar(2) }] }
    expect(JSON.parse(snapshotJson([duplicate]))).toEqual({ $type: 'object', entries: [{ key: 'Symbol(x)', value: 1 }, { key: 'Symbol(x)', value: 2 }] })
    for (const preview of ['true', '123', '{"key":42}']) expect(JSON.parse(snapshotJson([{ kind: 'string', preview }]))).toBe(preview)
  })

  it('bounds snapshot projection on unexpectedly deep or large snapshots', () => {
    let value: ValueSnapshot = scalar(1)
    for (let depth = 0; depth < 30; depth++) value = { kind: 'array', preview: 'Array(1)', children: [{ key: '0', value }] }
    expect(snapshotJson([value])).toContain('已截断')
    expect(snapshotJson([value]).length).toBeLessThan(1000)
  })

  it('creates union columns for heterogeneous object arrays and bounds table rows/columns', () => {
    const value: ValueSnapshot = { kind: 'array', preview: 'Array(40)', children: Array.from({ length: 40 }, (_, row) => ({ key: String(row), value: { kind: 'object', preview: 'Object', children: Array.from({ length: 15 }, (_, column) => ({ key: `field${column}`, value: scalar(row + column) })) } })) }
    const table = snapshotTable(value)!
    expect(table.rows).toHaveLength(30)
    expect(table.columns).toHaveLength(12)
    expect(table.rows[0]?.cells[1]).toBe('1')
    expect(table.truncated).toBe(true)
    expect(snapshotTable(scalar(1))).toBeNull()
  })
})
