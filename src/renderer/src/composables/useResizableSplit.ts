import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  type ComputedRef,
  type Ref
} from 'vue'
import { readNumberStorage, writeStorage } from './storage'

const DEFAULT_RATIO = 0.5
const STORAGE_KEY = 'offlineJsLab.splitRatio'

export function useResizableSplit(
  host: Ref<HTMLElement | undefined>,
  onLayout: () => void,
  minPaneWidth = 280
): {
  ratio: Ref<number>
  dragging: Ref<boolean>
  gridTemplateColumns: ComputedRef<string>
  beginResize: (event: PointerEvent) => void
  reset: () => void
  onSplitterKeydown: (event: KeyboardEvent) => void
} {
  const ratio = ref(readNumberStorage(STORAGE_KEY, DEFAULT_RATIO))
  const dragging = ref(false)
  let resizeObserver: ResizeObserver | undefined

  const clamp = (value: number): number => {
    const width = host.value?.getBoundingClientRect().width ?? 1200
    const usable = Math.max(1, width - 13)
    const minimum = Math.min(0.44, minPaneWidth / usable)
    const maximum = Math.max(0.56, 1 - minimum)
    return Math.min(maximum, Math.max(minimum, value))
  }

  const apply = (value: number, persist = false): void => {
    ratio.value = clamp(Number.isFinite(value) ? value : DEFAULT_RATIO)
    if (persist) writeStorage(STORAGE_KEY, ratio.value)
    requestAnimationFrame(onLayout)
  }

  const move = (event: PointerEvent): void => {
    if (!dragging.value || !host.value) return
    const rect = host.value.getBoundingClientRect()
    apply((event.clientX - rect.left) / Math.max(1, rect.width - 13))
  }

  const finish = (): void => {
    if (!dragging.value) return
    dragging.value = false
    document.body.classList.remove('is-resizing')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    apply(ratio.value, true)
  }

  const beginResize = (event: PointerEvent): void => {
    if (event.button !== 0) return
    dragging.value = true
    document.body.classList.add('is-resizing')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
    event.preventDefault()
  }

  const reset = (): void => apply(DEFAULT_RATIO, true)

  const onSplitterKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      apply(ratio.value + (event.key === 'ArrowLeft' ? -0.02 : 0.02), true)
      event.preventDefault()
    } else if (event.key === 'Home') {
      reset()
      event.preventDefault()
    }
  }

  const gridTemplateColumns = computed(
    () => `minmax(0, ${ratio.value}fr) 13px minmax(0, ${1 - ratio.value}fr)`
  )

  onMounted(() => {
    apply(ratio.value)
    if (host.value) {
      resizeObserver = new ResizeObserver(() => apply(ratio.value))
      resizeObserver.observe(host.value)
    }
  })

  onBeforeUnmount(() => {
    resizeObserver?.disconnect()
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    document.body.classList.remove('is-resizing')
  })

  return { ratio, dragging, gridTemplateColumns, beginResize, reset, onSplitterKeydown }
}
