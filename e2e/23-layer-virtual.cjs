const { chromium } = require('playwright-core')
const { execFileSync } = require('child_process')
const path = require('path')

// 性能の改善の残り: レイヤーの一覧は見えている行だけを作る（仮想スクロール）。
// 行の多い kdr（計測用の makeKdr で作る）を editor と viewer で開き、作る行が一部だけなこと、
// スクロールすると下の行が出てきて選べること、パン・ドラッグ・ズームで使い回して描いた絵が全部を描いたときと同じことを確かめる。
// 画像は入れない（縮めて描いた画像の縁のにじみは、範囲を切って描くと Chrome の描き方が変わり、角の 1〜2 画素が薄く変わるため。pitfalls.md）
const OUT = path.join(__dirname, 'out')
require('fs').mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
const VIEWER = process.env.VIEWER_URL || 'http://localhost:5173'

let failures = 0
function check(name, condition, detail = '') {
  if (!condition) failures++
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

const kdrPath = path.join(OUT, 'many-layers.kdr')
const meta = JSON.parse(
  execFileSync('node', [path.join(__dirname, '..', 'cli', 'bench', 'makeKdr.ts'), '--nodes', '400', '--depth', '3', '--instances', '20', '--images', '0', '-o', kdrPath], {
    encoding: 'utf8',
  }),
)

/** 一覧（.layer-list）の高さから数えた行の数（作っていない行も含む）と、実際に作った行の要素の数 */
const listState = (page, itemSelector) =>
  page.evaluate((itemSelector) => {
    const list = [...document.querySelectorAll('.layer-list')].find((element) => element.querySelector(itemSelector))
    return { rows: Math.round((list.getBoundingClientRect().height - 12) / 28), made: list.querySelectorAll(itemSelector).length }
  }, itemSelector)

/** 一覧を含むパネル（スクロールする要素）をいちばん下までスクロールする */
const scrollToBottom = (page, itemSelector) =>
  page.evaluate(async (itemSelector) => {
    const list = [...document.querySelectorAll('.layer-list')].find((element) => element.querySelector(itemSelector))
    let scroller = list.parentElement
    while (!['auto', 'scroll'].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    scroller.scrollTop = scroller.scrollHeight
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, itemSelector)

/** キャンバスの全部の画素 */
const canvasPixels = (page) =>
  page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    return Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data)
  })

/** 2 つの絵で、色が tolerance 階調より違う画素の数と、いちばん大きな違い */
function compare(a, b, tolerance) {
  let count = 0
  let max = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i])
    max = Math.max(max, d)
    if (d > tolerance && i % 4 === 0) count++
  }
  return { count, max }
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
  const errors = []
  const watch = (page) => {
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  }

  // editor
  const page = await context.newPage()
  watch(page)
  await page.goto(EDITOR)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.waitForSelector('.canvas-view canvas')
  await page.locator('input[type=file][accept^=".kdr"]').setInputFiles(kdrPath)
  await page.waitForSelector('.layer-row')
  const opened = await listState(page, '.layer-row')
  check('editor: 一覧の高さはすべての行の分', opened.rows === meta.layerRows, `${opened.rows} / ${meta.layerRows}`)
  check('editor: 作る行は見えている分だけ', opened.made > 10 && opened.made < 150, String(opened.made))
  check('editor: 最後の行（DragTarget）はまだ作らない', (await page.locator('.layer-row:has(.layer-name:text-is("DragTarget"))').count()) === 0)
  await scrollToBottom(page, '.layer-row')
  const lastRow = page.locator('.layer-row:has(.layer-name:text-is("DragTarget"))')
  check('editor: いちばん下までスクロールすると最後の行が出る', (await lastRow.count()) === 1)
  await lastRow.click()
  check('editor: 出てきた行を押して選べる', (await page.locator('.layer-row[data-selected="true"] .layer-name').allTextContents()).join() === 'DragTarget')
  check('editor: スクロールしても作る行は見えている分だけ', (await listState(page, '.layer-row')).made < 150)
  await page.keyboard.press('Escape')

  // パンは前の絵をずらして端だけを描く。行き来して元の位置に戻ったら、最初に全部を描いた絵と同じになる
  const box = await page.locator('.canvas-view').boundingBox()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const before = await canvasPixels(page)
  for (const [dx, dy] of [[37, 0], [0, -53], [-120, 41], [83, 12]]) {
    await page.mouse.wheel(dx, dy)
    await canvasPixels(page)
  }
  const after = await canvasPixels(page)
  // 端を描くときの座標は、全部を描いたときと浮動小数点の誤差の分だけずれるので、縁のにじみが 1〜2 階調変わることはある
  const diff = compare(before, after, 2)
  check('editor: パンで端だけを描いても、全部を描いた絵と同じになる', diff.count === 0, `違う画素 ${diff.count}、最大 ${diff.max} 階調`)

  // 図形を動かすと、変わったノードの範囲だけを描き直す。動かしてから取り消して元に戻ったら、最初の絵と同じになる
  await lastRow.click()
  await page.keyboard.press('Shift+Digit2')
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(middle.x, middle.y)
  // 画面いっぱいだと描き直す範囲が広すぎて全部を描くので、ポインタの位置を中心に縮めて小さく映す
  await page.keyboard.down('Control')
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 50)
  await page.keyboard.up('Control')
  await page.waitForTimeout(300)
  const beforeDrag = await canvasPixels(page)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(middle.x + i * 7, middle.y + i * 3)
    await canvasPixels(page)
  }
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.mouse.move(middle.x, middle.y)
  const afterDrag = await canvasPixels(page)
  const dragDiff = compare(beforeDrag, afterDrag, 0)
  check('editor: ドラッグで範囲だけを描き直しても、取り消すと元の絵と同じになる', dragDiff.count === 0, `違う画素 ${dragDiff.count}、最大 ${dragDiff.max} 階調`)

  // ホイールでズームしている途中は前の絵を拡大・縮小して見せ、止まったら全部を描き直す
  await page.keyboard.press('Escape')
  await page.keyboard.down('Control')
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 30)
  await page.keyboard.up('Control')
  const zooming = await canvasPixels(page)
  await page.waitForTimeout(400)
  const settled = await canvasPixels(page)
  // 書体の読み込みが済んだときと同じく、取っておいた絵を捨てて全部を描かせる
  await page.evaluate(() => document.fonts.dispatchEvent(new Event('loadingdone')))
  const redrawn = await canvasPixels(page)
  check('editor: ズームの途中は前の絵を拡大・縮小して見せる', compare(zooming, redrawn, 2).count > 0)
  const zoomDiff = compare(settled, redrawn, 0)
  check('editor: ズームが止まったら、全部を描いた絵と同じになる', zoomDiff.count === 0, `違う画素 ${zoomDiff.count}、最大 ${zoomDiff.max} 階調`)

  // viewer
  const viewer = await context.newPage()
  watch(viewer)
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').first().setInputFiles(kdrPath)
  await viewer.waitForSelector('.inspect-layer')
  const viewed = await listState(viewer, '.inspect-layer')
  check('viewer: 一覧の高さはすべての行の分', viewed.rows === meta.layerRows, `${viewed.rows} / ${meta.layerRows}`)
  check('viewer: 作る行は見えている分だけ', viewed.made > 5 && viewed.made < 150, String(viewed.made))
  await scrollToBottom(viewer, '.inspect-layer')
  const viewerLast = viewer.locator('.inspect-layer:has(.layer-name:text-is("DragTarget"))')
  check('viewer: いちばん下までスクロールすると最後の行が出る', (await viewerLast.count()) === 1)
  await viewerLast.click()
  check('viewer: 出てきた行を押して選べる', (await viewer.locator('.inspect-layer[data-selected="true"] .layer-name').allTextContents()).join() === 'DragTarget')
  await viewer.locator('.layer-search').fill('Rect 1')
  const found = await viewer.locator('.inspect-layer .layer-name').allTextContents()
  check('viewer: 検索の結果も一覧に出る', found.length > 0 && found.every((name) => name.includes('Rect 1')), found.slice(0, 5).join())

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => {
  console.error('CRASHED', e)
  process.exit(1)
})
