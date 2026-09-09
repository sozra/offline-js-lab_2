<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    visible: boolean
    title: string
    message: string
    confirmLabel?: string
    danger?: boolean
  }>(),
  { confirmLabel: '确认', danger: false }
)

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

const confirmButton = ref<HTMLButtonElement>()

function onKeydown(event: KeyboardEvent): void {
  if (!props.visible) return
  if (event.key === 'Escape') emit('cancel')
  if (event.key === 'Enter') emit('confirm')
}

watch(
  () => props.visible,
  async (visible) => {
    if (visible) {
      await nextTick()
      confirmButton.value?.focus()
    }
  }
)

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="hud-dialog">
      <div v-if="visible" class="dialog-backdrop dialog-backdrop--confirm" @mousedown.self="emit('cancel')">
        <section class="cyber-dialog confirm-dialog" role="alertdialog" aria-modal="true">
          <div class="confirm-alert" :class="{ 'confirm-alert--danger': danger }" aria-hidden="true">!</div>
          <div class="confirm-copy">
            <span class="eyebrow">USER AUTHORIZATION REQUIRED</span>
            <h2>{{ title }}</h2>
            <p>{{ message }}</p>
          </div>
          <div class="confirm-actions">
            <button class="cyber-button cyber-button--ghost" type="button" @click="emit('cancel')">取消</button>
            <button
              ref="confirmButton"
              class="cyber-button"
              :class="danger ? 'cyber-button--danger' : 'cyber-button--primary'"
              type="button"
              @click="emit('confirm')"
            >
              {{ confirmLabel }}
            </button>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
