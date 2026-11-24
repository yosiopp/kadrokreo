const { chromium } = require('playwright-core')
const path = require('path')

// 小さな残り 3: グラデーションの図形をダブルクリックして、キャンバスでグラデーションを動かす操作に入る
const { OUT, EDITOR, check, finish, watchErrors, pointer } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const at = pointer(box)
  const drag = async (from, to) => {
    await page.mouse.move(...at(...from)); await page.mouse.down()
    await page.mouse.move(...at(...to), { steps: 6 })
    await page.mouse.up()
  }
  const deselect = () => page.mouse.click(...at(740, 600))
  const typeSelect = (label) => page.locator(`.field:has(.field-label:text-is("${label}の種類")) select`)
  const canvasButton = page.locator('.properties-panel button[aria-pressed]:not(.icon-button)')
  const editing = async () => (await canvasButton.count()) > 0 && (await canvasButton.getAttribute('aria-pressed')) === 'true'

  // 直線のグラデーションの長方形と、単色の長方形
  await page.keyboard.press('r'); await drag([100, 100], [300, 200])
  await typeSelect('塗り').selectOption('linear')
  await deselect()
  await page.keyboard.press('r'); await drag([400, 100], [500, 200])
  await deselect()

  await page.mouse.dblclick(...at(200, 150))
  check('グラデーションの図形をダブルクリックすると、キャンバスでの編集に入る', await editing())
  await page.screenshot({ path: path.join(OUT, '30-gradient-dblclick.png') })
  await page.keyboard.press('Escape')
  await deselect()

  await page.mouse.dblclick(...at(450, 150))
  check('単色の図形のダブルクリックでは入らない（選ぶだけ）', !(await editing()) && (await page.locator('.layer-row[data-selected="true"]').count()) === 1)

  check('エラーが出ない', errors.length === 0, errors.join(' / '))
  await browser.close()
  finish()
})().catch((error) => { console.error(error); process.exit(1) })
