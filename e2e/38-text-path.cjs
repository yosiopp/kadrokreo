// テキストをパスに沿わせる（SVG の textPath）。取り込んだ <textPath> が線に沿って描かれ、書き出した SVG をブラウザで開くと
// 同じ位置に文字が並ぶこと（描画とブラウザの textPath が同じ置き方であること）、右クリックメニューで既存のテキストを沿わせられることを確かめる
const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument } = require('./harness.cjs')

const SOURCE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">' +
  '<rect id="marker" width="10" height="10" fill="#0000ff"/>' +
  '<path id="guide" d="M20 150 Q150 0 280 150" fill="none" stroke="#00cc00"/>' +
  '<text font-family="sans-serif" font-size="24" fill="#ff0000" text-anchor="middle"><textPath href="#guide" startOffset="50%">Along the curve</textPath></text>' +
  '</svg>'

/**
 * 絵（ImageData の中身）の、赤い文字の画素と青い目印の画素を囲む矩形と、赤い画素の数（ratio で CSS ピクセルに直す）。
 * 位置は青い目印の左上からのずれで返す（キャンバスと SVG の絵の置き場所が違っても比べられるように）
 */
function inkOf(data, width, height, ratio) {
  const box = () => ({ left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, count: 0 })
  const red = box()
  const blue = box()
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
      if (a < 128) continue
      const target = r > 180 && g < 110 && b < 110 ? red : r < 40 && g < 40 && b > 200 ? blue : null
      if (!target) continue
      target.left = Math.min(target.left, x)
      target.top = Math.min(target.top, y)
      target.right = Math.max(target.right, x + 1)
      target.bottom = Math.max(target.bottom, y + 1)
      target.count++
    }
  }
  const s = (value) => Math.round((value / ratio) * 10) / 10
  return {
    left: s(red.left - blue.left),
    top: s(red.top - blue.top),
    right: s(red.right - blue.left),
    bottom: s(red.bottom - blue.top),
    count: Math.round(red.count / ratio / ratio),
  }
}

/** 2 つの範囲がほぼ同じか（各辺 tolerance px 以内、画素の数は 15% 以内） */
function sameInk(a, b, tolerance = 2) {
  return ['left', 'top', 'right', 'bottom'].every((key) => Math.abs(a[key] - b[key]) <= tolerance) && Math.abs(a.count - b.count) <= b.count * 0.15
}

/** 画面のキャンバスの絵の文字の範囲 */
async function canvasInk(page) {
  const { data, width, height, ratio } = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const image = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
    return { data: Array.from(image.data), width: canvas.width, height: canvas.height, ratio: canvas.width / canvas.clientWidth }
  })
  return inkOf(data, width, height, ratio)
}

/** SVG をブラウザで描いた絵の文字の範囲（2 倍で描いて CSS ピクセルに直す） */
async function svgInk(page, text) {
  const { data, width, height } = await page.evaluate(async (svg) => {
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth * 2
    canvas.height = img.naturalHeight * 2
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    URL.revokeObjectURL(url)
    return { data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data), width: canvas.width, height: canvas.height }
  }, text)
  return inkOf(data, width, height, 2)
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const saved = async () => { await page.waitForTimeout(600); return (await savedDocument(page)).pages[0] }
  const row = (name) => page.locator(`.layer-row:has(.layer-name:text-is("${name}"))`).first()
  const item = (name) => page.locator(`.context-menu-item:has(.context-menu-label:text-is("${name}"))`).first()

  // ── 取り込み: <textPath> が線に沿うテキストになる ──
  await page.evaluate((svg) => {
    const transfer = new DataTransfer()
    transfer.setData('text/plain', svg)
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
  }, SOURCE)
  await page.waitForTimeout(600)
  let nodes = (await saved()).nodes
  const text = Object.values(nodes).find((node) => node.type === 'text')
  check('取り込んだ <textPath> が線に沿うテキストになる（始まり 50%・中央揃え）',
    text?.textPath?.startOffset === 0.5 && text.textAlign === 'center' && text.textPath.points.length === 2 && text.text === 'Along the curve',
    JSON.stringify(text && { textPath: text.textPath, textAlign: text.textAlign }))

  // ── 書き出した SVG をブラウザで開くと、キャンバスと同じ位置に文字が並ぶ ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("SVG に")').click()])
  const svgPath = path.join(OUT, 'text-path.svg')
  await download.saveAs(svgPath)
  const exported = fs.readFileSync(svgPath, 'utf8')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const drawn = await canvasInk(page)
  const fromSvg = await svgInk(page, exported)
  const original = await svgInk(page, SOURCE)
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, '38-text-path.png') })
  check('書き出した SVG は textPath で書く', exported.includes('<textPath href="#kdr-text-path-') && exported.includes('startOffset="50%"'))
  check('キャンバスの文字は、書き出した SVG をブラウザで描いた文字と同じ範囲に並ぶ', drawn.count > 300 && sameInk(drawn, fromSvg),
    `canvas ${JSON.stringify(drawn)} / svg ${JSON.stringify(fromSvg)}`)
  check('取り込む前の SVG をブラウザで描いた文字とも同じ範囲', sameInk(drawn, original), `canvas ${JSON.stringify(drawn)} / 元 ${JSON.stringify(original)}`)

  // ── プロパティパネルで始まりの位置を変え、パスから外す ──
  await row(text.name).click()
  const offset = page.locator('.field:has(.field-label:text-is("パスの始まり（%）")) input').first()
  check('線に沿うテキストを選ぶと、パスの始まりの欄が出る（行の高さ・折り返しは出ない）',
    (await offset.inputValue()) === '50' && (await page.locator('.field-label:text-is("行の高さ")').count()) === 0)
  await offset.fill('20')
  await offset.press('Enter')
  nodes = (await saved()).nodes
  check('始まりの位置を % で変えられる', nodes[text.id].textPath?.startOffset === 0.2, JSON.stringify(nodes[text.id].textPath?.startOffset))
  const moved = await canvasInk(page)
  check('始まりを前にずらすと、文字が左へ動く', moved.left < drawn.left - 20, `${drawn.left} → ${moved.left}`)
  await page.locator('button:text-is("パスから外す")').click()
  nodes = (await saved()).nodes
  check('パスから外すと、ふつうのテキストに戻る', nodes[text.id].textPath === null && nodes[text.id].sizing.width === 'hug')

  // ── 右クリックメニュー: テキストと図形を選んで「テキストをパスに沿わせる」 ──
  await row(text.name).click()
  await row('guide').click({ modifiers: ['Meta'] })
  await row('guide').click({ button: 'right' })
  check('テキストと図形を選ぶと「テキストをパスに沿わせる」が押せる', !(await item('テキストをパスに沿わせる').isDisabled()))
  await item('テキストをパスに沿わせる').click()
  nodes = (await saved()).nodes
  const guide = Object.values(nodes).find((node) => node.name === 'guide')
  check('右クリックメニューで既存のテキストを図形の線に沿わせる（図形は残る）',
    nodes[text.id].textPath !== null && nodes[text.id].textPath.startOffset === 0 && guide?.type === 'path',
    JSON.stringify(nodes[text.id].textPath))
  await page.keyboard.press('Meta+z')
  nodes = (await saved()).nodes
  check('Undo で沿わせる前に戻る', nodes[text.id].textPath === null)
  await page.keyboard.press('Meta+Shift+z')

  // ── viewer でも同じ位置に描き、インスペクトに沿う線を出す ──
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  const inEditor = await canvasInk(page)
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, '38-text-path-attached.png') })
  const [kdr] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'text-path.kdr')
  await kdr.saveAs(kdrPath)
  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(500)
  const zoom = await viewer.evaluate(() => {
    const label = [...document.querySelectorAll('button, span')].map((e) => e.textContent).find((t) => /^\d+%$/.test(t?.trim() ?? ''))
    return label ? parseInt(label) / 100 : 1
  })
  const inViewer = await canvasInk(viewer)
  const scaled = Object.fromEntries(Object.entries(inViewer).map(([key, value]) => [key, key === 'count' ? value / zoom / zoom : value / zoom]))
  check('viewer でも editor と同じ形に文字が並ぶ', sameInk(scaled, inEditor, 3), `viewer ${JSON.stringify(scaled)}（${zoom * 100}%）/ editor ${JSON.stringify(inEditor)}`)
  await viewer.locator(`.layer-row:has(.layer-name:text-is("${text.name}"))`).first().click()
  check('viewer のインスペクトに「パスに沿う」が出る', (await viewer.locator('text=パスに沿う').count()) > 0)
  await viewer.screenshot({ path: path.join(OUT, '38-text-path-viewer.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
