// e2e のスクリプトが共有する部品（出力先、サーバーの URL、確認の記録と終わり方、エラーの集め方、保存されたドキュメントの読み方）。
const path = require('path')
const fs = require('fs')

/** スクリーンショットや書き出したファイルの置き場所 */
const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
const VIEWER = process.env.VIEWER_URL || 'http://localhost:5181'

let failures = 0

/** 確認の結果を 1 行出す。ok でなければ失敗として数える */
function check(name, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

/** 失敗の数を出して終わる（失敗があれば終了コード 1） */
function finish() {
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

/** スクリプトが途中で投げたときの終わり方 */
function crashed(e) {
  console.error('CRASHED', e)
  process.exit(1)
}

/** page のスクリプトのエラーとコンソールのエラーを errors に集める。prefix は頭に付ける文字 */
function watchErrors(page, errors, prefix = '') {
  page.on('pageerror', (e) => errors.push(prefix + String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(prefix + m.text()))
}

/** editor が自動保存した（IndexedDB の）ドキュメント */
function savedDocument(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      // ノードの表は ['nodes', 番号] のレコードに分けて書いてある（src/editor/persistence.ts）。ページに戻して返す
      const store = open.result.transaction('document').objectStore('document')
      const request = store.get('current')
      const chunks = store.getAll(IDBKeyRange.bound(['nodes', 0], ['nodes', Infinity]))
      request.onerror = () => reject(request.error)
      chunks.onerror = () => reject(chunks.error)
      chunks.onsuccess = () => {
        const { document, chunks: count } = request.result
        if (typeof count !== 'number') return resolve(document)
        const parts = chunks.result.slice(0, count)
        resolve({
          ...document,
          pages: document.pages.map((page, index) => ({
            ...page,
            nodes: Object.fromEntries(parts.filter((chunk) => chunk.page === index).flatMap((chunk) => Object.entries(chunk.nodes))),
          })),
        })
      }
    }
  }))
}

module.exports = { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument }
