const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// グリッドで並べる: editor の「並べ方」でグリッドにし、列の数・列の幅・間隔を変えると子が並び直ること、
// 上下の矢印で 1 行ずつ並べ替えること、viewer のコードに display: grid で出て、保存した HTML をブラウザで開くと同じ並びになること
const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument, fieldFinder, rowFinder } = require('./harness.cjs')

const sourcePath = path.join(OUT, 'grid-layout-source.kdr')
const cli = (...args) => execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'), ...args], { encoding: 'utf8' })
// 横に並べる幅 300 のフレームに、A 60×40・B 80×60・C（幅も高さも伸ばす）・D 40×20
cli(
  ...('new Demo + add frame --name Cards --id cards --width 300 --height 200 fill=#ffffff' +
    ' + set cards layout=row width=300 gap=10 padding=20' +
    ' + add rect --parent cards --name A --id a --width 60 --height 40 fill=#ff0000' +
    ' + add rect --parent cards --name B --id b --width 80 --height 60 fill=#00aa00' +
    ' + add rect --parent cards --name C --id c fill=#0000ff width=fill height=fill' +
    ' + add rect --parent cards --name D --id d --width 40 --height 20 fill=#888888').split(' '),
  '-o', sourcePath,
)

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  await page.locator('input[type=file][accept^=".kdr"]').setInputFiles(sourcePath)
  await page.waitForTimeout(500)
  const field = fieldFinder(page, { scope: '.properties-panel' })
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const select = (label) => page.locator(`.properties-panel .field:has(.field-label:text-is("${label}")) select`)
  const row = rowFinder(page, { first: true })
  const nodes = async () => {
    await page.waitForTimeout(700)
    return Object.fromEntries(Object.values((await savedDocument(page)).pages[0].nodes).map((n) => [n.name, n]))
  }
  const box = (n) => [n.x, n.y, n.width, n.height].join()

  // ── グリッドにする ──
  await row('Cards').click()
  await select('並べ方').selectOption('grid')
  let n = await nodes()
  check('グリッドにすると、いまの 1 行の子の数を列の数にする', n.Cards.layout.mode === 'grid' && n.Cards.layout.columns === 4 && (await field('列の数').inputValue()) === '4', JSON.stringify(n.Cards.layout))
  // 内側 260、間隔 10 × 3 → 列の幅 57.5
  check('列を等分して並べる', n.B.x === 87.5 && n.D.x === 222.5 && n.C.width === 57.5, `${n.B.x} ${n.D.x} ${n.C.width}`)

  // ── 列の数・間隔を変える ──
  await set('列の数', 2)
  await set('行の間隔', 16)
  n = await nodes()
  // 列の幅 (260 - 10) / 2 = 125。1 行目の高さは B の 60、2 行目は D の 20（C は伸ばすので数えない）
  check('列の数と行の間隔を変えると並び直す',
    box(n.A) === '20,20,60,40' && box(n.B) === '155,20,80,60' && box(n.C) === '20,96,125,20' && box(n.D) === '155,96,40,20' && n.Cards.height === 136,
    [n.A, n.B, n.C, n.D, n.Cards].map(box).join(' / '))
  await page.screenshot({ path: path.join(OUT, '64-grid-layout.png') })

  // ── 上下の矢印は 1 行ずつ並べ替える ──
  await row('A').click()
  await page.keyboard.press('ArrowDown')
  n = await nodes()
  const order = (doc) => doc.Cards.children.map((id) => Object.values(doc).find((node) => node.id === id).name).join()
  check('下の矢印で、列の数だけ後ろへ並べ替える', order(n) === 'C,B,A,D', order(n))
  await page.keyboard.press('ArrowUp')
  n = await nodes()
  check('上の矢印で戻る', order(n) === 'A,B,C,D', order(n))

  // ── 列の幅を固定にして、寄せる ──
  await row('Cards').click()
  await select('列の幅').selectOption('fixed')
  check('固定にすると、いまの等分の幅から始める', (await field('固定の幅').inputValue()) === '125', await field('固定の幅').inputValue())
  await set('固定の幅', 100)
  await select('寄せ').selectOption('center')
  n = await nodes()
  // 列のまとまり 100 × 2 + 10 = 210、余り 50 の半分を先に空ける
  check('列の幅を固定にすると、その幅で並べ、寄せ方で置く', n.Cards.layout.columnWidth === 100 && n.A.x === 45 && n.B.x === 155 && n.C.width === 100, `${n.A.x} ${n.B.x} ${n.C.width}`)
  await page.screenshot({ path: path.join(OUT, '64-grid-layout-fixed.png') })

  // ── 書き出して viewer で開く ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'grid-layout.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  const cards = Object.values(json.document.pages[0].nodes).find((node) => node.name === 'Cards')
  check('kdr にグリッドの設定が入る', json.version === 17 && cards.layout.mode === 'grid' && cards.layout.columns === 2 && cards.layout.columnWidth === 100, JSON.stringify(cards.layout))

  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.locator('.layer-row:has(.layer-name:text-is("Cards"))').click()
  const panel = viewer.locator('.inspect-panel')
  const inspectText = await panel.innerText()
  check('viewer の CSS に display: grid と列の定義が出る',
    inspectText.includes('display: grid;') && inspectText.includes('grid-template-columns: repeat(2, 100px);') && inspectText.includes('gap: 16px 10px;') && inspectText.includes('justify-content: center;'),
    inspectText.slice(0, 400))
  await viewer.screenshot({ path: path.join(OUT, '64-grid-layout-viewer.png') })

  // 保存した HTML をブラウザで開くと、editor と同じ位置と大きさに並ぶ
  const htmlSection = panel.locator('section[aria-label="HTML"]')
  const [htmlFile] = await Promise.all([viewer.waitForEvent('download'), htmlSection.locator('button:text-is("HTML ファイルを保存")').click()])
  const htmlPath = path.join(OUT, 'grid-layout.html')
  await htmlFile.saveAs(htmlPath)
  const opened = await context.newPage()
  await opened.goto('file://' + htmlPath)
  const placed = await opened.evaluate(() => ['a', 'b', 'c', 'd', 'cards'].map((name) => {
    const r = document.querySelector(`.${name}`).getBoundingClientRect()
    return [r.x, r.y, r.width, r.height].join()
  }).join(' / '))
  const expected = [n.A, n.B, n.C, n.D, { x: 0, y: 0, width: n.Cards.width, height: n.Cards.height }].map(box).join(' / ')
  check('保存した HTML をブラウザで開くと、editor と同じ並びになる', placed === expected, `${placed}（期待 ${expected}）`)

  // 列を等分にしても同じ（repeat(N, minmax(0, 1fr))）
  await row('Cards').click()
  await select('列の幅').selectOption('equal')
  n = await nodes()
  const [download2] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  await download2.saveAs(kdrPath)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForTimeout(300)
  await viewer.locator('.layer-row:has(.layer-name:text-is("Cards"))').click()
  const [htmlFile2] = await Promise.all([viewer.waitForEvent('download'), htmlSection.locator('button:text-is("HTML ファイルを保存")').click()])
  await htmlFile2.saveAs(htmlPath)
  await opened.goto('file://' + htmlPath)
  const placedEqual = await opened.evaluate(() => ['a', 'b', 'c', 'd'].map((name) => {
    const r = document.querySelector(`.${name}`).getBoundingClientRect()
    return [r.x, r.y, r.width, r.height].join()
  }).join(' / '))
  const expectedEqual = [n.A, n.B, n.C, n.D].map(box).join(' / ')
  check('列を等分したグリッドも、ブラウザで同じ並びになる', placedEqual === expectedEqual, `${placedEqual}（期待 ${expectedEqual}）`)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
