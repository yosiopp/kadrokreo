const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const zlib = require('zlib')
const { execFileSync } = require('child_process')
const { parseKdrBytes } = require('./kdr.cjs')
const { testFontBytes, toWoff2 } = require('../src/document/testFont.ts')

// WOFF2 の書体ファイル: editor で取り込み（書体名・太さはファイルから読む）、アウトライン化し、kdr・viewer・PNG・SVG でも同じ書体で描かれる。
// viewer では WOFF2 を戻す処理を遅れて読み込むので、テキストを入れたブーリアン演算の結果が、読み込んだあとに文字の形で描かれることも見る。
// テスト用の書体は、どの字も送り幅 0.6em・高さ 0.7em の黒い四角（src/document/testFont.ts）。glyf / loca / hmtx を変換した WOFF2 にする
const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument, blankPage } = require('./harness.cjs')

const fontPath = path.join(OUT, 'kdr-test.woff2')
fs.writeFileSync(fontPath, toWoff2(testFontBytes({ family: 'Kdr Woff2', weight: 300 }), (data) => zlib.brotliCompressSync(data)))
// テキストを差し引いた黒い板（200×60。テキスト ABCD 40px の四角の分だけ穴が開く）
const booleanPath = path.join(OUT, 'woff2-boolean.kdr')
execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'),
  'new', 'Woff2', '+', 'font-add', fontPath,
  '+', 'add', 'rect', '--name', 'Box', '--width', '200', '--height', '60', 'fill=#000000',
  '+', 'add', 'text', '--name', 'Label', '--x', '20', '--y', '6', '--text', 'ABCD', 'fontFamily=Kdr Woff2', 'fontWeight=300', 'fontSize=40', 'fill=#000000',
  '+', 'boolean', 'subtract', 'Box', 'Label', '--keep',
  '-o', booleanPath,
], { encoding: 'utf8' })

function inkOnCanvas(page) {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let dark = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] < 80 && data[i + 1] < 80 && data[i + 2] < 80 && data[i + 3] > 200) dark++
    return dark / ratio / ratio
  })
}

/** 画像（PNG・SVG）のバイト列を、page で描いて黒い画素の割合を数える */
function inkOf(page, base64, mime) {
  return page.evaluate(async ({ base64, mime }) => {
    const image = new Image()
    image.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: mime }))
    await image.decode()
    const ctx = new OffscreenCanvas(image.naturalWidth, image.naturalHeight).getContext('2d')
    ctx.drawImage(image, 0, 0)
    const data = ctx.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data
    let dark = 0
    for (let i = 0; i < data.length; i += 4) if (data[i] < 80 && data[i + 3] > 200) dark++
    return { width: image.naturalWidth, height: image.naturalHeight, ink: dark / (data.length / 4) }
  }, { base64, mime })
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const canvasBox = await page.locator('.canvas-view canvas').boundingBox()
  const saved = async () => { await page.waitForTimeout(700); return savedDocument(page) }
  const textNode = async () => Object.values((await saved()).pages[0].nodes).find((node) => node.type === 'text')

  // ── テキストを作り、WOFF2 の書体ファイルを取り込んで使う ──
  await page.keyboard.press('t')
  await page.mouse.click(canvasBox.x + 200, canvasBox.y + 200)
  await page.keyboard.type('ABCD')
  await page.keyboard.press('Escape')
  const size = page.locator('.field:has(.field-label:text-is("サイズ")) input').first()
  await size.fill('40')
  await size.press('Enter')
  const input = page.locator('.properties-panel input[type=file][accept*=".woff2"]')
  check('書体ファイルを選ぶ画面で WOFF2 を選べる', (await input.count()) === 1)
  await input.setInputFiles(fontPath)
  await page.waitForTimeout(400)
  const doc = await saved()
  const text = await textNode()
  check('WOFF2 を取り込むと、書体名・太さ・斜体をファイルから読んで kdr に入る',
    doc.fonts.length === 1 && doc.fonts[0].family === 'Kdr Woff2' && doc.fonts[0].weight === 300 && doc.fonts[0].style === 'normal', JSON.stringify(doc.fonts))
  check('テキストの幅は WOFF2 の書体で測る', text.fontFamily === 'Kdr Woff2' && Math.abs(text.width - 96) < 1, `${text.fontFamily} ${text.width}`)
  const ink = (await inkOnCanvas(page)) / (text.width * text.height)
  check('WOFF2 の書体で描かれる（字の四角で黒い画素が多い）', ink > 0.4, ink.toFixed(2))
  await page.screenshot({ path: path.join(OUT, '39-woff2-font.png') })

  // ── アウトライン化（⇧⌘O）: WOFF2 の書体から字の形を読む ──
  await page.mouse.click(canvasBox.x + 230, canvasBox.y + 220)
  await page.keyboard.press('Shift+Meta+KeyO')
  const outlined = (await saved()).pages[0].nodes[text.id]
  check('WOFF2 の書体のテキストもアウトライン化できる（TTF の書体と同じ形。37-text-outline）', outlined?.type === 'path' && outlined.fillRule === 'nonzero' && outlined.contours.length === 3,
    JSON.stringify(outlined && { type: outlined.type, contours: outlined.contours?.length }))
  await page.keyboard.press('Meta+z')

  // ── kdr に書き出す ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'woff2-font.kdr')
  await download.saveAs(kdrPath)
  const kdr = await parseKdrBytes(fs.readFileSync(kdrPath))
  const fontId = kdr.raw.document.fonts?.[0]?.assetId
  check('kdr に WOFF2 のファイルがそのまま（assets/<sha256>.woff2）入る',
    kdr.names.includes(fontId) && kdr.document.assets[fontId].mime === 'font/woff2' &&
      Buffer.from(kdr.document.assets[fontId].bytes).equals(fs.readFileSync(fontPath)),
    JSON.stringify(kdr.names))

  // ── viewer: 開いて描き、PNG・SVG に書き出す ──
  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(500)
  const [pngDownload] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("ページを PNG に")').click()])
  // 画像を <img> に入れて描かせるのは、何も読み込んでいないページで（アプリのページは CSP が blob: の画像を止める）
  const blank = await blankPage(context, errors)
  const png = await inkOf(blank, (await fs.promises.readFile(await pngDownload.path())).toString('base64'), 'image/png')
  check('viewer の PNG の書き出しも WOFF2 の書体で描く', png.width === 96 && png.ink > 0.4, JSON.stringify(png))
  const [svgDownload] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("SVG に")').first().click()])
  const svg = await fs.promises.readFile(await svgDownload.path(), 'utf8')
  const svgInk = await inkOf(blank, Buffer.from(svg).toString('base64'), 'image/svg+xml')
  check('SVG に WOFF2 のまま @font-face が入り、書体のないページでも WOFF2 の書体で表示される',
    svg.includes(`src: url("data:font/woff2;base64,${fs.readFileSync(fontPath).toString('base64')}") format("woff2");`) && svgInk.ink > 0.4,
    `${svgInk.ink.toFixed(2)} ${svg.slice(0, 200)}`)

  // ── viewer: テキストを差し引いたブーリアン演算（字の形は WOFF2 を戻す処理を読み込んでから） ──
  const booleanViewer = await context.newPage()
  watchErrors(booleanViewer, errors, 'boolean: ')
  await booleanViewer.goto(VIEWER)
  await booleanViewer.locator('input[type=file]').setInputFiles(booleanPath)
  await booleanViewer.waitForSelector('.canvas-view canvas')
  const [booleanPng] = await Promise.all([booleanViewer.waitForEvent('download'), booleanViewer.locator('button:text-is("ページを PNG に")').click()])
  const holes = await inkOf(blank, (await fs.promises.readFile(await booleanPng.path())).toString('base64'), 'image/png')
  // 穴なら 4 × 24 × 28 の分だけ黒が減る（12,000 のうち 2,688）
  check('viewer で、WOFF2 の書体のテキストを差し引いたブーリアン演算が文字の形の穴になる', holes.width === 200 && holes.ink > 0.7 && holes.ink < 0.85, JSON.stringify(holes))
  await booleanViewer.screenshot({ path: path.join(OUT, '39-woff2-boolean-viewer.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
