import { computed, ref, shallowRef, type ComputedRef, type Ref, type ShallowRef } from 'vue'
import type { OutputChunk, OutputStream } from '@shared/types'

export type OutputMetadata = Pick<OutputChunk, 'runId' | 'sourceRevision' | 'location' | 'values'>
export const MAX_BUFFER_CHARS = 8 * 1024 * 1024
export const MAX_BUFFER_CHUNKS = 5000
export const OUTPUT_TRUNCATION_MARKER = '[输出缓冲已截断：更早或超大的内容已省略]\n'
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

export function stripAnsi(text: unknown): string { return String(text).replace(ANSI_PATTERN, '') }
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeDeep(child)
  }
  return value
}
function copyMetadata(metadata: OutputMetadata): { metadata: OutputMetadata; truncated: boolean } {
  const copied: OutputMetadata = {}
  if (typeof metadata.runId === 'string') copied.runId = metadata.runId.slice(0, 200)
  if (Number.isSafeInteger(metadata.sourceRevision) && Number(metadata.sourceRevision) >= 0) copied.sourceRevision = metadata.sourceRevision
  const location = metadata.location
  if (location && Number.isSafeInteger(location.line) && location.line > 0 && Number.isSafeInteger(location.column) && location.column > 0) {
    copied.location = { line: location.line, column: location.column,
      ...(typeof location.file === 'string' ? { file: location.file.slice(0, 4096) } : {}) }
  }
  if (metadata.values?.length) {
    try {
      const raw = JSON.stringify(metadata.values)
      if (raw.length > MAX_BUFFER_CHARS - 1024) return { metadata: copied, truncated: true }
      copied.values = JSON.parse(raw) as OutputChunk['values']
    } catch { return { metadata: copied, truncated: true } }
  }
  return { metadata: copied, truncated: false }
}
function sizeOf(chunk: OutputChunk): number { return JSON.stringify(chunk).length }
function fitChunk(chunk: OutputChunk, budget: number): OutputChunk {
  const plain = { ...chunk, values: undefined }
  if (sizeOf(plain) <= budget) return plain
  let low = 0; let high = plain.text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (sizeOf({ ...plain, text: plain.text.slice(-middle) }) <= budget) low = middle
    else high = middle - 1
  }
  return { ...plain, text: low ? plain.text.slice(-low) : '' }
}

export function useOutputBuffer(): {
  chunks: ShallowRef<OutputChunk[]>
  revision: Ref<number>
  hasOutput: ComputedRef<boolean>
  append: (text: unknown, stream?: OutputStream, sourceLine?: number, metadata?: OutputMetadata) => void
  clear: () => void
} {
  const chunks = shallowRef<OutputChunk[]>([])
  const revision = ref(0)
  const hasOutput = computed(() => chunks.value.length > 0)
  let nextId = 1
  let bufferedChars = 0
  let truncated = false
  let markerId = 0
  const sizes = new Map<number, number>()

  function append(rawText: unknown, stream: OutputStream = 'stdout', sourceLine?: number, metadata: OutputMetadata = {}): void {
    const text = stripAnsi(rawText)
    const copy = copyMetadata(metadata)
    if (!text && !copy.metadata.values?.length && !copy.truncated) return
    const line = Number.isInteger(sourceLine) && Number(sourceLine) > 0 ? sourceLine : undefined
    let current = chunks.value
    if (markerId && current[0]?.id === markerId) {
      bufferedChars -= sizes.get(markerId) ?? 0
      sizes.delete(markerId)
      current = current.slice(1)
    }
    const last = current[current.length - 1]
    let next: OutputChunk
    if (last && last.stream === stream && last.sourceLine === line && last.runId === copy.metadata.runId &&
      last.sourceRevision === copy.metadata.sourceRevision && !last.values && !copy.metadata.values &&
      !last.location && !copy.metadata.location && last.text.length + text.length < 128 * 1024) {
      next = { ...last, text: last.text + text }
      current = current.slice(0, -1)
      bufferedChars -= sizes.get(last.id) ?? 0
      sizes.delete(last.id)
    } else next = { id: nextId++, stream, text, ...copy.metadata, ...(line ? { sourceLine: line } : {}) }
    truncated ||= copy.truncated
    if (!markerId) markerId = nextId++
    const marker: OutputChunk = { id: markerId, stream: 'system', text: OUTPUT_TRUNCATION_MARKER,
      ...(copy.metadata.runId ? { runId: copy.metadata.runId } : {}),
      ...(copy.metadata.sourceRevision !== undefined ? { sourceRevision: copy.metadata.sourceRevision } : {}) }
    const markerSize = sizeOf(marker)
    let nextSize = sizeOf(next)
    if (nextSize > MAX_BUFFER_CHARS - markerSize) {
      next = fitChunk(next, MAX_BUFFER_CHARS - markerSize)
      nextSize = sizeOf(next)
      truncated = true
    }
    sizes.set(next.id, nextSize)
    bufferedChars += nextSize
    const appended = [...current, freezeDeep(next)]
    let removed = 0
    while (removed < appended.length - 1 &&
      (bufferedChars + (truncated ? markerSize : 0) > MAX_BUFFER_CHARS || appended.length - removed + (truncated ? 1 : 0) > MAX_BUFFER_CHUNKS)) {
      const oldest = appended[removed++]!
      bufferedChars -= sizes.get(oldest.id) ?? 0
      sizes.delete(oldest.id)
      truncated = true
    }
    const retained = removed ? appended.slice(removed) : appended
    if (truncated) { sizes.set(marker.id, markerSize); bufferedChars += markerSize }
    chunks.value = truncated ? [freezeDeep(marker), ...retained] : retained
    revision.value += 1
  }
  function clear(): void {
    chunks.value = []
    sizes.clear()
    bufferedChars = 0
    truncated = false
    markerId = 0
    revision.value += 1
  }
  return { chunks, revision, hasOutput, append, clear }
}
