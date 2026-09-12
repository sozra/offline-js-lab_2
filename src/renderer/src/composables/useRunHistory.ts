import { ref, shallowRef } from 'vue'
import type { OutputChunk, OutputStream, RunSnapshot } from '@shared/types'
import { isLabDocument } from './useDocumentSession'

export const PIN_KEY = 'offlineJsLab.pinnedResult.v1'
export const HISTORY_LIMIT = 12
export const HISTORY_CHARS = 12 * 1024 * 1024
export const PIN_CHARS = 1024 * 1024
export const HISTORY_TRUNCATION_MARKER = '[运行历史已截断]'
const OUTPUT_STREAMS = new Set<OutputStream>(['stdout', 'stderr', 'expression', 'system', 'package', 'muted'])

export function resultText(chunks: OutputChunk[]): string {
  return chunks.filter(chunk => ['stdout', 'stderr', 'expression'].includes(chunk.stream) ||
    (chunk.stream === 'system' && /\[(?:运行历史|输出缓冲)已截断/.test(chunk.text))).map(chunk => chunk.text).join('')
}

export interface DiffRow { left: string | null; right: string | null; kind: 'same' | 'added' | 'removed' }

export function compareResults(left: string, right: string): { rows: DiffRow[]; truncated: boolean; leftText: string; rightText: string } {
  const limited = (text: string) => text.slice(0, 100_000).replace(/\r\n?/g, '\n').split('\n')
  const leftLines = limited(left)
  const rightLines = limited(right)
  const truncated = leftLines.length > 500 || rightLines.length > 500 || left.length > 100_000 || right.length > 100_000 ||
    /\[(?:运行历史|输出缓冲)已截断/.test(left) || /\[(?:运行历史|输出缓冲)已截断/.test(right)
  const a = left === '' ? [] : leftLines.slice(0, 500)
  const b = right === '' ? [] : rightLines.slice(0, 500)
  const matrix = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      matrix[i]![j] = a[i] === b[j] ? matrix[i + 1]![j + 1]! + 1 : Math.max(matrix[i + 1]![j]!, matrix[i]![j + 1]!)
    }
  }
  const rows: DiffRow[] = []
  let i = 0; let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) rows.push({ left: a[i++]!, right: b[j++]!, kind: 'same' })
    else if (j < b.length && (i === a.length || matrix[i]![j + 1]! >= matrix[i + 1]![j]!)) rows.push({ left: null, right: b[j++]!, kind: 'added' })
    else rows.push({ left: a[i++]!, right: null, kind: 'removed' })
  }
  // The visual diff and the summary must compare exactly the same bounded text.
  return { rows, truncated, leftText: a.join('\n'), rightText: b.join('\n') }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeDeep(child)
  }
  return value
}
function isSnapshot(value: unknown): value is RunSnapshot {
  if (!isLabDocument(value)) return false
  const snapshot = value as RunSnapshot
  return typeof snapshot.id === 'string' && snapshot.id.length > 0 && snapshot.id.length <= 200 &&
    Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 &&
    Number.isFinite(snapshot.createdAt) && snapshot.createdAt >= 0 &&
    typeof snapshot.status === 'string' && snapshot.status.length <= 200 &&
    (snapshot.filePath === null || (typeof snapshot.filePath === 'string' && snapshot.filePath.length <= 32768)) &&
    Array.isArray(snapshot.chunks) && snapshot.chunks.length <= 5000 && snapshot.chunks.every(chunk =>
      chunk && Number.isSafeInteger(chunk.id) && chunk.id >= 0 && typeof chunk.text === 'string' && OUTPUT_STREAMS.has(chunk.stream))
}
function copySnapshot(snapshot: RunSnapshot): RunSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as RunSnapshot
}
function readPinned(): RunSnapshot | null {
  try {
    const raw = window.localStorage.getItem(PIN_KEY)
    if (!raw || raw.length > PIN_CHARS) return null
    const value: unknown = JSON.parse(raw)
    if (!isSnapshot(value)) return null
    // Disk records are display-only text. Discard unknown fields and recursive value trees.
    return freezeDeep({
      id: value.id, revision: value.revision, code: value.code, language: value.language,
      input: { ...value.input }, createdAt: value.createdAt, status: value.status, filePath: value.filePath,
      chunks: value.chunks.map(chunk => ({ id: chunk.id, text: chunk.text, stream: chunk.stream, runId: value.id }))
    })
  } catch { return null }
}

/** Preserve code/input for restoration; evict oversized output with a visible marker. */
function boundedCopy(snapshot: RunSnapshot): { snapshot: RunSnapshot; size: number } | null {
  try {
    if (!isSnapshot(snapshot)) return null
    const copy = copySnapshot(snapshot)
    const baseSize = JSON.stringify({ ...copy, chunks: [] }).length
    if (baseSize >= HISTORY_CHARS - 512) return null
    const chunkSizes = copy.chunks.map(chunk => JSON.stringify(chunk).length + 1)
    let total = baseSize + chunkSizes.reduce((sum, size) => sum + size, 0)
    let removed = 0
    const marker: OutputChunk = { id: 0, runId: copy.id, stream: 'system', text: `${HISTORY_TRUNCATION_MARKER} 超出历史容量，更早的输出已省略。\n` }
    const reserve = JSON.stringify(marker).length + 1
    while (removed < copy.chunks.length && total + (removed ? reserve : 0) > HISTORY_CHARS) total -= chunkSizes[removed++]!
    if (removed) copy.chunks = [marker, ...copy.chunks.slice(removed)]
    const size = JSON.stringify(copy).length
    return { snapshot: freezeDeep(copy), size }
  } catch { return null }
}

export function useRunHistory() {
  const runs = shallowRef<RunSnapshot[]>([])
  const selectedId = ref('')
  const pinned = shallowRef<RunSnapshot | null>(readPinned())
  const sizes = new Map<string, number>()

  function trim(): void {
    let size = [...sizes.values()].reduce((sum, value) => sum + value, 0)
    const next = [...runs.value]
    while (next.length && (next.length > HISTORY_LIMIT || size > HISTORY_CHARS)) {
      const removed = next.pop()!
      size -= sizes.get(removed.id) ?? 0
      sizes.delete(removed.id)
    }
    runs.value = next
    if (selectedId.value && !next.some(run => run.id === selectedId.value)) selectedId.value = ''
  }
  function begin(snapshot: RunSnapshot): void {
    const bounded = boundedCopy(snapshot)
    if (!bounded) return
    runs.value = [bounded.snapshot, ...runs.value.filter(run => run.id !== snapshot.id)]
    sizes.set(snapshot.id, bounded.size)
    selectedId.value = ''
    trim()
  }
  function update(id: string, chunks: OutputChunk[], status?: string): void {
    const previous = runs.value.find(run => run.id === id)
    if (!previous) return
    const bounded = boundedCopy({ ...previous, chunks, status: status ?? previous.status })
    if (!bounded) return
    runs.value = runs.value.map(run => run.id === id ? bounded.snapshot : run)
    sizes.set(id, bounded.size)
    trim()
  }
  function pin(snapshot: RunSnapshot): boolean {
    try {
      if (!isSnapshot(snapshot)) return false
      const raw = JSON.stringify(snapshot)
      if (raw.length > PIN_CHARS) return false
      const copy = freezeDeep(JSON.parse(raw) as RunSnapshot)
      window.localStorage.setItem(PIN_KEY, raw)
      pinned.value = copy
      return true
    } catch { return false }
  }
  function unpin(): boolean {
    try { window.localStorage.removeItem(PIN_KEY) } catch { return false }
    pinned.value = null
    return true
  }
  return { runs, selectedId, pinned, begin, update, pin, unpin }
}
