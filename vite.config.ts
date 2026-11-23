import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // git worktree を .claude/worktrees/ に置くことがあるので、その中のテストまで走らせない
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
})
