// パスのブーリアン演算（合体・差し引き・交差・除外）。キー（⌥⇧U / S / I / X）と右クリックメニュー、結果が空のときの知らせ
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
  const named = async (name) => Object.values((await saved()).nodes).filter((n) => n.name === name)

  const origin = { x: Math.round(box.width / 2 - 100), y: Math.round(box.height / 2 - 100) }
  const at = (x, y) => [box.x + origin.x + x, box.y + origin.y + y]
  const shiftClick = async (x, y) => { await page.keyboard.down('Shift'); await page.mouse.click(...at(x, y)); await page.keyboard.up('Shift') }

  // 200×200 の SVG（左上の正方形と、それに重なる円、離れた小さな正方形）を貼り付ける。画面の真ん中に置かれる
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
      '<rect id="a" x="20" y="20" width="100" height="100" fill="#e5484d"/><circle id="b" cx="120" cy="120" r="50" fill="#30a46c"/>' +
      '<rect id="far" x="185" y="5" width="10" height="10" fill="#0090ff"/></svg>')
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(700)
  const select = async () => { await page.keyboard.press('Escape'); await page.mouse.click(...at(40, 40)); await shiftClick(150, 150) }

  // ── 差し引き（⌥⇧S）: 正方形から円を引く。結果は正方形の名前・色を引き継いだパス ──
  await select()
  await page.keyboard.press('Alt+Shift+KeyS')
  await page.waitForTimeout(600)
  let [result] = await named('a')
  check('差し引きで、正方形から円を引いたパスになる', result?.type === 'path' && result.fillRule === 'evenodd' && (await named('b')).length === 0 &&
    Math.abs(result.width - 100) < 0.01 && Math.abs(result.height - 100) < 0.01, JSON.stringify(result && { type: result.type, w: result.width, h: result.height }))
  check('曲線のまま残る（制御点を持つ頂点がある）', result?.points.some((p) => p.in || p.out))
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, 'boolean-subtract.png') })
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(600)
  check('Undo で元の正方形と円に戻る', (await named('a'))[0]?.type === 'rect' && (await named('b'))[0]?.type === 'ellipse')

  // ── 合体（右クリックメニューの「ブーリアン演算（パスに焼き込む）」→「合体」） ──
  await select()
  await page.mouse.click(...at(40, 40), { button: 'right' })
  await page.locator('.context-menu-label:text-is("ブーリアン演算（パスに焼き込む）")').hover()
  await page.locator('.context-menu-label:text-is("合体")').click()
  await page.waitForTimeout(600)
  ;[result] = await named('a')
  check('合体で 1 つのパスになる（範囲は 2 つを合わせたもの）', result?.type === 'path' && Math.abs(result.width - 150) < 0.01 && Math.abs(result.height - 150) < 0.01,
    JSON.stringify(result && { type: result.type, w: result.width, h: result.height }))
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(600)

  // ── 交差（⌥⇧I）・除外（⌥⇧X） ──
  await select()
  await page.keyboard.press('Alt+Shift+KeyI')
  await page.waitForTimeout(600)
  ;[result] = await named('a')
  check('交差は重なった所だけ（50×50）', result?.type === 'path' && Math.abs(result.width - 50) < 0.01 && Math.abs(result.height - 50) < 0.01,
    JSON.stringify(result && { w: result.width, h: result.height }))
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(600)
  await select()
  await page.keyboard.press('Alt+Shift+KeyX')
  await page.waitForTimeout(600)
  ;[result] = await named('a')
  check('除外は重なりを抜く（範囲は 150×150）', result?.type === 'path' && Math.abs(result.width - 150) < 0.01, JSON.stringify(result && { w: result.width }))
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, 'boolean-exclude.png') })
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(600)

  // ── 結果が空になる交差は、何も変えずに知らせる ──
  await page.keyboard.press('Escape')
  await page.mouse.click(...at(40, 40))
  await shiftClick(190, 10)
  await page.keyboard.press('Alt+Shift+KeyI')
  await page.waitForTimeout(400)
  const message = await page.locator('body').textContent()
  check('空になるときは知らせて、何も変えない', message.includes('交差の結果が空') && (await named('a'))[0]?.type === 'rect' && (await named('far')).length === 1)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
