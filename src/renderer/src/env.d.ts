/// <reference types="vite/client" />

import type { OfflineJsLabBridge } from '@shared/types'

declare global {
  interface Window {
    offlineJsLab: OfflineJsLabBridge
  }
}

export {}
