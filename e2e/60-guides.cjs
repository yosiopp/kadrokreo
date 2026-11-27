const { chromium } = require('playwright-core')
const fs = require('fs')
const path = require('path')
const { parseKdrBytes } = require('./kdr.cjs')

// editor のガイド線: ルーラーから引き出して置き、図形が吸着する。ドラッグで動かし、ルーラーへ戻すと消える。
// 元に戻せる。ページに保存され（kdr の guides）、ルーラーを隠すと見えず吸着もしない
const { OUT, EDITOR, check, finish, crashed, watchErrors, pointer, fieldFinder, savedDocument } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const at = pointer(box)
  const drag = async (from, to, modifier) => {
    if (modifier) await page.keyboard.down(modifier)
    await page.mouse.move(...at(...from))
    await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    await page.mouse.up()
    if (modifier) await page.keyboard.up(modifier)
  }
  const field = fieldFinder(page)
  const guides = async () => {
    await page.waitForTimeout(700)
    return (await savedDocument(page)).pages[0].guides
  }
  // 100% にしてから描き、画面とページの座標のずれ（画面 = ページ + o）を長方形の位置から求める
  await page.keyboard.press('Shift+0')
  await page.keyboard.press('r')
  await drag([300, 300], [400, 380])
  const o = [300 - Number(await field('X').inputValue()), 300 - Number(await field('Y').inputValue())]
  const screen = (x, y) => [x + o[0], y + o[1]]
  const rect = async () => ({ x: Number(await field('X').inputValue()), y: Number(await field('Y').inputValue()), w: Number(await field('W').inputValue()), h: Number(await field('H').inputValue()) })
  await page.keyboard.press('Shift+R')

  // ── 左のルーラーから縦のガイド線を引き出す ──
  await drag([10, 600], [500, 600])
  let saved = await guides()
  check('左のルーラーから縦のガイド線を置ける', saved.length === 1 && saved[0].axis === 'x', JSON.stringify(saved))
  const gx = saved[0].position
  check('ガイド線の位置は、離した所の整数のページ座標', gx === 500 - o[0], `${gx} / ${500 - o[0]}`)

  // ── 上のルーラーから横のガイド線 ──
  await drag([700, 10], [700, 600])
  saved = await guides()
  check('上のルーラーから横のガイド線を置ける', saved.length === 2 && saved[1].axis === 'y' && saved[1].position === 600 - o[1], JSON.stringify(saved))
  const gy = saved[1].position

  // ── 長方形の左端をガイド線の 3px 手前へ動かすと吸着する ──
  let r = await rect()
  await drag(screen(r.x + 50, r.y + 40), screen(gx - 3 + 50, r.y + 40))
  check('移動でガイド線に吸着する', (await rect()).x === gx, `${(await rect()).x} / ${gx}`)
  // ⌘/Ctrl を押していれば吸着しない
  r = await rect()
  await drag(screen(r.x + 50, r.y + 40), screen(r.x + 50 - 4, r.y + 40), 'ControlOrMeta')
  check('⌘/Ctrl を押すと吸着しない', (await rect()).x === gx - 4, String((await rect()).x))

  // ── リサイズでもガイド線に吸着する（右下のハンドルを横のガイド線の 3px 手前へ）──
  r = await rect()
  await drag(screen(r.x + r.w, r.y + r.h), screen(r.x + r.w, gy - 3))
  r = await rect()
  check('リサイズでガイド線に吸着する', r.y + r.h === gy, `${r.y} + ${r.h} / ${gy}`)

  // ── ガイド線をつかんで動かす（図形のない所で）──
  const placed = r
  await page.keyboard.press('Escape')
  await drag(screen(gx, gy + 100), screen(gx + 20, gy + 100))
  saved = await guides()
  check('置いたガイド線をドラッグで動かせる', saved[0].position === gx + 20, JSON.stringify(saved))

  // ── ルーラーへ戻すと消え、元に戻すと戻る ──
  await drag(screen(gx + 20, gy + 100), [8, gy + 100 + o[1]])
  saved = await guides()
  check('ルーラーへ戻すとガイド線が消える', saved.length === 1 && saved[0].axis === 'y', JSON.stringify(saved))
  await page.keyboard.press('ControlOrMeta+z')
  saved = await guides()
  check('元に戻すとガイド線が戻る', saved.length === 2 && saved[0].position === gx + 20, JSON.stringify(saved))

  // ── キャンバスの外（ルーラーより上）まで引き上げて離しても消える ──
  await drag(screen(gx + 200, gy), [gx + 200 + o[0], -40])
  saved = await guides()
  check('キャンバスの外まで引き上げて離すとガイド線が消える', saved.length === 1 && saved[0].axis === 'x', JSON.stringify(saved))
  await page.keyboard.press('ControlOrMeta+z')
  saved = await guides()
  check('元に戻すと戻る', saved.length === 2, JSON.stringify(saved))

  // ── ルーラーを隠すと吸着しない（ガイド線の 3px 手前で止まる）──
  await page.keyboard.press('Shift+R')
  r = placed
  await drag(screen(r.x + 10, r.y + 10), screen(gx + 20 - 3 + 10, r.y + 10))
  check('ルーラーとガイドを隠すと吸着しない', (await rect()).x === gx + 17, `${(await rect()).x} / ${gx + 20}`)

  // ── kdr に書き出すとページに guides が入る ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:has-text("kdr に書き出し")').click()])
  const file = path.join(OUT, 'guides.kdr')
  await download.saveAs(file)
  const json = await parseKdrBytes(fs.readFileSync(file))
  check('書き出した kdr のページにガイド線が入る', json.raw.document.pages[0].guides?.length === 2, JSON.stringify(json.raw.document.pages[0].guides))

  // 右クリックメニューで全部消す（ルーラーを出しているときだけ押せる）
  await page.keyboard.press('Escape')
  await page.mouse.click(...at(150, 700), { button: 'right' })
  check('ルーラーを隠していると「ガイドをすべて削除」は押せない',
    await page.locator('.context-menu button:has-text("ガイドをすべて削除")').isDisabled())
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+R')
  await page.mouse.click(...at(150, 700), { button: 'right' })
  await page.locator('.context-menu button:has-text("ガイドをすべて削除")').click()
  check('右クリックメニューでガイドをすべて消せる', (await guides()).length === 0)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
