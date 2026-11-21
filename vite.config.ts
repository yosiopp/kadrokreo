import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    // 別のセッションの worktree（.claude/worktrees/）がこのフォルダの中にあるので、そのテストまで走らせない
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
})
