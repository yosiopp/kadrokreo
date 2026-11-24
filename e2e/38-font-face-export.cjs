const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { testFontBytes } = require('../src/document/testFont.ts')

// kdr に埋め込んだ書体を、viewer の SVG の書き出しと HTML ファイルの保存に @font-face で入れる。
// 書き出したファイルを、書体を登録していない別のページで開いても同じ書体で表示されることを確かめる。
// テスト用の書体は、どの字も送り幅 0.6em・高さ 0.7em の黒い四角（src/document/testFont.ts）。OS の書体の字より、黒い画素がずっと多い
const { OUT, VIEWER, check, finish, crashed, watchErrors } = require('./harness.cjs')

const fontPath = path.join(OUT, 'font-face-test.ttf')
fs.writeFileSync(fontPath, testFontBytes({ family: 'Kdr Test' }))
const sourcePath = path.join(OUT, 'font-face-export.kdr')
// 塗りのないフレーム Card（テキストと同じ 96×48）の中に、埋め込んだ書体の黒いテキスト「ABCD」（40px）
execFileSync('node', [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'),
  'new', 'FontFace', '+', 'font-add', fontPath,
  '+', 'add', 'frame', '--name', 'Card', '--width', '96', '--height', '48', 'fills=[]',
  '+', 'add', 'text', '--parent', 'Card', '--name', 'Label', '--text', 'ABCD', 'fontFamily=Kdr Test', 'fontSize=40', 'fill=#000000',
  '-o', sourcePath,
], { encoding: 'utf8' })

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
    return dark / (data.length / 4)
  }, { base64, mime })
}

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const errors = []
  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(sourcePath)
  await viewer.waitForSelector('.inspect-layer:has(.layer-name:text-is("Card"))')
  // 書体を登録していないページ（書き出したファイルを、その書体のない環境で開くのに当たる）
  const blank = await context.newPage()
  watchErrors(blank, errors, 'blank: ')

  // ── SVG に書き出す（書体を入れる・入れない） ──
  const saveSvg = async (name) => {
    const [download] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('button:text-is("SVG に")').first().click()])
    const svgPath = path.join(OUT, name)
    await download.saveAs(svgPath)
    return fs.readFileSync(svgPath, 'utf8')
  }
  const option = viewer.locator('label:has-text("SVG に書体") input[type=checkbox]').first()
  check('書き出し欄に「SVG に書体」があり、既定で入れる', await option.isChecked())
  const svg = await saveSvg('font-face-export.svg')
  const fontBase64 = fs.readFileSync(fontPath).toString('base64')
  check('SVG に書体ファイルそのままの @font-face が入る', svg.includes(`src: url("data:font/ttf;base64,${fontBase64}") format("truetype");`) && svg.includes('font-family: "Kdr Test";'), svg.slice(0, 300))
  const svgInk = await inkOf(blank, Buffer.from(svg).toString('base64'), 'image/svg+xml')
  await option.uncheck()
  const plain = await saveSvg('font-face-export-plain.svg')
  const plainInk = await inkOf(blank, Buffer.from(plain).toString('base64'), 'image/svg+xml')
  await option.check()
  check('「SVG に書体」を外すと @font-face を入れない', !plain.includes('@font-face'))
  check('書体のないページで開いても、SVG は埋め込んだ書体で表示される（入れないと別の書体になる）',
    svgInk > 0.4 && plainInk < 0.35, `${svgInk.toFixed(2)} / 入れない ${plainInk.toFixed(2)}`)

  // ── HTML・CSS の出力と書体ファイルの保存 ──
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Card"))').click()
  const panel = viewer.locator('.inspect-panel')
  const htmlSection = panel.locator('section[aria-label="HTML"]')
  const css = await htmlSection.locator('.inspect-code').nth(1).textContent()
  check('コピー用の CSS の先頭に、書体ファイルの名前を指す @font-face が出る',
    css.startsWith('@font-face {\n  font-family: "Kdr Test";\n  src: url("Kdr-Test-400.ttf") format("truetype");\n  font-weight: 400;\n  font-style: normal;\n}'), JSON.stringify(css.slice(0, 160)))
  const [fontFile] = await Promise.all([viewer.waitForEvent('download'), panel.locator('button:text-is("書体ファイルを保存（Kdr Test 400）")').click()])
  const savedFont = path.join(OUT, 'font-face-saved.ttf')
  await fontFile.saveAs(savedFont)
  check('書体ファイルを、@font-face が指す名前で元のまま保存できる',
    fontFile.suggestedFilename() === 'Kdr-Test-400.ttf' && fs.readFileSync(savedFont).equals(fs.readFileSync(fontPath)), fontFile.suggestedFilename())

  const [htmlFile] = await Promise.all([viewer.waitForEvent('download'), htmlSection.locator('button:text-is("HTML ファイルを保存")').click()])
  const htmlPath = path.join(OUT, 'font-face-export.html')
  await htmlFile.saveAs(htmlPath)
  check('保存する HTML には書体を data URI で埋め込む', fs.readFileSync(htmlPath, 'utf8').includes(`data:font/ttf;base64,${fontBase64}`))
  const opened = await context.newPage()
  watchErrors(opened, errors, 'html: ')
  await opened.goto('file://' + htmlPath)
  await opened.evaluate(() => document.fonts.ready)
  const shot = await opened.locator('.card').screenshot()
  const htmlInk = await inkOf(blank, shot.toString('base64'), 'image/png')
  await opened.screenshot({ path: path.join(OUT, '38-font-face-html.png') })
  check('保存した HTML を開くと、埋め込んだ書体で表示される', htmlInk > 0.4, htmlInk.toFixed(2))

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
