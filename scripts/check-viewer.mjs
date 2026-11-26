// viewer のビルド（dist/viewer）に editor のコードが入っていないかを確かめる。
//   npm run check:viewer        （npm run build の後に。npm run check の中でも流れる）
// editor にしかない文言・API が viewer の出力に 1 つでも見つかったら、ファイル名を出して失敗する。
// PNG 書き出しは viewer にもあるので、`PNG` や `toBlob` は検索語に入れない。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'dist/viewer')
const pattern = /kdr に書き出し|影を付ける|ページを追加|indexedDB|BroadcastChannel|CompressionStream|表せないものは置き換えるか読み飛ばしました/

if (!existsSync(dir)) {
  console.error('dist/viewer がありません。先に npm run build を実行してください。')
  process.exit(1)
}

/** @param {string} d */
function* files(d) {
  for (const name of readdirSync(d)) {
    const path = join(d, name)
    if (statSync(path).isDirectory()) yield* files(path)
    else yield path
  }
}

const found = []
for (const path of files(dir)) {
  const match = readFileSync(path, 'utf8').match(pattern)
  if (match) found.push(`${relative(root, path)}（${match[0]}）`)
}

if (found.length > 0) {
  console.error('viewer のビルドに editor のコードが入っています:')
  for (const line of found) console.error(`  ${line}`)
  console.error('viewer 側から src/editor/ を import している所を探してください。')
  process.exit(1)
}
console.log('viewer のビルドに editor のコードは入っていません（dist/viewer）。')
