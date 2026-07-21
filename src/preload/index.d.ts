import type { TangentApi } from './index'

declare global {
  interface Window {
    tangent: TangentApi
  }
}

export {}
