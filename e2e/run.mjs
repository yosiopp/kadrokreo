// ブラウザでの動作確認をまとめて実行する。
//   npm run e2e                 開発サーバーを立てて全スクリプトを実行
//   npm run e2e -- 05-style     名前に一致するスクリプトだけ実行
//   EDITOR_URL=... VIEWER_URL=... npm run e2e   起動済みのサーバー（Docker など）に対して実行
// Google Chrome がインストールされている必要がある。スクリーンショットなどは e2e/out に出る。
import { spawn } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const filter = process.argv[2] ?? ''
// 02 は 01 が書き出した kdr を使うので、番号順に実行する
const scripts = readdirSync(here)
  .filter((name) => /^\d+-.*\.cjs$/.test(name) && name.includes(filter))
  .sort()

const servers = []
const env = { ...process.env }

function startServer(mode, port) {
  const args = ['vite', '--port', String(port), '--strictPort', ...(mode === 'editor' ? ['--mode', 'editor'] : [])]
  servers.push(spawn('npx', args, { cwd: root, stdio: 'ignore' }))
  return `http://localhost:${port}`
}

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // まだ起動していない
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`サーバーが起動しません: ${url}`)
}

function run(script) {
  return new Promise((resolve) => {
    spawn('node', [join(here, script)], { env, stdio: 'inherit' }).on('exit', resolve)
  })
}

let failed = 0
try {
  env.EDITOR_URL ??= startServer('editor', 5180)
  env.VIEWER_URL ??= startServer('viewer', 5181)
  await Promise.all([waitFor(env.EDITOR_URL), waitFor(env.VIEWER_URL)])

  for (const script of scripts) {
    console.log(`\n=== ${script}`)
    if ((await run(script)) !== 0) failed++
  }
} finally {
  for (const server of servers) server.kill()
}

console.log(failed === 0 ? `\n${scripts.length} 本すべて成功` : `\n${failed} / ${scripts.length} 本が失敗`)
process.exit(failed === 0 ? 0 : 1)
