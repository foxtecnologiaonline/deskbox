import type { DeskboxApi } from './index'

declare global {
  interface Window {
    deskbox: DeskboxApi
  }
}

export {}
