import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

/** Align the inner viewports, independently of header wrapping and footer height. */
export function useAlignedPaneLayout(host: Ref<HTMLElement | undefined>, enabled: Ref<boolean>): void {
  let observer: ResizeObserver | undefined
  let frame = 0
  let shells: HTMLElement[] = []

  function update(): void {
    frame = 0
    const rects = shells.map(shell => shell.getBoundingClientRect())
    const active = enabled.value && rects.length === 2 && rects.every(rect => rect.width && rect.height)
    const top = Math.max(...rects.map(rect => rect.top))
    const bottom = Math.min(...rects.map(rect => rect.bottom))
    shells.forEach((shell, index) => {
      const rect = rects[index]!
      // Padding changes only the contents, never these outer flex-item bounds.
      shell.style.setProperty('--source-inset-top', `${active ? top - rect.top : 0}px`)
      shell.style.setProperty('--source-inset-bottom', `${active ? Math.max(0, rect.bottom - bottom) : 0}px`)
    })
  }
  function schedule(): void {
    if (!frame) frame = requestAnimationFrame(update)
  }
  onMounted(() => {
    if (!host.value) return
    shells = [...host.value.querySelectorAll<HTMLElement>('.editor-shell, .console-shell')]
    observer = new ResizeObserver(schedule)
    // Headers/tabs can move a viewport without resizing it.
    for (const element of host.value.querySelectorAll('.editor-shell, .console-shell, .pane-head, .results-tabs, .input-panel, .output-browse')) observer.observe(element)
    observer.observe(host.value)
    window.addEventListener('resize', schedule)
    schedule()
  })
  watch(enabled, schedule, { flush: 'post' })
  onBeforeUnmount(() => {
    observer?.disconnect()
    window.removeEventListener('resize', schedule)
    if (frame) cancelAnimationFrame(frame)
  })
}
