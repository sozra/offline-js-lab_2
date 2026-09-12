<script setup lang="ts">
import { ref, useId } from 'vue'
import { useDialogFocus } from '../composables/useDialogFocus'

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
const cancelButton = ref<HTMLButtonElement>()
const dialog = ref<HTMLElement>()
const titleId = useId()
const descriptionId = useId()
const { onDialogKeydown } = useDialogFocus(
  () => props.visible, dialog, () => emit('cancel'),
  () => props.danger ? cancelButton.value : confirmButton.value
)
</script>

<template>
  <Teleport to="body">
    <Transition name="hud-dialog">
      <div v-if="visible" class="dialog-backdrop dialog-backdrop--confirm" @mousedown.self="emit('cancel')">
        <section ref="dialog" class="cyber-dialog confirm-dialog" role="alertdialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId" tabindex="-1" @keydown="onDialogKeydown">
          <div class="confirm-alert" :class="{ 'confirm-alert--danger': danger }" aria-hidden="true">!</div>
          <div class="confirm-copy">
            <span class="eyebrow">USER AUTHORIZATION REQUIRED</span>
            <h2 :id="titleId">{{ title }}</h2>
            <p :id="descriptionId">{{ message }}</p>
          </div>
          <div class="confirm-actions">
            <button ref="cancelButton" class="cyber-button cyber-button--ghost" type="button" @click="emit('cancel')">取消</button>
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
