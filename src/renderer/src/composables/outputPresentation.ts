import type { OutputChunk, RunSnapshot, ValueSnapshot } from '@shared/types'

export function selectOutputChunks(chunks: OutputChunk[], runs: RunSnapshot[], selectedRunId = ''): OutputChunk[] {
  if (!selectedRunId) return chunks
  return runs.find(run => run.id === selectedRunId)?.chunks ?? chunks.filter(chunk => chunk.runId === selectedRunId)
}

export function alignedRunChunks(chunks: OutputChunk[], runId = ''): OutputChunk[] {
  return runId ? chunks.filter(chunk => chunk.runId === runId) : chunks
}

/** Project only the inert, bounded snapshot received over IPC, never a user's live object. */
export function snapshotJson(values: ValueSnapshot[]): string {
  let nodes = 0
  function project(value: ValueSnapshot, depth = 0): unknown {
    if (++nodes > 300 || depth > 6) return { $snapshot: '已截断' }
    let result: unknown
    if (value.kind === 'null') result = null
    else if (value.kind === 'boolean') result = value.preview === 'true'
    else if (value.kind === 'number' && Number.isFinite(Number(value.preview))) result = Number(value.preview)
    else if (value.kind === 'string') {
      try { const decoded: unknown = JSON.parse(value.preview); result = typeof decoded === 'string' ? decoded : value.preview } catch { result = value.preview }
    } else if (value.kind === 'array' || value.kind === 'object') {
      const children = (value.children ?? []).slice(0, 60)
      const entries = children.map(child => ({ key: child.key, value: project(child.value, depth + 1) }))
      if (value.kind === 'array') {
        const lengthMatch = /^Array\((\d+)\)$/.exec(value.preview)
        const length = lengthMatch ? Number(lengthMatch[1]) : undefined
        const contiguous = children.every((child, index) => child.key === String(index))
        // Browser snapshots can contain only present array keys, including extra
        // own properties. Preserve those keys instead of shifting sparse indices.
        result = contiguous && (length === undefined || length === children.length || value.truncated)
          ? entries.map(entry => entry.value)
          : { $type: 'array', ...(length !== undefined ? { length } : {}), entries }
      } else {
        result = new Set(children.map(child => child.key)).size === children.length
          ? Object.fromEntries(entries.map(entry => [entry.key, entry.value]))
          : { $type: 'object', entries }
      }
    }
    else result = { $type: value.kind, preview: value.preview, ...(value.children?.length ? { entries: value.children.slice(0, 60).map(child => ({ key: child.key, value: project(child.value, depth + 1) })) } : {}) }
    return value.truncated || (value.children?.length ?? 0) > 60 ? { $snapshot: '已截断', value: result } : result
  }
  const projected = values.slice(0, 60).map(value => project(value))
  return JSON.stringify(projected.length === 1 ? projected[0] : projected, null, 2)
}

export function snapshotTable(value: ValueSnapshot): { columns: string[]; rows: Array<{ key: string; cells: string[] }>; truncated: boolean } | null {
  if (value.kind !== 'array' || !value.children?.length) return null
  const entries = value.children.slice(0, 30)
  const objectRows = entries.every(child => child.value.kind === 'object')
  const allColumns = objectRows ? [...new Set(entries.flatMap(child => (child.value.children ?? []).map(item => item.key)))] : ['值']
  const columns = allColumns.slice(0, 12)
  const rows = entries.map(child => ({
    key: child.key,
    cells: objectRows ? columns.map(key => child.value.children?.find(cell => cell.key === key)?.value.preview ?? '—') : [child.value.preview]
  }))
  return { columns, rows, truncated: Boolean(value.truncated) || value.children.length > 30 || allColumns.length > 12 }
}
