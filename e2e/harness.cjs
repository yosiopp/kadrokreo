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

/**
 * 何も読み込んでいないページ。書き出した SVG や画像を <img> に入れてブラウザに描かせるときは、アプリのページでなくここで行う。
 * 配布するイメージは CSP で blob: や data: の画像を止めているので、アプリのページの <img> では読めない
 * （Blob を createImageBitmap に渡すのは止められないので、PNG の画素を読むだけならアプリのページでもよい）
 */
async function blankPage(context, errors) {
  const page = await context.newPage()
  watchErrors(page, errors, 'blank: ')
  return page
}

/**
 * 相手が Vite の開発サーバーか（ソースのモジュールを /src/… から読めるか）。配布するイメージ（nginx）は index.html を返すので false。
 * ソースの関数を page から直接呼ぶ確認は、開発サーバーのときだけ行う
 */
function servesSource(page) {
  return page.evaluate(async () => {
    const response = await fetch('/src/main.tsx')
    return response.ok && !(response.headers.get('content-type') ?? '').includes('text/html')
  })
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

/** .canvas-view の中の位置（box は .canvas-view の枠、origin は中の原点のずれ）を、画面の座標 [x, y] にする関数 */
function pointer(box, origin = { x: 0, y: 0 }) {
  return (x, y) => [box.x + origin.x + x, box.y + origin.y + y]
}

/**
 * パネルの欄の入力を、欄の名前で探す関数。名前が重なれば最初の欄（first: false なら全部）。
 * scope は探す範囲のセレクタ（'.properties-panel' など）
 */
function fieldFinder(page, { scope = '', first = true } = {}) {
  return (label) => {
    const inputs = page.locator(`${scope === '' ? '' : `${scope} `}.field:has(.field-label:text-is("${label}")) input`)
    return first ? inputs.first() : inputs
  }
}

/** レイヤーの行を名前で探す関数。originals はインスタンスの中身（写し）の行を除く。first は重なれば最初の行 */
function rowFinder(page, { originals = false, first = false } = {}) {
  return (name) => {
    const rows = page.locator(`.layer-row${originals ? '[data-copy="false"]' : ''}:has(.layer-name:text-is("${name}"))`)
    return first ? rows.first() : rows
  }
}

module.exports = { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, blankPage, servesSource, savedDocument, pointer, fieldFinder, rowFinder }
