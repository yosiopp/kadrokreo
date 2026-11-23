const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

// 小さな残り: まとまりの説明文、揃っていないバリアントのプロパティを揃える操作、テキストの内側の影、影の描画モード、
// SVG の書き出しのオプション（id・背景）と、範囲に影のはみ出しを含めること
const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument } = require('./harness.cjs')

// CLI で、名前をバリアントの形にする前にプロパティを足して、揃っていないまとまり（Set）を作る。テキスト（Title）と影のあるカード（Card）も
const sourcePath = path.join(OUT, 'small-rest-source.kdr')
const cli = (...args) => execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'), ...args], { encoding: 'utf8' })
cli(
  ...('new Demo + add frame --name Set --width 220 --height 60 + add frame --parent Set --name A --width 80 --height 40 fill=#5b4cf5' +
    ' + add text --parent A --name Label --id la --text OK + component A + add frame --parent Set --name B --x 100 --width 80 --height 40 fill=#ff8800' +
    ' + add text --parent B --name Label --text OK + component B + prop-add A text la --name 文言 + set A').split(' '),
  'name=種類=標準',
  ...'+ set B'.split(' '),
  'name=種類=大',
  ...('+ add text --name Title --y 100 --text Hello fontSize=48 fill=#ffcc00' +
    ' + add rect --name Card --x 260 --y 100 --width 100 --height 60 fill=#ffffff shadow.blur=8 shadow.y=4').split(' '),
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
  const field = (label) => page.locator(`.properties-panel .field:has(.field-label:text-is("${label}")) input`).first()
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const button = (label) => page.locator(`.properties-panel button:text-is("${label}")`)
  const row = (name) => page.locator(`.layer-row[data-copy="false"]:has(.layer-name:text-is("${name}"))`).first()
  const saved = () => savedDocument(page)
  const nodesOf = async () => { await page.waitForTimeout(700); return Object.values((await saved()).pages[0].nodes) }
  const named = (nodes, name) => nodes.find((n) => n.name === name)
  // キャンバス全体の色の合計（描画が変わったかを見る）
  const canvasSum = () => page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2]
    return sum
  })

  // ── まとまり: プロパティを揃える・説明文 ──
  await row('Set').click()
  check('揃っていなければ「プロパティを揃える」が出る', (await button('プロパティを揃える').count()) === 1)
  await button('プロパティを揃える').click()
  let nodes = await nodesOf()
  const b = named(nodes, '種類=大')
  const bLabel = nodes.find((n) => n.parentId === b.id && n.name === 'Label')
  check('揃えると、もう一方のバリアントにも同じ名前のレイヤーに結んだプロパティが入る',
    JSON.stringify(b.component.properties) === JSON.stringify([{ name: '文言', type: 'text', targets: [bLabel.id], preferred: [] }]), JSON.stringify(b.component.properties))
  check('揃ったらボタンは消える', (await button('プロパティを揃える').count()) === 0)
  const description = page.locator('[aria-label="まとまりの説明"]')
  await description.fill('大きさを選ぶボタン')
  await description.blur()
  nodes = await nodesOf()
  check('まとまりに説明文を付けられる', named(nodes, 'Set').setDescription === '大きさを選ぶボタン', named(nodes, 'Set').setDescription)
  await page.locator('.properties-panel').screenshot({ path: path.join(OUT, '58-variant-set-description.png') })

  // ── テキストの内側の影と、影の描画モード ──
  await row('Title').click()
  await page.locator('label:has-text("影を付ける") input').check()
  const typeSelect = page.locator('.field:has(.field-label:text-is("影の種類")) select')
  const before = await canvasSum()
  await typeSelect.selectOption('inner-shadow')
  await set('縦', 4)
  await set('ぼかし', 0)
  await set('濃さ', 100)
  await page.locator('.field:has(.field-label:text-is("影の描画モード")) select').selectOption('multiply')
  nodes = await nodesOf()
  const title = named(nodes, 'Title')
  check('テキストに内側の影を付け、描画モードを選べる',
    title.effects.length === 1 && title.effects[0].type === 'inner-shadow' && title.effects[0].blendMode === 'multiply', JSON.stringify(title.effects))
  const after = await canvasSum()
  check('テキストの内側の影が描かれる（文字の中が暗くなる）', after < before, `${before} → ${after}`)
  await page.screenshot({ path: path.join(OUT, '59-text-inner-shadow.png') })

  // ── SVG の書き出しのオプション ──
  await row('Card').click()
  await page.locator('.properties-panel label:has-text("SVG に id") input').uncheck()
  await page.locator('.properties-panel label:has-text("背景") input').check()
  await page.locator('[aria-label="書き出しの背景の色"]').evaluate((input) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '#eeeeee')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const [svgDownload] = await Promise.all([page.waitForEvent('download'), button('SVG に').click()])
  const svg = fs.readFileSync(await svgDownload.path(), 'utf8')
  const card = named(nodes, 'Card')
  const viewBox = svg.match(/viewBox="([^"]+)"/)[1].split(' ').map(Number)
  check('id を付けないと id 属性がない', !/ id="Card"/.test(svg), svg.slice(0, 300))
  check('背景を敷く', svg.includes('fill="#eeeeee"'), svg.slice(0, 300))
  check('範囲に影のはみ出しが入る', viewBox[0] < card.x && viewBox[3] > card.height, viewBox.join(' '))
  // オプションは覚えておく（次に開いても同じ）
  await page.reload()
  await page.waitForSelector('.canvas-view canvas')
  await row('Card').click()
  check('オプションをブラウザに覚える', !(await page.locator('.properties-panel label:has-text("SVG に id") input').isChecked()))
  await page.locator('.properties-panel label:has-text("SVG に id") input').check()
  await page.locator('.properties-panel label:has-text("背景") input').uncheck()

  // ── viewer にまとまりの説明が出る ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'small-rest.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  const raw = JSON.stringify(json.raw)
  check('kdr にまとまりの説明文と影の描画モードが入る', raw.includes('"setDescription":"大きさを選ぶボタン"') && raw.includes('"blendMode":"multiply"'), raw.slice(0, 300))
  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Set"))').click()
  const inspect = await viewer.locator('.inspect-panel').textContent()
  check('viewer のインスペクトにまとまりの説明が出る', inspect.includes('大きさを選ぶボタン'), inspect.slice(0, 300))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
