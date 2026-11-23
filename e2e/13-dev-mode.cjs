const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')

const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)

  // ── editor で確認用のデザインを作る ──
  // フレーム (100,100) 400×300 の中に、長方形 2 つ（(130,140) 60×60 と (250,140) 80×60）とテキスト
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const editorBox = await page.locator('.canvas-view').boundingBox()
  const drag = async (from, to) => {
    await page.mouse.move(editorBox.x + from[0], editorBox.y + from[1])
    await page.mouse.down()
    await page.mouse.move(editorBox.x + (from[0] + to[0]) / 2, editorBox.y + (from[1] + to[1]) / 2, { steps: 4 })
    await page.mouse.move(editorBox.x + to[0], editorBox.y + to[1], { steps: 4 })
    await page.mouse.up()
  }
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const editorRow = (name) => page.locator(`.layer-row:has(.layer-name:text-is("${name}"))`)
  await page.keyboard.press('f'); await drag([100, 100], [500, 400])
  await page.keyboard.press('r'); await drag([130, 140], [190, 200])
  await page.locator('[aria-label="塗りの色"]').fill('#4f46e5')
  await set('半径', 8)
  await page.keyboard.press('r'); await drag([250, 140], [330, 200])
  await page.keyboard.press('t')
  await page.mouse.click(editorBox.x + 130, editorBox.y + 300)
  await page.keyboard.type('Hello')
  await page.keyboard.press('Escape')
  // ロックしてあっても、viewer では選べる
  await editorRow('Rectangle 2').hover()
  await editorRow('Rectangle 2').locator('[aria-label="ロック"]').click()
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'dev-mode.kdr')
  await download.saveAs(kdrPath)
  // 回した図形の計測を確かめるための 2 ページ目: 30° 回した 2 つと、回していない 1 つ（別の kdr に書き出す）
  await page.locator('[aria-label="ページを追加"]').click()
  await page.keyboard.press('r'); await drag([100, 100], [200, 150]); await set('回転', 30)
  await page.keyboard.press('r'); await drag([300, 100], [400, 150]); await set('回転', 30)
  await page.keyboard.press('r'); await drag([150, 300], [250, 350])
  const [rotatedDownload] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const rotatedPath = path.join(OUT, 'dev-mode-rotated.kdr')
  await rotatedDownload.saveAs(rotatedPath)

  // ── viewer ──
  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  const panel = viewer.locator('.inspect-panel')
  const title = () => panel.locator('.panel-title').textContent()
  const value = (section, label) => panel.locator(`section[aria-label="${section}"] .inspect-row:has(dt:text-is("${label}")) .inspect-value`)
  const tree = () => viewer.locator('.inspect-layer .layer-name').allTextContents()
  const treeSelected = () => viewer.locator('.inspect-layer[data-selected="true"] .layer-name').allTextContents()
  const clipboard = () => viewer.evaluate(() => navigator.clipboard.readText())
  // 全体表示にすると、フレーム（中心は (300,250)）がキャンバスの中央に等倍で来る
  let box
  const fit = async () => { await viewer.locator('button:text-is("全体表示")').click(); box = await viewer.locator('.canvas-view').boundingBox() }
  const at = (x, y) => [box.x + box.width / 2 + x - 300, box.y + box.height / 2 + y - 250]
  const pixel = (x, y) => viewer.evaluate(async ([x, y]) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    return [...canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data]
  }, [x, y])
  const pixelAt = (x, y) => { const [sx, sy] = at(x, y); return pixel(sx - box.x, sy - box.y) }
  const isRed = (p) => p[0] > 200 && p[1] < 120 && p[2] < 100

  // ── 開くと、切り替えなしで使える ──
  await fit()
  check('開くと、インスペクトのパネルとレイヤー一覧が出る', (await title()) === 'インスペクト' && (await tree()).join() === 'Frame 1,Text 1,Rectangle 2,Rectangle 1' && (await viewer.locator('button:text-is("Dev モード")').count()) === 0, (await tree()).join())

  // ── 何も選んでいないときは、ページで使われている色と文字が出る ──
  const rows = (section) => panel.locator(`section[aria-label="${section}"] .inspect-row`).evaluateAll((list) => list.map((r) => `${r.querySelector('dt').textContent}=${r.querySelector('.inspect-value').textContent}`))
  const pageColors = await rows('このページの色')
  const pageTexts = await rows('このページの文字')
  check('ページで使われている色の一覧が出る', pageColors.slice().sort().join() === '1 か所=#000000,1 か所=#4F46E5,1 か所=#D9D9D9,1 か所=#FFFFFF', pageColors.join())
  check('ページで使われている文字の設定が、CSS の font の形で出る', pageTexts.length === 1 && /^1 か所=400 16px\/[\d.]+ .+$/.test(pageTexts[0]), pageTexts.join())
  await panel.locator('section[aria-label="このページの色"] .inspect-value:has-text("#4F46E5")').click()
  check('一覧の色も、押すとコピーできる', (await clipboard()) === '#4F46E5', await clipboard())
  await panel.locator('section[aria-label="このページの色"] .inspect-row:has-text("#4F46E5") .inspect-pick').click()
  check('色の一覧から、その色を使っている図形を選べる', (await title()) === 'Rectangle 1', await title())
  await viewer.keyboard.press('Escape')
  await panel.locator('section[aria-label="このページの文字"] .inspect-pick').click()
  check('文字の一覧から、その設定を使っている図形を選べる', (await title()) === 'Text 1', await title())
  await viewer.keyboard.press('Escape')

  // ── クリックで選ぶ ──
  await viewer.mouse.click(...at(160, 170))
  check('クリックした図形が選ばれ、一覧でも選ばれる', (await title()) === 'Rectangle 1' && (await treeSelected()).join() === 'Rectangle 1' && (await panel.locator('.inspect-type').textContent()) === '長方形', await title())
  const shown = await Promise.all([['位置とサイズ', 'X'], ['位置とサイズ', 'Y'], ['位置とサイズ', '幅'], ['位置とサイズ', '高さ'], ['位置とサイズ', '角丸'], ['塗り', '色']].map(([s, l]) => value(s, l).textContent()))
  check('位置・大きさ・角丸・色が出る', shown.join() === '30,40,60,60,8,#4F46E5', shown.join())
  const css = await panel.locator('.inspect-code').textContent()
  check('CSS が出る', css === ['position: absolute;', 'left: 30px;', 'top: 40px;', 'width: 60px;', 'height: 60px;', 'background: #4f46e5;', 'border-radius: 8px;'].join('\n'), JSON.stringify(css))
  const outline = await pixelAt(160, 140)
  check('選んだ図形に枠が出る', outline[2] > 200 && outline[0] < 100, outline.join())

  // ── 値をコピーする ──
  await value('塗り', '色').click()
  check('値を押すとコピーできる', (await clipboard()) === '#4F46E5' && (await value('塗り', '色').textContent()) === 'コピーしました', await clipboard())
  await panel.locator('button:text-is("CSS をコピー")').click()
  check('CSS をコピーできる', (await clipboard()) === css)
  // 単位を rem にすると、長さが 16px = 1rem で換算される。選び直しても単位はそのまま
  await panel.locator('select[aria-label="長さの単位"]').selectOption('rem')
  const rem = await panel.locator('.inspect-code').textContent()
  check('CSS の長さの単位を rem にできる', rem === ['position: absolute;', 'left: 1.875rem;', 'top: 2.5rem;', 'width: 3.75rem;', 'height: 3.75rem;', 'background: #4f46e5;', 'border-radius: 0.5rem;'].join('\n'), JSON.stringify(rem))
  // rem の基準を変えられる。px に戻しても、基準は覚えている
  const remBase = panel.locator('input[aria-label="1rem の大きさ（px）"]')
  await remBase.fill('10')
  check('rem の基準を変えられる', (await panel.locator('.inspect-code').textContent()).includes('width: 6rem;'), await panel.locator('.inspect-code').textContent())
  await remBase.fill('16')
  await remBase.evaluate((input) => input.blur())
  await panel.locator('select[aria-label="長さの単位"]').selectOption('px')
  check('px のときは rem の基準の欄を出さない', (await remBase.count()) === 0)

  // ── 色の書き方を切り替える ──
  await panel.locator('select[aria-label="色の書き方"]').selectOption('rgb')
  check('色を RGB で出せる（設定の一覧と CSS の両方）', (await value('塗り', '色').textContent()) === 'rgb(79, 70, 229)' && (await panel.locator('.inspect-code').textContent()).includes('background: rgb(79, 70, 229);'), await value('塗り', '色').textContent())
  await panel.locator('select[aria-label="色の書き方"]').selectOption('hsl')
  check('色を HSL で出せる', (await value('塗り', '色').textContent()) === 'hsl(243, 75%, 59%)', await value('塗り', '色').textContent())
  await viewer.keyboard.press('Escape')
  check('選択を外しても書き方はそのままで、ページの色の一覧も従う', (await rows('このページの色')).includes('1 か所=hsl(243, 75%, 59%)'), (await rows('このページの色')).join())
  await panel.locator('select[aria-label="色の書き方"]').selectOption('hex')
  await viewer.mouse.click(...at(160, 170))

  // ── 間隔を測る ──
  await viewer.mouse.move(...at(290, 170))
  const gap = await pixelAt(200, 170)
  const above = await pixelAt(160, 110)
  check('選んだまま別の図形に重ねると、間隔の線が出る', isRed(gap) && !isRed(above), `${gap.join()} / ${above.join()}`)
  await viewer.screenshot({ path: path.join(OUT, '42-dev-mode-distance.png') })
  // フレームの余白のところに重ねると、フレームの辺までの線が出る（左は 100 → 130）
  await viewer.mouse.move(...at(400, 380))
  const left = await pixelAt(105, 170)
  const top = await pixelAt(160, 110)
  check('親のフレームに重ねると、辺までの余白の線が出る', isRed(left) && isRed(top), `${left.join()} / ${top.join()}`)

  // ── Shift を押しながら押して、2 つ選ぶ ──
  const shiftClick = async (x, y) => { await viewer.keyboard.down('Shift'); await viewer.mouse.click(...at(x, y)); await viewer.keyboard.up('Shift') }
  await shiftClick(290, 170)
  const between = await pixelAt(220, 170)
  const noFrameGap = await pixelAt(160, 110)
  check('Shift を押しながら押すと、2 つ選べて、その間隔が出る', (await title()) === '2 個を選択' && (await rows('間隔')).join() === '横=60' && (await treeSelected()).join() === 'Rectangle 2,Rectangle 1' && isRed(between) && !isRed(noFrameGap), `${await title()} ${(await rows('間隔')).join()} ${between.join()}`)
  check('いくつも選ぶと、全体を囲む矩形が出る', (await rows('全体')).join() === 'X=130,Y=140,幅=200,高さ=60', (await rows('全体')).join())
  await viewer.screenshot({ path: path.join(OUT, '44-dev-mode-two.png') })
  const [both] = await Promise.all([viewer.waitForEvent('download'), panel.locator('button:text-is("まとめて PNG に")').click()])
  check('選んだものをまとめて PNG に書き出せる', both.suggestedFilename() === 'Rectangle 1 ほか 1 個.png', both.suggestedFilename())
  await shiftClick(290, 170)
  check('もう一度 Shift を押しながら押すと、選択から外れる', (await title()) === 'Rectangle 1', await title())
  await viewer.keyboard.down('Shift')
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Text 1"))').click()
  await viewer.keyboard.up('Shift')
  check('レイヤー一覧でも、Shift を押しながら選べる', (await title()) === '2 個を選択' && (await treeSelected()).join() === 'Text 1,Rectangle 1', (await treeSelected()).join())
  // 上下に離れた 2 つは、縦の間隔だけ（重なっている横の向きの辺のずれは出さない）
  const stacked = await rows('間隔')
  check('上下に離れた 2 つは、縦の間隔だけを出す', stacked.length === 1 && stacked[0].startsWith('縦='), stacked.join())
  await panel.locator('.inspect-selection button:text-is("Text 1")').click()
  check('選んでいるものの一覧から 1 つに絞れる', (await title()) === 'Text 1', await title())

  // ── ロック中のもの、テキスト ──
  await viewer.mouse.click(...at(290, 170))
  check('ロックしてある図形も選べる', (await title()) === 'Rectangle 2' && (await value('位置とサイズ', 'X').textContent()) === '150', await title())
  await viewer.mouse.click(...at(140, 300))
  check('テキストは内容と文字の設定が出る', (await title()) === 'Text 1' && (await value('テキスト', '内容').textContent()) === 'Hello' && (await value('テキスト', 'サイズ').textContent()) === '16' && (await panel.locator('.inspect-code').textContent()).includes('font-size: 16px;'))

  // ── ドラッグは画面の移動のまま ──
  const [fromX, fromY] = at(160, 170)
  await viewer.mouse.move(fromX, fromY)
  await viewer.mouse.down()
  await viewer.mouse.move(fromX + 40, fromY + 30, { steps: 4 })
  await viewer.mouse.up()
  const moved = await pixel(fromX - box.x + 40, fromY - box.y + 30)
  check('ドラッグしても選択は変わらず、画面が動く', (await title()) === 'Text 1' && moved[0] === 0x4f && moved[1] === 0x46 && moved[2] === 0xe5, `${await title()} ${moved.join()}`)
  await fit()

  // ── 一覧から選ぶ、書き出す ──
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Frame 1"))').click()
  check('一覧から選べる', (await title()) === 'Frame 1' && (await value('位置とサイズ', '幅').textContent()) === '400' && (await panel.locator('.inspect-code').first().textContent()).startsWith('position: relative;'))
  const [png] = await Promise.all([viewer.waitForEvent('download'), panel.locator('button:text-is("PNG に書き出し")').click()])
  check('選んだものを PNG に書き出せる', png.suggestedFilename() === 'Frame 1.png', png.suggestedFilename())

  // ── 中身のあるフレームは、子孫までまとめた HTML と CSS が出る ──
  const htmlSection = panel.locator('section[aria-label="HTML"]')
  const markupHtml = await htmlSection.locator('.inspect-code').nth(0).textContent()
  const markupCss = await htmlSection.locator('.inspect-code').nth(1).textContent()
  check('子孫までまとめた HTML が出る', markupHtml === ['<div class="frame-1">', '  <div class="rectangle-1"></div>', '  <div class="rectangle-2"></div>', '  <div class="text-1">Hello</div>', '</div>'].join('\n'), JSON.stringify(markupHtml))
  check('子孫までまとめた CSS が出る', markupCss.startsWith('.frame-1 {\n  position: relative;') && markupCss.includes('.rectangle-2 {\n  position: absolute;\n  left: 150px;'), JSON.stringify(markupCss.slice(0, 120)))
  await htmlSection.locator('button:text-is("HTML をコピー")').click()
  check('HTML をコピーできる', (await clipboard()) === markupHtml)
  const [htmlFile] = await Promise.all([viewer.waitForEvent('download'), htmlSection.locator('button:text-is("HTML ファイルを保存")').click()])
  const htmlPath = path.join(OUT, 'dev-mode.html')
  await htmlFile.saveAs(htmlPath)
  const saved = fs.readFileSync(htmlPath, 'utf8')
  check('HTML ファイルとして保存できる', htmlFile.suggestedFilename() === 'Frame 1.html' && saved.startsWith('<!doctype html>') && saved.includes(markupHtml) && saved.includes('.text-1 {'), htmlFile.suggestedFilename())
  // 保存したファイルを開くと、デザインと同じ位置に要素が並ぶ
  const opened = await context.newPage()
  await opened.goto('file://' + htmlPath)
  const placed = await opened.evaluate(() => { const r = document.querySelector('.rectangle-2').getBoundingClientRect(); return [r.x, r.y, r.width, r.height] })
  check('保存した HTML を開くと、デザインどおりの位置と大きさになる', placed.join() === '150,40,80,60', placed.join())
  await opened.close()
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Rectangle 1"))').click()
  check('中身のない図形には HTML の欄を出さない', (await htmlSection.count()) === 0)

  // ── コードの形式を切り替える（React の style / CSS Modules / Tailwind） ──
  const format = panel.locator('select[aria-label="コードの形式"]')
  const jsxSection = panel.locator('section[aria-label="JSX"]')
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Frame 1"))').click()
  await format.selectOption('react')
  const reactJsx = await jsxSection.locator('.inspect-code').first().textContent()
  check('React（style）にすると、style を付けた JSX のコンポーネントが出て、CSS の欄はない', reactJsx.startsWith('export function Frame1() {\n  return (\n    <div style={{ position: \'relative\'') && reactJsx.includes("<div style={{ position: 'absolute', left: 150, top: 40, width: 80, height: 60") && (await jsxSection.locator('.inspect-code').count()) === 1 && (await htmlSection.count()) === 0, JSON.stringify(reactJsx.slice(0, 160)))
  check('1 つのノードの欄も style のオブジェクトになる', (await panel.locator('section[aria-label="style"] .inspect-code').textContent()).startsWith("{\n  position: 'relative',"))
  await jsxSection.locator('button:text-is("JSX をコピー")').click()
  check('JSX をコピーできる', (await clipboard()) === reactJsx)
  const [reactFile] = await Promise.all([viewer.waitForEvent('download'), jsxSection.locator('button:text-is("HTML ファイルを保存")').click()])
  await reactFile.saveAs(path.join(OUT, 'dev-mode-react.html'))
  check('形式が React でも、保存するファイルは HTML', fs.readFileSync(path.join(OUT, 'dev-mode-react.html'), 'utf8').includes(markupHtml))
  await format.selectOption('css-modules')
  const modules = await jsxSection.locator('.inspect-code').allTextContents()
  check('React（CSS Modules）にすると、styles を読み込む JSX と、そのクラスの CSS が出る', modules.length === 2 && modules[0].startsWith("import styles from './Frame1.module.css'") && modules[0].includes('<div className={styles.rectangle2}></div>') && modules[1].includes('.rectangle2 {\n  position: absolute;'), JSON.stringify(modules[0].slice(0, 120)))
  await format.selectOption('tailwind')
  const tailwind = await jsxSection.locator('.inspect-code').allTextContents()
  check('React（Tailwind）にすると、クラスを並べた JSX が出る', tailwind.length === 1 && tailwind[0].includes('<div className="absolute left-[150px] top-[40px] w-[80px] h-[60px] bg-[#d9d9d9]"></div>'), JSON.stringify(tailwind[0]))
  check('1 つのノードの欄も Tailwind のクラスになる', (await panel.locator('section[aria-label="Tailwind のクラス"] .inspect-code').textContent()).startsWith('relative w-[400px] h-[300px]'))
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Rectangle 1"))').click()
  check('選び直しても形式はそのまま', (await panel.locator('section[aria-label="Tailwind のクラス"] .inspect-code').textContent()) === 'absolute left-[30px] top-[40px] w-[60px] h-[60px] bg-[#4f46e5] rounded-[8px]', await panel.locator('.inspect-code').first().textContent())
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Frame 1"))').click()
  await format.selectOption('vue')
  const vueSection = panel.locator('section[aria-label="Vue"]')
  const vue = await vueSection.locator('.inspect-code').allTextContents()
  check('Vue（SFC）にすると、<template> と <style scoped> をまとめた 1 つのファイルが出る', vue.length === 1 && vue[0].startsWith('<template>\n  <div class="frame-1">') && vue[0].includes('    <div class="rectangle-2"></div>') && vue[0].includes('</template>\n\n<style scoped>\n.frame-1 {') && vue[0].endsWith('</style>'), JSON.stringify(vue[0]?.slice(0, 160)))
  check('Vue のときも 1 つのノードの欄は CSS', (await panel.locator('section[aria-label="CSS"] .inspect-code').textContent()).startsWith('position: relative;'))
  await vueSection.locator('button:text-is("Vue をコピー")').click()
  check('Vue のファイルをコピーできる', (await clipboard()) === vue[0])
  await format.selectOption('html')

  // ── フレームの名前のラベルで選ぶ ──
  await viewer.mouse.click(...at(700, 250))
  await viewer.mouse.click(...at(112, 92))
  check('フレームの名前のラベルを押しても選べる', (await title()) === 'Frame 1', await title())

  // ── キーボードで、レイヤーの木に沿って選択を動かす ──
  const walk = async (key) => { await viewer.keyboard.press(key); return title() }
  const walked = [await walk('Enter'), await walk('Tab'), await walk('Shift+Tab'), await walk('Shift+Tab'), await walk('Enter'), await walk('Shift+Enter')]
  check('Enter で子へ、Tab で隣へ、Shift + Enter で親へ動く', walked.join() === 'Text 1,Rectangle 2,Text 1,Rectangle 1,Rectangle 1,Frame 1', walked.join())

  // ── 一覧の種類アイコンと検索 ──
  check('一覧に種類のアイコンが出る', (await viewer.locator('.inspect-layer .layer-icon svg').count()) === 4)
  const search = viewer.locator('.layer-search')
  await search.fill('rect')
  check('名前で探せる', (await tree()).join() === 'Rectangle 2,Rectangle 1', (await tree()).join())
  await search.fill('hello')
  check('テキストの内容でも探せる', (await tree()).join() === 'Text 1', (await tree()).join())
  await viewer.locator('.inspect-layer').first().click()
  check('見つけたものを選べる', (await title()) === 'Text 1', await title())
  await search.fill('zzz')
  check('見つからなければ、そう出る', (await tree()).length === 0 && (await viewer.locator('.viewer-sidebar .panel-hint').textContent()) === '見つかりません。')
  await search.press('Escape')
  check('検索欄の Esc で、元の一覧に戻る（選択はそのまま）', (await tree()).length === 4 && (await search.inputValue()) === '' && (await title()) === 'Text 1', (await tree()).join())

  // ── 一覧から選ぶと、画面に入っていないものは見える位置へ寄る ──
  const zoomText = () => viewer.locator('.zoom-value').textContent()
  for (let i = 0; i < 5; i++) await viewer.locator('button[title="拡大"]').click()
  const zoomed = await zoomText()
  const center = () => pixel(box.width / 2, box.height / 2)
  const isIndigo = (p) => p[0] === 0x4f && p[1] === 0x46 && p[2] === 0xe5
  const beforeReveal = await center()
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Rectangle 1"))').click()
  check('画面の外のものを一覧から選ぶと、倍率はそのままで中央へ寄る', !isIndigo(beforeReveal) && isIndigo(await center()) && (await zoomText()) === zoomed, `${beforeReveal.join()} → ${(await center()).join()} ${await zoomText()}`)
  await viewer.screenshot({ path: path.join(OUT, '43-dev-mode-reveal.png') })
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Frame 1"))').click()
  check('いまの倍率で収まらないものは、全体が入るまで引く', (await zoomText()) === '100%', await zoomText())
  await fit()

  // ── ダブルクリックで、そのフレームを画面いっぱいに表示する ──
  for (let i = 0; i < 5; i++) await viewer.locator('button[title="拡大"]').click()
  await viewer.mouse.dblclick(box.x + box.width / 2 + 10, box.y + box.height / 2 + 10)
  check('ダブルクリックでフレーム全体を表示する', (await zoomText()) === '100%' && (await title()) === 'Frame 1', `${await zoomText()} ${await title()}`)
  await fit()

  // ── 選択を外す ──
  await viewer.mouse.click(...at(700, 250))
  check('何もない所を押すと、選択が外れる', (await title()) === 'インスペクト' && (await treeSelected()).length === 0)
  await viewer.mouse.click(...at(160, 170))
  await viewer.keyboard.press('Escape')
  check('Esc でも選択が外れる', (await title()) === 'インスペクト')

  // ── 見ている場所（ページと選択）を URL で共有する ──
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Rectangle 2"))').click()
  const linked = await viewer.evaluate(() => location.href)
  check('選ぶと、アドレスのハッシュにページと選択が入る', /#page=.+&select=.+/.test(linked), linked)
  await viewer.locator('button:text-is("リンクをコピー")').click()
  check('リンクをコピーできる', (await clipboard()) === linked, await clipboard())
  const receiver = await context.newPage()
  watchErrors(receiver, errors, 'receiver: ')
  await receiver.goto(linked)
  await receiver.locator('input[type=file]').setInputFiles(kdrPath)
  await receiver.waitForSelector('.inspect-panel')
  check('リンクを開いてから同じ kdr を開くと、その選択から始まる', (await receiver.locator('.inspect-panel .panel-title').textContent()) === 'Rectangle 2', await receiver.locator('.inspect-panel .panel-title').textContent())
  await receiver.evaluate(() => { location.hash = location.hash.replace(/select=[^&]+/, 'select=nothing') })
  await receiver.waitForTimeout(100)
  check('ドキュメントにないものを指すリンクは無視する', (await receiver.locator('.inspect-panel .panel-title').textContent()) === 'インスペクト')
  await receiver.close()
  await viewer.keyboard.press('Escape')

  // ── http で配信しているとき（Clipboard API が使えない）もコピーできる ──
  await viewer.evaluate(() => navigator.clipboard.writeText('前の内容'))
  await viewer.evaluate(() => Object.defineProperty(window, 'isSecureContext', { value: false }))
  await viewer.mouse.click(...at(160, 170))
  await value('位置とサイズ', '幅').click()
  check('Clipboard API が使えなくてもコピーできる', (await clipboard()) === '60', await clipboard())

  // ── ドキュメントは変わらない。ブラウザにも何も残さない ──
  for (const key of ['Backspace', 'ArrowRight', 'Meta+d', 'Meta+z']) await viewer.keyboard.press(key)
  check('選んでいても、キー操作で何も変わらない', (await title()) === 'Rectangle 1' && (await value('位置とサイズ', 'X').textContent()) === '30' && (await tree()).join() === 'Frame 1,Text 1,Rectangle 2,Rectangle 1')
  check('viewer はブラウザに何も保存しない', (await viewer.evaluate(() => localStorage.length)) === 0)

  // ── 回した図形の間隔 ──
  await viewer.locator('input[type=file]').setInputFiles(rotatedPath)
  await viewer.locator('[aria-label="ページ"] .list-button:text-is("Page 2")').click()
  const rotatedLayers = viewer.locator('.inspect-layer')
  const pickLayers = async (first, second) => {
    await rotatedLayers.nth(first).click()
    await viewer.keyboard.down('Shift'); await rotatedLayers.nth(second).click(); await viewer.keyboard.up('Shift')
  }
  // 一覧は上から、回していないもの・回した 2 つめ・回した 1 つめ
  await pickLayers(2, 1)
  const along = await rows('間隔')
  check('同じ向きに回した 2 つは、辺に沿って測る', along.includes('測る向き=辺に沿う（30°）') && along.some((row) => row.startsWith('横')), along.join())
  await viewer.screenshot({ path: path.join(OUT, '45-dev-mode-rotated.png') })
  await pickLayers(2, 0)
  const boxed = await rows('間隔')
  check('向きの違う 2 つは、回した図形を囲む矩形で測る', boxed.includes('測る向き=回した図形は囲む矩形で'), boxed.join())

  // ── 色の一覧は見える色だけ数える（重ねた塗りを CLI で作る）──
  // Cover は緑の上に赤を重ねる（緑は隠れる）。Glass は不透明度 0.5 なので、青の上に白を重ねても青が透けて見える
  const layeredPath = path.join(OUT, 'dev-mode-layered.kdr')
  execFileSync(process.execPath, [path.join(__dirname, '..', 'cli', 'kadrokreo.ts'), 'new', 'Layered',
    '+', 'add', 'rect', '--name', 'Cover', '--width', '80', '--height', '80', 'fills=[{"type":"solid","color":"#00ff00"},{"type":"solid","color":"#ff0000"}]',
    '+', 'add', 'rect', '--name', 'Glass', '--x', '120', '--width', '80', '--height', '80', 'opacity=0.5', 'fills=[{"type":"solid","color":"#0000ff"},{"type":"solid","color":"#ffffff"}]',
    '-o', layeredPath], { stdio: ['ignore', 'pipe', 'inherit'] })
  await viewer.locator('input[type=file]').setInputFiles(layeredPath)
  await viewer.waitForSelector('.inspect-layer:has(.layer-name:text-is("Glass"))')
  const layeredColors = await rows('このページの色')
  check('色の一覧は、不透明な塗りの下に隠れた色を数えず、半透明なら下も数える', layeredColors.slice().sort().join() === '1 か所=#0000FF,1 か所=#FF0000,1 か所=#FFFFFF', layeredColors.join())
  await viewer.locator('.inspect-layer:has(.layer-name:text-is("Cover"))').click()
  const coverFills = await panel.locator('section[aria-label="塗り"]').textContent()
  check('隠れた色は、図形を選べばインスペクトの塗りに出る', coverFills.includes('#00FF00') && coverFills.includes('#FF0000'), coverFills)

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
