// パスの結合・分割、マスクとして使う、頂点の編集中にペンで輪郭を描き足す
const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = open.result.transaction('document').objectStore('document').get('current')
      request.onsuccess = () => resolve(request.result.document.pages[0])
    }
  }))
  const nodes = async () => Object.values((await saved()).nodes)
  const named = async (name) => (await nodes()).filter((n) => n.name === name)

  const origin = { x: Math.round(box.width / 2 - 100), y: Math.round(box.height / 2 - 100) }
  const at = (x, y) => [box.x + origin.x + x, box.y + origin.y + y]
  const shiftClick = async (x, y) => { await page.keyboard.down('Shift'); await page.mouse.click(...at(x, y)); await page.keyboard.up('Shift') }

  // ── 頂点の編集中にペンで輪郭を描き足す。終わったら Undo で貼り付けごと戻す ──
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path id="tri" d="M20 20 L180 20 L100 180 Z" fill="#ffc53d"/></svg>')
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(700)
  await page.mouse.click(...at(100, 40))
  await page.mouse.dblclick(...at(100, 40))
  await page.waitForTimeout(300)
  await page.keyboard.press('p')
  for (const [x, y] of [[90, 50], [110, 50], [100, 70]]) await page.mouse.click(...at(x, y))
  await page.mouse.click(...at(90, 50))
  await page.waitForTimeout(600)
  const [tri] = await named('tri')
  check('ペンで描いた形がパスの輪郭として足される', tri?.contours.length === 1 && tri.contours[0].points.length === 3, JSON.stringify(tri?.contours))
  const hints = await page.locator('.panel-hint').allTextContents()
  check('描き足したあとは頂点の編集に戻る', hints.some((t) => t.includes('輪郭（1 つ）')), hints.join(' | '))
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, 'add-contour.png') })

  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+z')
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(600)
  check('Undo で貼り付ける前に戻る', (await nodes()).length === 0, String((await nodes()).length))

  // 200×200 の SVG（左上と右上に正方形）を貼り付ける。画面の真ん中に置かれる
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
      '<rect id="a" x="20" y="20" width="60" height="60" fill="#e5484d"/><rect id="b" x="120" y="20" width="60" height="60" fill="#30a46c"/>' +
      '<rect id="photo" x="20" y="40" width="160" height="140" fill="#0090ff"/></svg>')
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(700)

  // ── パスを結合（⌘E）・分割（⌘⇧E） ──
  await page.mouse.click(...at(50, 30))
  await shiftClick(150, 30)
  await page.keyboard.press('Meta+e')
  await page.waitForTimeout(600)
  let [joined] = await named('a')
  check('2 つの矩形を 1 つのパスにまとめる', joined?.type === 'path' && joined.contours.length === 1 && (await named('b')).length === 0,
    JSON.stringify(joined && { type: joined.type, contours: joined.contours.length }))
  await page.keyboard.press('Meta+Shift+e')
  await page.waitForTimeout(600)
  const parts = await named('a')
  check('輪郭ごとのパスに分ける', parts.length === 2 && parts.every((n) => n.type === 'path' && n.contours.length === 0), String(parts.length))
  await page.keyboard.press('Meta+z')
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(600)
  await page.mouse.click(...at(150, 30))
  await page.keyboard.press('Meta+e') // 1 つだけでは結合しない
  await page.waitForTimeout(300)
  check('Undo で元の 2 つの矩形に戻る。1 つだけでは結合しない', (await named('a'))[0]?.type === 'rect' && (await named('b'))[0]?.type === 'rect')

  // ── マスクとして使う（右クリックメニュー）：左上の正方形 a（20〜80）で、手前の写真 photo（y 40〜180）を切り取る ──
  await page.keyboard.press('Escape')
  await page.mouse.click(...at(50, 30))
  await shiftClick(100, 150)
  await page.mouse.click(...at(50, 30), { button: 'right' })
  await page.locator('.context-menu-label:text-is("マスクとして使う")').click()
  await page.waitForTimeout(600)
  const [mask] = await named('a')
  const [group] = await named('Mask group')
  check('背面の a がマスクになり、フレームにまとまる', mask?.isMask === true && group?.type === 'frame' && group.children.length === 2,
    JSON.stringify({ isMask: mask?.isMask, group: group?.children }))
  check('レイヤーにマスクの印が出る', (await page.locator('.layer-icon[title="マスク"]').count()) === 1)
  // a（20〜80）の外にある写真の部分は描かれず、当たらない。押すと奥の SVG のフレームが選ばれる
  await page.keyboard.press('Escape')
  await page.mouse.click(...at(150, 150))
  await page.waitForTimeout(300)
  const title = await page.locator('.properties-panel .panel-title').first().textContent()
  check('マスクの外は当たらない', title !== '長方形', title)
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, 'mask.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((e) => { console.error('CRASHED', e); process.exit(1) })
