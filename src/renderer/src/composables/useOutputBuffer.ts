import {
  computed,
  ref,
  shallowRef,
  type ComputedRef,
  type Ref,
  type ShallowRef
} from 'vue'
import type { OutputChunk, OutputStream } from '@shared/types'

const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

export function stripAnsi(text: unknown): string {
  return String(text).replace(ANSI_PATTERN, '')
}

export function useOutputBuffer(): {
  chunks: ShallowRef<OutputChunk[]>
  revision: Ref<number>
  hasOutput: ComputedRef<boolean>
  append: (text: unknown, stream?: OutputStream) => void
  clear: () => void
} {
  const chunks = shallowRef<OutputChunk[]>([])
  const revision = ref(0)
  let nextId = 1

  const hasOutput = computed(() => chunks.value.length > 0)

  const append = (rawText: unknown, stream: OutputStream = 'stdout'): void => {
    const text = stripAnsi(rawText)
    if (!text) return

    const current = chunks.value
    const last = current[current.length - 1]
    if (last && last.stream === stream && last.text.length + text.length < 128 * 1024) {
      const merged: OutputChunk = { ...last, text: last.text + text }
      chunks.value = [...current.slice(0, -1), merged]
    } else {
      chunks.value = [...current, { id: nextId++, stream, text }]
    }
    revision.value += 1
  }

  const clear = (): void => {
    chunks.value = []
    revision.value += 1
  }

  return { chunks, revision, hasOutput, append, clear }
}
