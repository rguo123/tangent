import { resolve } from 'path'

/** Single source of truth for bundler-level path aliases (electron-vite + vitest).
 *  The TypeScript-level mirror lives in tsconfig.base.json `paths`. */
export const alias = {
  '@shared': resolve('src/shared'),
}
