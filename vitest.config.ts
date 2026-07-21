import { defineConfig } from 'vitest/config'
import { alias } from './aliases'

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
