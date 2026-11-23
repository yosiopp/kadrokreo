const { chromium } = require('playwright-core')
const path = require('path')

// レイヤーパネルの右クリックメニューと、メニューからの表示・ロックの切り替え
const { OUT, EDITOR, check, finish, watchErrors } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)

  await page.goto(EDITOR)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const at = (x, y) => [box.x + x, box.y + y]
  const drag = async (from, to) => {
    await page.mouse.move(...at(...from))
    await page.mouse.down()
    await page.mouse.move(...at(...to), { steps: 6 })
    await page.mouse.up()
  }
  const selected = () => page.locator('.layer-row[data-selected="true"] .layer-name').allTextContents()
  const row = (name) => page.locator(`.layer-row:has(.layer-name:text-is("${name}"))`).first()
  const menu = page.locator('.context-menu').first()
  const item = (name) => page.locator(`.context-menu-item:has(.context-menu-label:text-is("${name}"))`).first()
  const hidden = async (name) => (await row(name).getAttribute('data-hidden')) === 'true'
  const locked = async (name) => (await row(name).locator('.layer-toggle').first().getAttribute('data-active')) === 'true'

  // 素材: 長方形 2 つ
  for (const [from, to] of [[[100, 100], [200, 200]], [[300, 100], [400, 200]]]) {
    await page.keyboard.press('r')
    await drag(from, to)
  }
  await page.mouse.click(...at(700, 600))

  // ── 行の右クリックで、その行を選んでからメニューを出す ──
  await row('Rectangle 1').click({ button: 'right' })
  check('レイヤーの行を右クリックするとメニューが出る', await menu.isVisible())
  check('右クリックした行が選ばれる', (await selected()).join() === 'Rectangle 1', (await selected()).join())
  check('キャンバスと同じ項目が並ぶ', (await item('複製').isVisible()) && (await item('最前面へ').isVisible()) && (await item('選択へズーム').isVisible()))
  const menuBox = await menu.boundingBox()
  const rowBox = await row('Rectangle 1').boundingBox()
  // 縦は、下にはみ出す分だけ上へ寄せてウィンドウに収める
  check(
    'メニューは右クリックした所から出て、ウィンドウに収まる',
    Math.abs(menuBox.x - (rowBox.x + rowBox.width / 2)) < 4 && menuBox.y <= rowBox.y + rowBox.height / 2 && menuBox.y + menuBox.height <= 800,
    `${menuBox.x},${menuBox.y} ${rowBox.x},${rowBox.y}`,
  )
  await page.screenshot({ path: path.join(OUT, '31-layer-context-menu.png') })

  // ── 非表示 → Undo ──
  await item('非表示にする').click()
  check('メニューから非表示にできる', (await hidden('Rectangle 1')) && !(await menu.isVisible()))
  await row('Rectangle 1').click({ button: 'right' })
  check('隠したものには「表示する」が出る', await item('表示する').isVisible())
  await item('表示する').click()
  check('メニューから表示に戻せる', !(await hidden('Rectangle 1')))
  await page.keyboard.press('ControlOrMeta+z')
  check('Undo で表示の切り替えを戻せる（非表示に戻る）', await hidden('Rectangle 1'))
  await page.keyboard.press('ControlOrMeta+z')
  check('もう一度 Undo で元の表示に戻る', !(await hidden('Rectangle 1')))

  // ── ロック → Undo ──
  await row('Rectangle 1').click({ button: 'right' })
  await item('ロックする').click()
  check('メニューからロックできる', await locked('Rectangle 1'))
  await row('Rectangle 1').click({ button: 'right' })
  check('ロックしたものには「ロックを解除」が出る', await item('ロックを解除').isVisible())
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+z')
  check('Undo でロックを戻せる', !(await locked('Rectangle 1')))

  // ── 選んでいる行を右クリックしたら、複数の選択はそのまま。まとめて切り替わる ──
  await row('Rectangle 1').click()
  await row('Rectangle 2').click({ modifiers: ['Shift'] })
  await row('Rectangle 2').click({ button: 'right' })
  check('選んでいる行の右クリックでは選択を変えない', (await selected()).length === 2, (await selected()).join())
  await item('非表示にする').click()
  check('複数をまとめて非表示にできる', (await hidden('Rectangle 1')) && (await hidden('Rectangle 2')))
  await page.keyboard.press('ControlOrMeta+z')
  check('まとめた切り替えも 1 回の Undo で戻る', !(await hidden('Rectangle 1')) && !(await hidden('Rectangle 2')))

  // ── 選んでいない行の右クリックは、その行だけを選ぶ ──
  await page.mouse.click(...at(700, 600))
  await row('Rectangle 2').click()
  await row('Rectangle 1').click({ button: 'right' })
  check('選んでいない行の右クリックは、その行だけを選ぶ', (await selected()).join() === 'Rectangle 1', (await selected()).join())
  await page.keyboard.press('Escape')

  // ── キャンバスの右クリックメニューにも同じ切り替えがある ──
  await page.mouse.click(...at(350, 150), { button: 'right' })
  await item('ロックする').click()
  check('キャンバスのメニューからもロックできる', await locked('Rectangle 2'))
  await page.keyboard.press('ControlOrMeta+z')

  check('エラーが出ない', errors.length === 0, errors.join(' / '))
  await browser.close()
  finish()
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
