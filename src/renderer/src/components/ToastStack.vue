<script setup lang="ts">
import type { ToastMessage } from '@shared/types'

defineProps<{ toasts: ToastMessage[] }>()
</script>

<template>
  <Teleport to="body">
    <div class="toast-stack" aria-live="polite" aria-atomic="false">
      <TransitionGroup name="toast">
        <div v-for="toast in toasts" :key="toast.id" class="hud-toast" :class="`hud-toast--${toast.type}`">
          <span class="hud-toast__code">{{ toast.type === 'error' ? 'ERR' : toast.type === 'success' ? 'OK' : 'SYS' }}</span>
          <span>{{ toast.message }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
