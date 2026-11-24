const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// コンポーネントの残り 2: 入れ子のインスタンスの中のノードをプロパティに結ぶ、プロパティの並べ替え、
// 差し替えのプロパティの候補（preferred values）、キャンバスでバリアントをまとまりの外へドラッグしたときの名前
const { OUT, EDITOR, VIEWER, check, finish, watchErrors, savedDocument, fieldFinder, rowFinder } = require('./harness.cjs')

// CLI で、ボタン（Label・Mark）を入れたカードの元、アイコン 2 つ、バリアントのまとまり（Chip）、ふつうのフレーム（Box）を作る。
// 全体が 100% で画面に収まる大きさにしておく（読み込むと全体が画面の中央に映る）
const sourcePath = path.join(OUT, 'component-rest-2-source.kdr')
const cli = (...args) => execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'), ...args], { encoding: 'utf8' })
cli(...(
  'new Demo + add frame --name Btn --width 80 --height 30 fill=#5b4cf5 + add text --parent Btn --name Label --text OK' +
  ' + add rect --parent Btn --name Mark --x 60 --y 4 --width 8 --height 8 + component Btn' +
  ' + add frame --name Icon --x 0 --y 60 --width 24 --height 24 fill=#ff8800 + component Icon' +
  ' + add frame --name Star --x 40 --y 60 --width 24 --height 24 fill=#00aa55 + component Star' +
  ' + add frame --name Card --x 120 --width 200 --height 100 + component Card + instance Btn --parent Card --name BtnInCard' +
  ' + add frame --name Chip --x 0 --y 140 --width 60 --height 24 fill=#ffcc00 + component Chip + variant-add Chip' +
  ' + add frame --name Box --x 260 --y 160 --width 160 --height 120 fill=#eeeeee'
).split(' '), '-o', sourcePath)

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
  const button = (label) => page.locator(`.properties-panel button:text-is("${label}")`)
  const row = rowFinder(page, { originals: true, first: true })
  const copyRow = (name) => page.locator(`.layer-row[data-copy="true"]:has(.layer-name:text-is("${name}"))`).first()
  const expand = async (layer) => {
    const caret = layer.locator('.layer-caret[aria-label="開く"]')
    if (await caret.count()) await caret.click()
  }
  const saved = () => savedDocument(page)
  const nodesOf = async () => { await page.waitForTimeout(700); return Object.values((await saved()).pages[0].nodes) }
  const mainNamed = (nodes, name) => nodes.find((n) => n.name === name && n.component && n.component.role === 'main')

  let nodes = await nodesOf()
  const card = mainNamed(nodes, 'Card')
  const btn = mainNamed(nodes, 'Btn')
  const icon = mainNamed(nodes, 'Icon')
  const star = mainNamed(nodes, 'Star')
  const btnInCard = nodes.find((n) => n.name === 'BtnInCard' && n.parentId === card.id)
  const labelCopy = nodes.find((n) => n.name === 'Label' && n.parentId === btnInCard.id)

  // ── 入れ子のインスタンスの中のノード（カードの中のボタンのラベル）を、カードのプロパティに結ぶ ──
  await expand(row('Card'))
  await expand(row('BtnInCard'))
  await copyRow('Label').click()
  check('入れ子のインスタンスの中身を選ぶと、元のプロパティに結べる', (await button('文言をプロパティに').count()) === 1)
  await button('文言をプロパティに').click()
  await row('BtnInCard').click()
  await button('元をプロパティに').click()
  nodes = await nodesOf()
  let properties = nodes.find((n) => n.id === card.id).component.properties
  check('写しの id に結んだプロパティができる', JSON.stringify(properties.map((p) => [p.name, p.type, p.targets])) ===
    JSON.stringify([['Label', 'text', [labelCopy.id]], ['BtnInCard', 'instance', [btnInCard.id]]]), JSON.stringify(properties))

  // ── プロパティの並べ替えと、差し替えの候補 ──
  await row('Card').click()
  await page.locator('[aria-label="プロパティ BtnInCardを上へ"]').click()
  await page.locator('.preferred-components select').selectOption({ label: 'Star' })
  await page.locator('.preferred-components select').selectOption({ label: 'Icon' })
  nodes = await nodesOf()
  properties = nodes.find((n) => n.id === card.id).component.properties
  check('並べ替えると、元のプロパティの順が変わる', properties.map((p) => p.name).join() === 'BtnInCard,Label', properties.map((p) => p.name).join())
  check('差し替えのプロパティに候補が入る', JSON.stringify(properties[0].preferred) === JSON.stringify([star.component.id, icon.component.id]),
    JSON.stringify(properties[0].preferred))
  check('候補が一覧に出る', (await page.locator('.preferred-components li').count()) === 2)
  await page.locator('[aria-label="候補 Iconを上へ"]').click()
  nodes = await nodesOf()
  check('候補を並べ替えられる', JSON.stringify(nodes.find((n) => n.id === card.id).component.properties[0].preferred) ===
    JSON.stringify([icon.component.id, star.component.id]))
  await page.locator('.properties-panel').screenshot({ path: path.join(OUT, '52-component-preferred.png') })

  // ── インスタンス: 候補が先頭に出て、入れ子の中のラベルを変えられる ──
  await button('インスタンスを作る').click()
  const groups = await page.locator('[aria-label="プロパティ BtnInCard"] optgroup').evaluateAll((all) =>
    all.map((group) => `${group.label}:${[...group.querySelectorAll('option')].map((o) => o.textContent).join('/')}`))
  check('インスタンスの差し替えの欄は、候補が先頭のまとまりになる', groups[0] === '候補:Icon/Star' && groups[1]?.startsWith('そのほか:'), groups.join(' | '))
  const fieldNames = await page.locator('.properties-panel section:has(h3:text-is("コンポーネント")) .field-label').allTextContents()
  check('インスタンスの欄も並べ替えた順', fieldNames.indexOf('BtnInCard') < fieldNames.indexOf('Label'), fieldNames.join())
  await set('Label', '送信')
  nodes = await nodesOf()
  const instance = nodes.find((n) => n.component && n.component.role === 'instance' && n.component.id === card.component.id)
  const overrides = instance.component.overrides
  check('入れ子の中のラベルへの上書きになる', overrides[labelCopy.id]?.text === '送信' && Object.keys(overrides).length === 1, JSON.stringify(overrides))
  const innerButton = nodes.find((n) => n.parentId === instance.id)
  const innerLabel = nodes.find((n) => n.parentId === innerButton.id && n.type === 'text')
  check('インスタンスの中のボタンの文言が変わる', innerLabel.text === '送信', innerLabel.text)
  await page.screenshot({ path: path.join(OUT, '53-nested-property.png') })

  // ── キャンバス: バリアントをまとまりの外（Box の中）へドラッグすると、プロパティの形でない名前になる ──
  // 入れたインスタンスを消して、読み込んだときと同じ全体の大きさに戻してから、全体を表示し直す
  await page.keyboard.press('Delete')
  await page.keyboard.press('Shift+1')
  await page.waitForTimeout(300)
  nodes = await nodesOf()
  const roots = nodes.filter((n) => n.parentId === null)
  const minX = Math.min(...roots.map((n) => n.x)); const maxX = Math.max(...roots.map((n) => n.x + n.width))
  const minY = Math.min(...roots.map((n) => n.y)); const maxY = Math.max(...roots.map((n) => n.y + n.height))
  const box = await page.locator('.canvas-view').boundingBox()
  const at = (x, y) => [box.x + box.width / 2 + x - (minX + maxX) / 2, box.y + box.height / 2 + y - (minY + maxY) / 2]
  const chipSet = nodes.find((n) => n.name === 'Chip' && !n.component)
  const variant = nodes.find((n) => n.parentId === chipSet.id && n.name === '種類=2')
  const target = nodes.find((n) => n.name === 'Box')
  await expand(row('Chip'))
  await row('種類=2').click()
  const from = at(chipSet.x + variant.x + variant.width / 2, chipSet.y + variant.y + variant.height / 2)
  const to = at(target.x + target.width / 2, target.y + target.height / 2)
  await page.mouse.move(...from); await page.mouse.down()
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 })
  await page.mouse.move(...to, { steps: 4 })
  await page.mouse.up()
  nodes = await nodesOf()
  const movedVariant = nodes.find((n) => n.id === variant.id)
  check('まとまりの外へ出したバリアントは、まとまりの名前と値の名前になる', movedVariant.parentId === target.id && movedVariant.name === 'Chip（2）',
    JSON.stringify([movedVariant.parentId === target.id, movedVariant.name]))
  check('入れた先のフレームはまとまりにならない', (await page.locator('.properties-panel h3:text-is("バリアント")').count()) === 0)
  await row('Box').click()
  check('入れた先のフレームを選んでもバリアントの節は出ない', (await page.locator('.properties-panel h3:text-is("バリアント")').count()) === 0)
  await page.screenshot({ path: path.join(OUT, '54-variant-dragged-out.png') })
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(200)
  nodes = await nodesOf()
  check('Undo でまとまりと名前が戻る', nodes.find((n) => n.id === variant.id).name === '種類=2' && nodes.find((n) => n.id === variant.id).parentId === chipSet.id)

  // ── viewer: 差し替えの候補が分かる ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'component-rest-2.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  const written = JSON.stringify(json.raw)
  check('kdr に候補が入る', json.version === 16 && written.includes('"preferred"'))
  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(300)
  await viewer.evaluate(([pageId, id]) => { location.hash = `page=${pageId}&select=${id}` }, [json.document.pages[0].id, card.id])
  await viewer.waitForTimeout(200)
  const rows = await viewer.locator('.inspect-panel section[aria-label="プロパティ"] .inspect-row').evaluateAll((all) =>
    all.map((r) => `${r.querySelector('dt').textContent}=${r.querySelector('.inspect-value').textContent}`))
  check('viewer で差し替えの候補と、入れ子の中に結んだプロパティが分かる',
    rows.join() === 'BtnInCard=インスタンスの差し替え（1 か所）・候補: Icon / Star,Label=文言（1 か所）', rows.join())
  await viewer.screenshot({ path: path.join(OUT, '55-viewer-preferred.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
