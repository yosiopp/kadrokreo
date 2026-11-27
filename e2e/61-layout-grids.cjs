const { chromium } = require('playwright-core')
const path = require('path')

// editor のレイアウトグリッド: フレームのプロパティで足し、数・溝・余白・種類を変えられ、キャンバスに重ねて出る。
// 中の図形はカラムの端に吸着する。Shift+G で隠すと見えず吸着もしない。kdr のフレームの layoutGrids に保存される
const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, pointer, fieldFinder, savedDocument } = require('./harness.cjs')

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
  const drag = async (from, to) => {
    await page.mouse.move(...at(...from))
    await page.mouse.down()
    await page.mouse.move(...at((from[0] + to[0]) / 2, (from[1] + to[1]) / 2), { steps: 4 })
    await page.mouse.move(...at(...to), { steps: 4 })
    await page.mouse.up()
  }
  const field = fieldFinder(page)
  const value = async (label) => Number(await field(label).inputValue())
  const pixel = (x, y) => page.evaluate(async ([x, y]) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    return [...canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data]
  }, [x, y])
  const frameNode = async () => {
    await page.waitForTimeout(700)
    return Object.values((await savedDocument(page)).pages[0].nodes).find((node) => node.type === 'frame')
  }

  // ── 100% でフレームを描く（白い塗り）──
  await page.keyboard.press('Shift+0')
  await page.keyboard.press('f')
  await drag([100, 100], [500, 400])
  const frame = { x: await value('X'), y: await value('Y') }
  const o = [100 - frame.x, 100 - frame.y] // 画面 = ページ + o
  check('レイアウトグリッドの欄は空で始まる', (await page.locator('.layout-grid-row').count()) === 0)
  const white = await pixel(100 + 30, 250)

  // ── カラムを足して、4 本・溝 20・余白 20 にする ──
  await page.locator('button[aria-label="レイアウトグリッドを足す"]').click()
  check('+ でカラムのグリッドが足される（12 本・溝 20・余白 20）',
    (await value('数')) === 12 && (await value('溝')) === 20 && (await value('余白')) === 20)
  await field('数').fill('4')
  await field('数').press('Enter')
  let saved = await frameNode()
  check('数を変えると kdr のフレームに入る', JSON.stringify(saved.layoutGrids) === JSON.stringify([{ type: 'columns', count: 4, gutter: 20, margin: 20 }]), JSON.stringify(saved.layoutGrids))
  // 幅 400、余白 20、溝 20、4 本 → 帯の幅 (400 - 40 - 60) / 4 = 75。1 本目は 20〜95、2 本目は 115〜190
  check('カラムの帯がキャンバスに重なる', (await pixel(100 + 30, 250)).join() !== white.join(), `${white} → ${await pixel(130, 250)}`)
  check('溝には帯が無い', (await pixel(100 + 105, 250)).join() === white.join())

  // ── 中に長方形を描き、左端を 2 本目のカラムの左端（フレームの 115）の 3px 手前へ動かすと吸着する ──
  await field('数').blur()
  await page.keyboard.press('r')
  await drag([100 + 200, 300], [100 + 260, 340])
  check('長方形はフレームの中にできる', (await page.locator('.layer-row:has(.layer-name:text-is("Rectangle 1"))').count()) === 1)
  const rect = { x: frame.x + (await value('X')), y: frame.y + (await value('Y')) }
  await drag([rect.x + o[0] + 20, rect.y + o[1] + 20], [frame.x + 112 + o[0] + 20, rect.y + o[1] + 20])
  check('移動でカラムの端に吸着する（X はフレームの中の位置）', (await value('X')) === 115, String(await value('X')))

  // ── Shift+G で隠すと、帯が消えて吸着もしない ──
  await page.keyboard.press('Shift+G')
  check('Shift+G でボタンが外れる', (await page.locator('button[aria-label="レイアウトグリッド"]').getAttribute('aria-pressed')) === 'false')
  check('隠すと帯が消える', (await pixel(100 + 30, 250)).join() === white.join())
  await drag([frame.x + 115 + o[0] + 20, rect.y + o[1] + 20], [frame.x + 112 + o[0] + 20 - 30, rect.y + o[1] + 20])
  await drag([frame.x + 82 + o[0] + 20, rect.y + o[1] + 20], [frame.x + 112 + o[0] + 20, rect.y + o[1] + 20])
  check('隠している間はカラムに吸着しない', (await value('X')) === 112, String(await value('X')))
  await page.keyboard.press('Shift+G')

  // ── 種類を方眼にして間隔を変え、外す ──
  await page.locator('.layer-row:has(.layer-name:text-is("Frame 1"))').click()
  await page.locator('.layout-grid-row select').selectOption('grid')
  await field('間隔').fill('25')
  await field('間隔').press('Enter')
  saved = await frameNode()
  check('種類を方眼にして間隔を変えられる', JSON.stringify(saved.layoutGrids) === JSON.stringify([{ type: 'grid', size: 25 }]), JSON.stringify(saved.layoutGrids))
  await page.locator('button[aria-label="レイアウトグリッド 1 を外す"]').click()
  saved = await frameNode()
  check('− で外せる', saved.layoutGrids.length === 0)
  await page.keyboard.press('ControlOrMeta+z')
  saved = await frameNode()
  check('元に戻せる', saved.layoutGrids.length === 1)

  // ── viewer でも、ボタンでレイアウトグリッドを重ねて出せ、フレームを選ぶとパネルに値が出る ──
  await page.locator('.layout-grid-row select').selectOption('columns')
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:has-text("kdr に書き出し")').click()])
  const file = path.join(OUT, 'layout-grids.kdr')
  await download.saveAs(file)
  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(file)
  await viewer.waitForSelector('.canvas-view canvas')
  const gridButton = viewer.locator('button[aria-label="レイアウトグリッド"]')
  check('viewer: レイアウトグリッドのボタンは押せて、既定は出さない', !(await gridButton.isDisabled()) && (await gridButton.getAttribute('aria-pressed')) === 'false')
  check('viewer: ガイド線が無ければ、そのボタンは押せない', await viewer.locator('button[aria-label="ガイド線"]').isDisabled())
  const shot = async () => (await viewer.locator('.canvas-view canvas').screenshot()).toString('base64')
  const before = await shot()
  await gridButton.click()
  check('viewer: ボタンでレイアウトグリッドが重なる', (await shot()) !== before)
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Frame 1"))').first().click()
  const rows = await viewer.locator('.inspect-panel section[aria-label="レイアウトグリッド"] .inspect-row').allTextContents()
  check('viewer: フレームを選ぶと、パネルにレイアウトグリッドの値が出る', rows.some((row) => row.includes('カラム 12・溝 20・余白 20')), rows.join(' | '))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
