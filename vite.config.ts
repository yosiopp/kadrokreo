import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // editor と viewer の開発サーバーを同時に立てる（e2e がそうする）と、同じ node_modules/.vite で依存の事前バンドルを
  // 取り合い、React が二重に読み込まれて画面が出ないことがある（キャッシュの無い CI や npm ci の直後に起きる）。モードごとに分ける
  cacheDir: mode === 'editor' ? 'node_modules/.vite-editor' : 'node_modules/.vite',
  test: {
    // git worktree を .claude/worktrees/ に置くことがあるので、その中のテストまで走らせない
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
}))
