const { chromium } = require('playwright-core')

// editor のルーラー: Shift+R・ヘッダーのボタン・右クリックメニューで出し入れでき、ブラウザが覚えている。
// 帯の上を押しても下の図形は選ばれない。ルーラーは kdr にも書き出しにも入らない
const { EDITOR, check, finish, crashed, watchErrors, pointer, savedDocument } = require('./harness.cjs')

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
    await page.mouse.move(...at(...from))
    await page.mouse.down()
    await page.mouse.move(...at(...to), { steps: 6 })
    await page.mouse.up()
  }
  // 描画は requestAnimationFrame でまとめられるので、2 フレーム待ってから読む
  const pixel = (x, y) => page.evaluate(async ([x, y]) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    return [...canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data]
  }, [x, y])
  const button = page.locator('button[aria-label="ルーラー"]')
  const selectedCount = () => page.locator('.layer-row[data-selected="true"]').count()

  check('既定ではルーラーを出さない', (await button.getAttribute('aria-pressed')) === 'false')
  const before = await pixel(8, 300)

  // ── 長方形を描いてから Shift+R で出す ──
  await page.keyboard.press('r')
  await drag([10, 10], [200, 150])
  await page.keyboard.press('Shift+R')
  check('Shift+R でルーラーを出す（ボタンも押した状態）', (await button.getAttribute('aria-pressed')) === 'true')
  check('Shift+R で長方形のツールにならない', (await page.locator('[aria-label="選択"]').getAttribute('aria-pressed')) === 'true')
  const ruler = await pixel(8, 300)
  check('左の帯が描かれる（キャンバスの色と違う）', ruler.join() !== before.join(), `${before} → ${ruler}`)

  // ── 帯の上を押しても、下の長方形は選ばれず、選択も外れない ──
  await page.keyboard.press('Escape')
  await page.mouse.click(...at(100, 10))
  check('上の帯を押しても下の図形を選ばない', (await selectedCount()) === 0)
  await page.mouse.click(...at(100, 100))
  check('帯の外ではふつうに選べる', (await selectedCount()) === 1)
  await page.mouse.click(...at(10, 100))
  check('左の帯を押しても選択は外れない', (await selectedCount()) === 1)

  // ── 読み込み直しても覚えている。右クリックメニューで隠せる ──
  await page.reload()
  await page.waitForSelector('.canvas-view canvas')
  check('読み込み直してもルーラーを出したまま', (await button.getAttribute('aria-pressed')) === 'true')
  await page.mouse.click(...at(600, 500), { button: 'right' })
  await page.locator('.context-menu button:has-text("ルーラーを隠す")').click()
  check('右クリックメニューでルーラーを隠せる', (await button.getAttribute('aria-pressed')) === 'false')
  check('隠すと帯が消える', (await pixel(8, 300)).join() === before.join())
  await button.click()
  check('ボタンでも出せる', (await button.getAttribute('aria-pressed')) === 'true')

  // ── kdr には入らない ──
  await page.waitForTimeout(700)
  const doc = await savedDocument(page)
  check('自動保存のドキュメントにルーラーの設定は入らない', !JSON.stringify(doc).includes('ruler'))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
