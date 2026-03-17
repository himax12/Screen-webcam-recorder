import type { RecorderApi } from './shared/types'

declare global {
  interface Window {
    recorderApi: RecorderApi
  }
}

export {}

