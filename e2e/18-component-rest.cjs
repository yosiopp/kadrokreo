const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// コンポーネントの残り: 入れ子の中の入れ子の差し替え、説明文とプロパティ、バリアントのプロパティと値の並べ替え・値の編集、
// 一覧のページごとの見出しとサムネイル
const OUT = path.join(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })
const EDITOR = process.env.EDITOR_URL || 'http://localhost:5180'
const VIEWER = process.env.VIEWER_URL || 'http://localhost:5181'
let failures = 0
const check = (name, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

// CLI で、ボタン ⊂ カード ⊂ パネル の元とパネルのインスタンス、アイコン、バリアントのまとまり（Chip）、2 ページ目の元を作る
const sourcePath = path.join(OUT, 'component-rest-source.kdr')
const cli = (...args) => execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'), ...args], { encoding: 'utf8' })
cli(...(
  'new Demo + add frame --name Btn --width 80 --height 30 fill=#5b4cf5 + add text --parent Btn --name Label --text OK' +
  ' + add rect --parent Btn --name Mark --x 60 --y 4 --width 8 --height 8 + component Btn' +
  ' + add frame --name Icon --x 0 --y 200 --width 24 --height 24 fill=#ff8800 + component Icon' +
  ' + add frame --name Card --x 200 --width 200 --height 100 + component Card + instance Btn --parent Card --name BtnInCard' +
  ' + add frame --name Panel --x 500 --width 300 --height 200 + component Panel + instance Card --parent Panel --name CardInPanel' +
  ' + instance Panel --name Outer --x 0 --y 400 + add frame --name Chip --x 200 --y 200 --width 60 --height 24 + component Chip + variant-add Chip' +
  ' + page-add Second + add frame --name Badge --width 40 --height 20 fill=#00aa55 + component Badge'
).split(' '), '-o', sourcePath)

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  await page.locator('input[type=file][accept^=".kdr"]').setInputFiles(sourcePath)
  await page.waitForTimeout(500)
  const field = (label) => page.locator(`.properties-panel .field:has(.field-label:text-is("${label}")) input`).first()
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const button = (label) => page.locator(`.properties-panel button:text-is("${label}")`)
  const row = (name) => page.locator(`.layer-row[data-copy="false"]:has(.layer-name:text-is("${name}"))`).first()
  const copyRow = (name) => page.locator(`.layer-row[data-copy="true"]:has(.layer-name:text-is("${name}"))`).first()
  const saved = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('kadrokreo')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = open.result.transaction('document').objectStore('document').get('current')
      request.onsuccess = () => resolve(request.result.document)
    }
  }))
  const nodesOf = async () => { await page.waitForTimeout(700); return Object.values((await saved()).pages[0].nodes) }
  const named = (nodes, name) => nodes.find((n) => n.name === name && !(n.component && n.component.role === 'instance' && n.parentId === null && name !== 'Outer'))

  // ── 一覧: ページごとの見出しとサムネイル ──
  const headings = await page.locator('.component-heading').allTextContents()
  check('一覧にページごとの見出しが出る', headings.length === 2 && headings[1] === 'Second', headings.join())
  const thumbnails = page.locator('.component-row .node-thumbnail')
  check('一覧の行にサムネイルが出る', (await thumbnails.count()) === 6, String(await thumbnails.count()))
  const painted = await thumbnails.first().evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
    return false
  })
  check('サムネイルに元の見た目が描かれる', painted)
  await page.locator('.components').screenshot({ path: path.join(OUT, '47-component-list.png') })
  await page.locator('[aria-label="コンポーネントの並べ方"]').selectOption('name')
  check('名前順では見出しを出さない', (await page.locator('.component-heading').count()) === 0)
  await page.locator('[aria-label="コンポーネントの並べ方"]').selectOption('document')

  // ── 入れ子の中の入れ子の差し替え: パネルのインスタンスの中の、カードの中のボタンをアイコンに ──
  let nodes = await nodesOf()
  const outer = named(nodes, 'Outer')
  const iconMain = nodes.find((n) => n.name === 'Icon' && n.component && n.component.role === 'main')
  const expand = async (layer) => {
    const caret = layer.locator('.layer-caret[aria-label="開く"]')
    if (await caret.count()) await caret.click()
  }
  await expand(row('Outer'))
  await expand(copyRow('CardInPanel'))
  await copyRow('BtnInCard').click()
  const nestedSelect = page.locator('[aria-label="入れ子のインスタンスの元"]')
  check('入れ子の中の入れ子の写しを選ぶと、元を選べる', (await nestedSelect.count()) === 1)
  await nestedSelect.selectOption({ label: 'Icon' })
  nodes = await nodesOf()
  const overrides = nodes.find((n) => n.id === outer.id).component.overrides
  const [key] = Object.keys(overrides)
  const panelCopy = nodes.find((n) => n.id === key)
  check('上書きのキーは元のパネルの中の写し、値は差し替え先', overrides[key].componentId === iconMain.component.id && panelCopy && panelCopy.component === null,
    JSON.stringify(overrides))
  const outerCard = nodes.find((n) => n.parentId === outer.id)
  const swapped = nodes.find((n) => n.parentId === outerCard.id)
  // 名前は付け替えていた（BtnInCard）ので、そのまま
  check('写しがアイコンの大きさと中身になる', swapped.width === 24 && swapped.children.length === 0, JSON.stringify([swapped.name, swapped.width]))
  check('元のパネルの中は変わらない', panelCopy.name === 'BtnInCard' && panelCopy.width === 80)
  await page.screenshot({ path: path.join(OUT, '48-deep-nested-swap.png') })

  // ── 説明文とプロパティ ──
  await row('Label').click()
  await button('文言をプロパティに').click()
  await row('Mark').click()
  await button('表示をプロパティに').click()
  check('結んだノードには、結んだプロパティが出る', (await page.locator('.properties-panel .property-bound').textContent()).includes('Mark'))
  await row('Btn').click()
  await page.locator('[aria-label="コンポーネントの説明"]').fill('主な操作に使う')
  await page.locator('[aria-label="コンポーネントの説明"]').press('Tab')
  nodes = await nodesOf()
  const btn = nodes.find((n) => n.name === 'Btn' && n.component && n.component.role === 'main')
  const label = nodes.find((n) => n.name === 'Label' && n.parentId === btn.id)
  const mark = nodes.find((n) => n.name === 'Mark' && n.parentId === btn.id)
  check('元に説明文とプロパティが入る', btn.component.description === '主な操作に使う' &&
    JSON.stringify(btn.component.properties) === JSON.stringify([
      { name: 'Label', type: 'text', targets: [label.id] },
      { name: 'Mark', type: 'boolean', targets: [mark.id] },
    ]), JSON.stringify(btn.component))
  check('元のパネルにプロパティの一覧が出る', (await page.locator('.component-properties .variant-property').count()) === 2)

  await button('インスタンスを作る').click()
  check('インスタンスに説明文が出る', (await page.locator('[aria-label="コンポーネントの説明"]').textContent()) === '主な操作に使う')
  await set('Label', '送信')
  await page.locator('.properties-panel .check-field:has-text("Mark") input').uncheck()
  nodes = await nodesOf()
  const instance = nodes.find((n) => n.component && n.component.role === 'instance' && n.component.id === btn.component.id && n.parentId === null)
  check('インスタンスでプロパティを変えると、結んだノードの上書きになる',
    instance.component.overrides[label.id]?.text === '送信' && instance.component.overrides[mark.id]?.visible === false &&
      Object.keys(instance.component.overrides).length === 2,
    JSON.stringify(instance.component.overrides))
  check('変えたプロパティの欄に印が付く', (await page.locator('.properties-panel .field:has(.field-label:text-is("Label")) .override-mark').count()) === 1)
  await page.screenshot({ path: path.join(OUT, '49-component-properties.png') })

  // ── バリアントのプロパティと値 ──
  await row('Chip').click()
  await button('プロパティを追加').click()
  await page.locator('[aria-label="プロパティ プロパティ1を上へ"]').click()
  const variantNames = async () => {
    const all = await nodesOf()
    const chip = all.find((n) => n.name === 'Chip' && !n.component)
    return chip.children.map((id) => all.find((n) => n.id === id).name)
  }
  let names = await variantNames()
  check('プロパティの順を変えると、すべてのバリアントの名前の順が変わる', names.join('|') === 'プロパティ1=標準, 種類=標準|プロパティ1=標準, 種類=2', names.join('|'))
  await page.locator('ul[aria-label="種類 の値"] li').nth(1).locator('input').fill('押下')
  await page.locator('ul[aria-label="種類 の値"] li').nth(1).locator('input').press('Enter')
  await page.locator('[aria-label="値 押下を上へ"]').click()
  names = await variantNames()
  check('値の名前を変え、順を変えるとバリアントが並び替わる', names.join('|') === 'プロパティ1=標準, 種類=押下|プロパティ1=標準, 種類=標準', names.join('|'))
  await page.screenshot({ path: path.join(OUT, '50-variant-values.png') })
  await page.locator('ul[aria-label="種類 の値"] button:text-is("値を追加")').click()
  names = await variantNames()
  check('値を足すと、その値のバリアントが増える', names.length === 3 && names.includes('プロパティ1=標準, 種類=値2'), names.join('|'))

  // ── viewer: 説明文とプロパティ ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'component-rest.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  check('kdr に説明文とプロパティが入る', json.version === 16 && JSON.stringify(json.document.pages[0].nodes[btn.id].component.properties) === JSON.stringify(btn.component.properties))

  const viewer = await context.newPage()
  viewer.on('pageerror', (e) => errors.push('viewer: ' + String(e)))
  viewer.on('console', (m) => m.type() === 'error' && errors.push('viewer: ' + m.text()))
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(300)
  const inspectRows = (section) => viewer.locator(`.inspect-panel section[aria-label="${section}"] .inspect-row`).evaluateAll((rows) => rows.map((r) => `${r.querySelector('dt').textContent}=${r.querySelector('.inspect-value').textContent}`))
  const select = async (id) => {
    await viewer.evaluate(([pageId, id]) => { location.hash = `page=${pageId}&select=${id}` }, [json.document.pages[0].id, id])
    await viewer.waitForTimeout(200)
  }
  await select(btn.id)
  let rows = await inspectRows('プロパティ')
  check('viewer で元のプロパティが分かる', rows.join() === 'Label=文言（1 か所）,Mark=表示の切り替え（1 か所）', rows.join())
  check('viewer で元の説明文が分かる', (await inspectRows('コンポーネント')).includes('説明=主な操作に使う'))
  await select(instance.id)
  rows = await inspectRows('プロパティ')
  check('viewer でインスタンスのプロパティの値が分かる', rows.join() === 'Label（上書き）=送信,Mark（上書き）=非表示', rows.join())
  await viewer.screenshot({ path: path.join(OUT, '51-viewer-component-properties.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`)
  process.exit(failures === 0 ? 0 : 1)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
