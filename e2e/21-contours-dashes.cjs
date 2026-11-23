// 穴のあるパスの 2 つ目以降の輪郭を頂点の編集で動かす・足す・消すことと、線の欄の破線（ずれ）・角の形
const { chromium } = require('playwright-core')
const path = require('path')

const { OUT, EDITOR, check, finish, crashed, watchErrors, savedDocument } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const saved = async () => (await savedDocument(page)).pages[0]
  const ring = async () => Object.values((await saved()).nodes).find((n) => n.name === 'ring')
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }

  // 200×200 の SVG を貼り付ける。画面の真ん中に置かれる（最初の表示は等倍で、画面の左上がページの原点）
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><path id="ring" fill="#8e4ec6" stroke="#222222" fill-rule="evenodd" d="M20 20 H180 V180 H20 Z M70 70 H130 V130 H70 Z"/></svg>')
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(700)
  const origin = { x: Math.round(box.width / 2 - 100), y: Math.round(box.height / 2 - 100) }
  const at = (x, y) => [box.x + origin.x + x, box.y + origin.y + y]
  const drag = async (from, to) => {
    await page.mouse.move(...at(...from)); await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    await page.mouse.up()
  }
  let node = await ring()
  check('穴のあるパスを貼り付けた', node?.contours.length === 1, JSON.stringify(node?.contours))

  // ── 頂点の編集に入って、穴の頂点を動かす ──
  await page.mouse.click(...at(40, 40))
  await page.mouse.dblclick(...at(40, 100))
  await drag([70, 70], [60, 60])
  await page.waitForTimeout(500)
  node = await ring()
  // 枠は外側の輪郭のまま（20〜180）。穴の左上の頂点は (40, 40) / 160 の割合
  const hole = node.contours[0].points
  check('穴の頂点をドラッグで動かせる', node.width === 160 && Math.abs(hole[0].x - 40 / 160) < 1e-6 && Math.abs(hole[0].y - 40 / 160) < 1e-6 && Math.abs(hole[1].x - 110 / 160) < 1e-6,
    JSON.stringify(hole[0]))
  check('外側の輪郭は変わらない', node.points.length === 4 && node.points[0].x === 0 && node.points[2].x === 1)

  // ── 穴の辺のダブルクリックで頂点を足す ──
  await page.mouse.dblclick(...at(100, 130))
  await page.waitForTimeout(500)
  node = await ring()
  check('穴の辺に頂点を足せる', node.contours[0].points.length === 5 && node.points.length === 4, String(node.contours[0].points.length))
  const hints = await page.locator('.panel-hint').allTextContents()
  check('パネルに、選んだ頂点の輪郭を出す', hints.some((t) => /輪郭 2 \/ 2/.test(t)), hints.join(' | '))
  await page.screenshot({ path: path.join(OUT, 'contour-edit.png') })

  // ── 穴の頂点を Shift で全部選んで Delete → 穴ごと消える（足した頂点 (100, 130) は選ばれている） ──
  await page.keyboard.down('Shift')
  for (const [x, y] of [[60, 60], [130, 70], [130, 130], [70, 130]]) await page.mouse.click(...at(x, y))
  await page.keyboard.up('Shift')
  await page.keyboard.press('Delete')
  await page.waitForTimeout(500)
  node = await ring()
  check('輪郭の頂点を全部選んで消すと、輪郭ごと消える', node?.contours.length === 0 && node.points.length === 4, JSON.stringify(node?.contours))
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(500)
  check('Undo で穴が戻る', (await ring()).contours.length === 1)
  await page.keyboard.press('Escape')

  // ── 線の欄の破線 ──
  const dashed = page.locator('label.check-field:text-is("破線") input')
  check('最初は実線', !(await dashed.isChecked()))
  await dashed.check()
  await page.waitForTimeout(700)
  check('破線にすると既定の並び（4, 4）', (await ring()).strokeDashes.join(',') === '4,4', JSON.stringify((await ring()).strokeDashes))
  await set('破線の長さ', 10)
  await set('間隔', 3)
  await page.waitForTimeout(700)
  check('破線の長さ・間隔を変えられる', (await ring()).strokeDashes.join(',') === '10,3', JSON.stringify((await ring()).strokeDashes))
  await set('破線のずれ', 2)
  await page.locator('.field:has(.field-label:text-is("角の形")) select').selectOption('round')
  await page.waitForTimeout(700)
  check('破線のずれと線の角の形を変えられる', (await ring()).strokeDashOffset === 2 && (await ring()).strokeJoin === 'round',
    JSON.stringify([(await ring()).strokeDashOffset, (await ring()).strokeJoin]))
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, 'dashes.png') })
  await dashed.uncheck()
  await page.waitForTimeout(700)
  check('実線に戻せる', (await ring()).strokeDashes === undefined || (await ring()).strokeDashes.length === 0)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
