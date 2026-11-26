const { chromium } = require('playwright-core')
const path = require('path')

// editor の多角形・星のツール: ツールバーで頂点の数（星は内側の割合）を決めて描くと、ふつうの閉じたパスになる。
// Shift で正しい形の縦横比、クリックだけなら幅 100 の正しい形。描いたあとは頂点の編集とブーリアン演算ができる
const { OUT, EDITOR, check, finish, crashed, watchErrors, pointer, fieldFinder, savedDocument } = require('./harness.cjs')

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
  const drag = async (from, to, shift = false) => {
    if (shift) await page.keyboard.down('Shift')
    await page.mouse.move(...at(...from))
    await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    await page.mouse.up()
    if (shift) await page.keyboard.up('Shift')
  }
  const layers = () => page.locator('.layer-row .layer-name').allTextContents()
  const field = fieldFinder(page)
  const nodes = async () => Object.values((await savedDocument(page)).pages[0].nodes)
  const byName = async (name) => (await nodes()).find((node) => node.name === name)

  // ── 多角形（六角形）をドラッグで描く ──
  await page.locator('button[aria-label="多角形"]').click()
  const countInput = page.locator('input[aria-label="多角形の頂点の数"]')
  check('多角形のツールを選ぶと頂点の数の欄が出る（既定は 3）', (await countInput.inputValue()) === '3', await countInput.inputValue())
  check('星の内側の欄は出ない', (await page.locator('input[aria-label^="星の内側"]').count()) === 0)
  // 2 桁を 1 文字ずつ打てる（打ちかけの「1」を 3 に丸めて書き戻さない）。空にしてフォーカスを外すと元の値に戻る
  await countInput.fill('')
  await countInput.pressSequentially('12')
  check('2 桁の頂点の数を打ち込める', (await countInput.inputValue()) === '12', await countInput.inputValue())
  await countInput.fill('')
  await countInput.blur()
  check('空のままフォーカスを外すと元の値に戻る', (await countInput.inputValue()) === '12', await countInput.inputValue())
  await countInput.fill('')
  await countInput.pressSequentially('6')
  await drag([100, 100], [260, 220])
  check('Polygon 1 ができ、選択ツールに戻る', (await layers()).includes('Polygon 1') &&
    (await page.locator('[aria-label="選択"]').getAttribute('aria-pressed')) === 'true', (await layers()).join())
  check('ドラッグした枠いっぱいに広がる', (await field('W').inputValue()) === '160' && (await field('H').inputValue()) === '120',
    `${await field('W').inputValue()} × ${await field('H').inputValue()}`)
  check('ツールバーの頂点の欄は、多角形のツールを外すと消える', (await countInput.count()) === 0)
  await page.waitForTimeout(700)
  const hex = await byName('Polygon 1')
  check('頂点が 6 つの閉じたパスとして保存される（線は付けない）', hex?.type === 'path' && hex.closed === true && hex.points.length === 6 && hex.strokes.length === 0, JSON.stringify(hex?.points))

  // ── 星を Shift で描く（正しい形の縦横比）。内側を 50% に ──
  await page.locator('button[aria-label="星"]').click()
  check('多角形の頂点の数は覚えている（星は別の欄）', (await page.locator('input[aria-label="星の先の数"]').inputValue()) === '5')
  await page.locator('input[aria-label="星の内側の半径（先に対する %）"]').fill('50')
  await drag([400, 100], [500, 300], true)
  const widthText = await field('W').inputValue()
  check('Shift で描いても幅に細かい端数が残らない（小数 2 桁まで）', /^\d+(\.\d{1,2})?$/.test(widthText), widthText)
  const width = Number(widthText)
  const height = Number(await field('H').inputValue())
  // 先が 5 つの星の幅 / 高さ = 2 sin 72° / (1 + cos 36°) ≒ 1.0515
  check('Shift で描くと正しい星の縦横比', Math.abs(width / height - (2 * Math.sin((2 * Math.PI) / 5)) / (1 + Math.cos(Math.PI / 5))) < 0.02, `${width} × ${height}`)
  await page.waitForTimeout(700)
  const starNode = await byName('Star 1')
  check('星は頂点が 10 の閉じたパス', starNode?.type === 'path' && starNode.closed && starNode.points.length === 10, String(starNode?.points.length))
  await page.screenshot({ path: path.join(OUT, '53-polygon-star.png') })

  // ── クリックだけなら幅 100 の正しい形 ──
  await page.locator('button[aria-label="多角形"]').click()
  check('次に多角形を選ぶと、前に決めた 6 のまま', (await page.locator('input[aria-label="多角形の頂点の数"]').inputValue()) === '6')
  await page.mouse.click(...at(700, 100))
  check('クリックで置くと幅 100・高さは正六角形の比（115.47）', (await field('W').inputValue()) === '100' && (await field('H').inputValue()) === '115.47',
    `${await field('W').inputValue()} × ${await field('H').inputValue()}`)

  // ── ほかのパスと同じく扱える: 頂点の編集（Enter）とブーリアン演算 ──
  // 六角形（100,100〜260,220）をダブルクリックして頂点の編集に入り、上の頂点（180,100）を上へ 40 動かす
  await page.keyboard.press('Escape')
  await page.mouse.dblclick(...at(180, 160))
  await drag([180, 100], [180, 60])
  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  const moved = await byName('Polygon 1')
  check('頂点の編集で頂点を動かせる（高さが 160 に）', moved.height === 160 && moved.points.length === 6, `${moved.width}×${moved.height}`)
  await page.locator('.layer-row:has(.layer-name:text-is("Polygon 1"))').click()
  await page.locator('.layer-row:has(.layer-name:text-is("Star 1"))').click({ modifiers: ['Shift'] })
  await page.keyboard.press('Alt+Shift+KeyU')
  await page.waitForTimeout(300)
  check('多角形と星をブーリアン演算のノードにまとめられる', (await layers()).includes('合体'), (await layers()).join())

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
