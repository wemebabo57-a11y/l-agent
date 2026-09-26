import type { LagentApi } from '../../preload'

declare global {
  interface Window {
    /** preload 通过 contextBridge 暴露的白名单 API */
    lagent: LagentApi
  }
}

export {}
