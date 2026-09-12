import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

const dialogStack: symbol[] = []
const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Shared modal focus lifecycle. Native Enter activates only the currently focused control. */
export function useDialogFocus(
  visible: () => boolean,
  container: Ref<HTMLElement | undefined>,
  onEscape: () => void,
  initialFocus?: () => HTMLElement | undefined
) {
  const id = Symbol('dialog')
  let previousFocus: HTMLElement | null = null
  let generation = 0

  function focusable(): HTMLElement[] {
    return Array.from(container.value?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
      .filter(element => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true')
  }

  function keydown(event: KeyboardEvent): void {
    if (!visible() || dialogStack.at(-1) !== id) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      onEscape()
    } else if (event.key === 'Tab') {
      const elements = focusable()
      const first = elements[0]
      const last = elements.at(-1)
      if (!first) { event.preventDefault(); container.value?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || !container.value?.contains(document.activeElement))) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !container.value?.contains(document.activeElement))) {
        event.preventDefault(); first.focus()
      }
    }
  }

  function release(): void {
    const index = dialogStack.indexOf(id)
    const wasTop = index === dialogStack.length - 1
    if (index !== -1) dialogStack.splice(index, 1)
    window.removeEventListener('keydown', keydown, true)
    if (wasTop && previousFocus?.isConnected) previousFocus.focus()
    previousFocus = null
  }

  watch(visible, async (open) => {
    const current = ++generation
    if (!open) { release(); return }
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogStack.push(id)
    window.addEventListener('keydown', keydown, true)
    await nextTick()
    if (current !== generation || !visible() || dialogStack.at(-1) !== id) return
    ;(initialFocus?.() ?? focusable()[0] ?? container.value)?.focus()
  }, { immediate: true })

  onBeforeUnmount(() => { generation++; release() })

  function onDialogKeydown(event: KeyboardEvent): void {
    // Let local controls receive keys, then isolate application shortcuts at the modal boundary.
    event.stopPropagation()
    if ((event.ctrlKey || event.metaKey) && !['a', 'c', 'v', 'x', 'z', 'y', 'enter'].includes(event.key.toLowerCase())) event.preventDefault()
  }
  return { onDialogKeydown }
}
