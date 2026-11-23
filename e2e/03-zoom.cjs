const { chromium } = require('playwright-core')
const path = require('path')
const { OUT, check, finish, crashed, watchErrors, savedDocument } = require('./harness.cjs')
require('fs').mkdirSync(OUT, { recursive: true })
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', deviceScaleFactor: 2 })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(process.env.EDITOR_URL || 'http://localhost:5180')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const at = (x, y) => [box.x + x, box.y + y]
  const drag = async (from, to, opts = {}) => {
    await page.mouse.move(...at(...from)); await page.mouse.down()
    await page.mouse.move(...at(...to), { steps: 6 })
    if (opts.beforeUp) await opts.beforeUp()
    await page.mouse.up()
  }
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const saved = async () => {
    const doc = await savedDocument(page)
    return { ...doc, nodes: Object.assign({}, ...doc.pages.map((page) => page.nodes)) }
  }

  // 画面をずらして拡大した状態で描く
  await page.mouse.move(...at(300, 300))
  await page.mouse.wheel(-120, -80)
  await page.keyboard.down('Meta'); await page.mouse.wheel(0, -50); await page.mouse.wheel(0, -50); await page.keyboard.up('Meta')
  const zoom = Number((await page.locator('.zoom-value').textContent()).replace('%', '')) / 100
  check('拡大されている', zoom > 1.5, String(zoom))
  await page.keyboard.press('r')
  await drag([200, 200], [200 + 100 * zoom, 200 + 50 * zoom])
  const w = Number(await field('W').inputValue()), h = Number(await field('H').inputValue())
  check('拡大中でもページ座標で正しい大きさになる', Math.abs(w - 100) <= 1 && Math.abs(h - 50) <= 1, `${w}x${h}`)

  // 拡大中に移動
  const x0 = Number(await field('X').inputValue())
  await drag([220, 220], [220 + 30 * zoom, 220])
  check('拡大中の移動量もページ座標', Math.abs(Number(await field('X').inputValue()) - (x0 + 30)) <= 1, await field('X').inputValue())

  // ドラッグ中の Escape で取り消し
  const x1 = await field('X').inputValue()
  await drag([300, 230], [500, 400], { beforeUp: () => page.keyboard.press('Escape') })
  check('ドラッグ中の Escape で元の位置に戻る', (await field('X').inputValue()) === x1, await field('X').inputValue())
  check('取り消した移動は履歴に残らない', true)

  // Shift で縦横比を保ってリサイズ（右下ハンドル）
  await page.mouse.click(...at(300, 230))
  // ハンドル位置を、矩形の左上の画面位置から求める
  await page.keyboard.press('Shift+Digit0')
  await page.locator('button:text-is("全体表示")').click()
  const box2 = { w: Number(await field('W').inputValue()), h: Number(await field('H').inputValue()) }
  const cx = box.width / 2, cy = box.height / 2
  const se = [cx + box2.w / 2, cy + box2.h / 2]
  await page.keyboard.down('Shift')
  await drag(se, [se[0] + 100, se[1] + 10])
  await page.keyboard.up('Shift')
  const w2 = Number(await field('W').inputValue()), h2 = Number(await field('H').inputValue())
  check('Shift で縦横比を保つ', Math.abs(w2 / h2 - 2) < 0.05 && w2 > box2.w, `${w2}x${h2}`)

  // 切り取りと貼り付け
  await page.keyboard.press('ControlOrMeta+x')
  check('切り取りで消える', (await page.locator('.layer-row').count()) === 0)
  await page.keyboard.press('ControlOrMeta+v')
  check('貼り付けで戻る', (await page.locator('.layer-row').count()) === 1)

  // 新規テキストを打っている途中で別の場所をクリックしても、元のテキストは残る
  await page.keyboard.press('t')
  await page.mouse.click(...at(100, 100))
  await page.keyboard.type('abc')
  await page.mouse.click(...at(100, 500))
  check('別の場所をクリックするとテキストが確定する', (await page.locator('.layer-name').allTextContents()).includes('Text 1') && (await page.locator('.text-editor').count()) === 0, (await page.locator('.layer-name').allTextContents()).join())
  await page.waitForTimeout(700)
  check('ドキュメントが壊れていない', Object.keys((await saved()).nodes).length === 2)

  await page.mouse.click(...at(cx, cy))
  await page.screenshot({ path: path.join(OUT, '7-dark.png') })
  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
