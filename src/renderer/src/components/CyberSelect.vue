<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

export interface CyberSelectOption {
  value: string
  label: string
}

const props = defineProps<{
  modelValue: string
  options: CyberSelectOption[]
  label: string
  assistiveLabel: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'open-change': [value: boolean]
}>()

const root = ref<HTMLElement>()
const open = ref(false)
const highlightIndex = ref(-1)

const currentLabel = computed(
  () => props.options.find((option) => option.value === props.modelValue)?.label ?? props.modelValue
)

function close(): void {
  open.value = false
  highlightIndex.value = -1
}

function toggle(): void {
  if (props.disabled) return
  if (open.value) {
    close()
    return
  }
  open.value = true
  highlightIndex.value = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.modelValue)
  )
  void nextTick(() => root.value?.querySelector<HTMLElement>('.select-menu')?.focus())
}

function choose(option: CyberSelectOption): void {
  emit('update:modelValue', option.value)
  close()
  root.value?.querySelector<HTMLButtonElement>('.select-trigger')?.focus()
}

function onTriggerKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!open.value) toggle()
    return
  }
  if (event.key === 'Escape' && open.value) {
    event.preventDefault()
    close()
  }
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (!open.value) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    const count = props.options.length
    highlightIndex.value = (highlightIndex.value + step + count) % count
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    const option = props.options[highlightIndex.value]
    if (option) choose(option)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    close()
    root.value?.querySelector<HTMLButtonElement>('.select-trigger')?.focus()
  } else if (event.key === 'Tab') {
    close()
    root.value?.querySelector<HTMLButtonElement>('.select-trigger')?.focus()
  }
}

function onDocumentPointerdown(event: PointerEvent): void {
  if (!open.value) return
  if (root.value && event.target instanceof Node && !root.value.contains(event.target)) close()
}

watch(open, (value) => {
  emit('open-change', value)
  if (value) document.addEventListener('pointerdown', onDocumentPointerdown, true)
  else document.removeEventListener('pointerdown', onDocumentPointerdown, true)
}, { flush: 'sync' })

watch(
  () => props.disabled,
  (value) => {
    if (value) close()
  }
)

onBeforeUnmount(() => {
  if (open.value) emit('open-change', false)
  document.removeEventListener('pointerdown', onDocumentPointerdown, true)
})
</script>

<template>
  <div ref="root" class="select-module" :class="{ 'select-module--open': open }">
    <span class="select-module__eyebrow">{{ label }}</span>
    <button
      class="select-trigger"
      type="button"
      :disabled="disabled"
      :aria-label="assistiveLabel"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggle"
      @keydown="onTriggerKeydown"
    >
      <span class="select-trigger__value">{{ currentLabel }}</span>
      <svg class="select-trigger__chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>

    <Transition name="select-pop">
      <div v-if="open" class="select-menu" role="listbox" :aria-label="assistiveLabel" tabindex="-1" @keydown="onMenuKeydown">
        <button
          v-for="(option, index) in options"
          :key="option.value"
          class="select-option"
          :class="{
            'select-option--active': option.value === modelValue,
            'select-option--highlight': index === highlightIndex
          }"
          type="button"
          role="option"
          :aria-selected="option.value === modelValue"
          @click="choose(option)"
          @pointerenter="highlightIndex = index"
        >
          <i aria-hidden="true" />
          <span>{{ option.label }}</span>
        </button>
      </div>
    </Transition>
  </div>
</template>
