const { chromium } = require('playwright-core')
const path = require('path')
const fs = require('fs')

const { OUT, EDITOR, VIEWER, check, finish, crashed, watchErrors, savedDocument } = require('./harness.cjs')

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const box = await page.locator('.canvas-view').boundingBox()
  const at = (x, y) => [box.x + x, box.y + y]
  const layers = () => page.locator('.layer-row .layer-name').allTextContents()
  const selected = () => page.locator('.layer-row[data-selected="true"] .layer-name').allTextContents()
  const row = (name) => page.locator(`.layer-row:has(.layer-name:text-is("${name}"))`)
  const field = (label) => page.locator(`.field:has(.field-label:text-is("${label}")) input`).first()
  const set = async (label, value) => { await field(label).fill(String(value)); await field(label).press('Enter') }
  const button = (label) => page.locator(`button:text-is("${label}")`)
  const deselect = () => page.mouse.click(...at(740, 600))
  const saved = () => savedDocument(page)
  const nodesOf = async (pageIndex = 0) => { await page.waitForTimeout(700); return Object.values((await saved()).pages[pageIndex].nodes) }
  const instances = (nodes) => nodes.filter((n) => n.type === 'frame' && n.component && n.component.role === 'instance')
  const textsIn = (nodes, root) => root.children.map((id) => nodes.find((n) => n.id === id)).filter((n) => n.type === 'text').map((n) => n.text)

  // ── ボタンを作って、コンポーネントにする ──
  await page.keyboard.press('t')
  await page.mouse.click(...at(140, 140))
  await page.keyboard.type('OK')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+A')
  await set('上', 10); await set('右', 20); await set('下', 10); await set('左', 20)
  await page.locator('[aria-label="塗りを有効にする"]').click()
  await button('コンポーネントにする').click()
  let nodes = await nodesOf()
  const main = nodes.find((n) => n.type === 'frame')
  check('フレームをコンポーネントの元にできる', main.component && main.component.role === 'main', JSON.stringify(main.component))

  // ── インスタンスを作る ──
  await button('インスタンスを作る').click()
  nodes = await nodesOf()
  let copies = instances(nodes)
  check('インスタンスができ、選択される', copies.length === 1 && (await selected()).join() === 'Frame 1' && copies[0].x === main.x + 20, JSON.stringify(copies.map((c) => [c.x, c.y])))
  check('インスタンスに元の中身が写る', textsIn(nodes, copies[0]).join() === 'OK' && copies[0].width === main.width)
  check('一覧では、インスタンスの中身は閉じた状態で出る', (await layers()).join() === 'Frame 1,Frame 1,Text 1', (await layers()).join())
  check('インスタンスでは、上書きできない見た目の項目を出さない', (await page.locator('.section-title:text-is("角丸")').count()) === 0 && (await page.locator('.section-title:text-is("影")').count()) === 0 && (await field('W').isDisabled()))

  // インスタンスを離れた場所へ動かす
  await set('X', 400); await set('Y', 300)
  await deselect()

  // ── インスタンスの中身は個別に選べない ──
  await page.mouse.click(...at(425, 318))
  check('インスタンスの文字を押しても、選ばれるのは全体', (await selected()).length === 1 && (await page.locator('.panel-title').last().textContent()) !== 'テキスト', await page.locator('.properties-panel .panel-title').first().textContent())
  await deselect()

  // ── 元を変えると、インスタンスにも反映される ──
  await page.mouse.dblclick(...at(165, 152))
  await page.waitForSelector('.text-editor')
  await page.keyboard.type('保存する')
  await page.screenshot({ path: path.join(OUT, '36-component-editing.png') })
  await page.keyboard.press('Escape')
  nodes = await nodesOf()
  copies = instances(nodes)
  const mainNow = nodes.find((n) => n.type === 'frame' && n.component && n.component.role === 'main')
  check('元の文字を変えると、インスタンスの文字と大きさも変わる', textsIn(nodes, copies[0]).join() === '保存する' && copies[0].width === mainNow.width && mainNow.width > main.width, `${textsIn(nodes, copies[0])} ${copies[0].width}/${mainNow.width}`)
  check('インスタンスの位置は変わらない', copies[0].x === 400 && copies[0].y === 300)
  await page.keyboard.press('Meta+z')
  nodes = await nodesOf()
  check('undo で元もインスタンスも戻る', textsIn(nodes, instances(nodes)[0]).join() === 'OK')
  await page.keyboard.press('Meta+Shift+z')

  // ── 複製・貼り付けでもインスタンスになる ──
  await row('Text 1').click()
  await page.keyboard.press('Escape')
  await page.locator('.layer-row').nth(1).click()
  check('一覧の 2 行目が元', (await button('インスタンスを作る').count()) === 1)
  await page.keyboard.press('Meta+d')
  nodes = await nodesOf()
  check('元を複製するとインスタンスになる', instances(nodes).length === 2 && nodes.filter((n) => n.component && n.component.role === 'main').length === 1, String(instances(nodes).length))

  // 別のページへ貼り付けても、元に追従する
  await page.keyboard.press('Meta+c')
  await page.locator('[aria-label="ページを追加"]').click()
  await page.keyboard.press('Meta+v')
  let second = await nodesOf(1)
  check('別のページへ貼り付けてもインスタンスになる', instances(second).length === 1 && textsIn(second, instances(second)[0]).join() === '保存する', JSON.stringify(instances(second).map((n) => n.name)))
  await button('元を表示').click()
  check('「元を表示」で元のあるページへ移る', (await page.locator('.page-row[data-selected="true"] .page-name').textContent()) === 'Page 1' && (await button('インスタンスを作る').count()) === 1)

  // 元の色を変えると、別のページのインスタンスも変わる
  await page.locator('[aria-label="塗りの色"]').fill('#4f46e5')
  second = await nodesOf(1)
  check('別のページのインスタンスにも反映される', instances(second)[0].fills[0].color === '#4f46e5', JSON.stringify(instances(second)[0].fills))
  await page.screenshot({ path: path.join(OUT, '37-components.png') })

  // ── 切り離す ──
  await deselect()
  await page.mouse.click(...at(425, 318))
  await button('切り離して編集できるようにする').click()
  nodes = await nodesOf()
  check('切り離すと、ただのフレームになり中身が一覧に出る', instances(nodes).length === 1 && (await layers()).filter((n) => n === 'Text 1').length === 2, (await layers()).join())
  await page.keyboard.press('Meta+z')

  // ── 元を消すと、インスタンスはただのフレームになる ──
  await page.locator('.layer-row').nth(2).click()
  const wasMain = (await button('インスタンスを作る').count()) === 1
  await page.keyboard.press('Backspace')
  nodes = await nodesOf()
  second = await nodesOf(1)
  check('元を消すと、インスタンスは中身を残してただのフレームになる', wasMain && instances(nodes).length === 0 && instances(second).length === 0 && nodes.filter((n) => n.type === 'text').length === 2, `main=${wasMain} ${instances(nodes).length} texts=${nodes.filter((n) => n.type === 'text').length}`)
  await page.keyboard.press('Meta+z')
  nodes = await nodesOf()
  check('undo で元とインスタンスに戻る', instances(nodes).length === 2)

  // ── 書き出しと viewer ──
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('button:text-is("kdr に書き出し")').click()])
  const kdrPath = path.join(OUT, 'components.kdr')
  await download.saveAs(kdrPath)
  const json = await require('./kdr.cjs').parseKdrBytes(fs.readFileSync(kdrPath))
  const links = json.document.pages.flatMap((p) => Object.values(p.nodes)).filter((n) => n.component).map((n) => n.component.role).sort()
  check('kdr につながりが入る', json.version === 16 && links.join() === 'instance,instance,instance,main', links.join())

  // ── コンポーネントの一覧から置く ──
  const componentRows = page.locator('.component-row')
  check('一覧にコンポーネントの元が出る', (await componentRows.count()) === 1 && (await componentRows.locator('.component-name').textContent()) === 'Frame 1')
  // 置き先のフレーム (600,400) 300×250 を作り、そこへドラッグする
  await deselect()
  await page.keyboard.press('f')
  await page.mouse.move(...at(600, 400)); await page.mouse.down()
  await page.mouse.move(...at(750, 520), { steps: 4 }); await page.mouse.move(...at(900, 650), { steps: 4 }); await page.mouse.up()
  await deselect()
  await componentRows.first().dragTo(page.locator('.canvas-view'), { targetPosition: { x: 750, y: 525 } })
  nodes = await nodesOf()
  const target = nodes.find((n) => n.type === 'frame' && !n.component && n.x === 600)
  const dropped = instances(nodes).find((n) => target && n.parentId === target.id)
  check('キャンバスへドラッグすると、その位置のフレームの中にインスタンスが入る',
    dropped && Math.abs(dropped.x + dropped.width / 2 - 150) <= 1 && Math.abs(dropped.y + dropped.height / 2 - 125) <= 1 && textsIn(nodes, dropped).join() === '保存する',
    JSON.stringify(dropped && [dropped.x, dropped.y, dropped.width, dropped.height]))
  check('置いたインスタンスが選ばれる', (await selected()).join() === 'Frame 1', (await selected()).join())
  const rootInstances = () => instances(nodes).filter((n) => n.parentId === null).length
  const before = rootInstances()
  await componentRows.first().click()
  nodes = await nodesOf()
  check('行を押すと、ページ直下にインスタンスが増える', rootInstances() === before + 1, `${before} → ${rootInstances()}`)
  // 別のページからも置け、元のページ名が見出しで分かる（名前順では行に添える）
  await page.locator('.page-row').nth(1).click()
  check('ページが複数あれば、元のページ名を見出しにする', (await page.locator('.component-heading').first().textContent()) === 'Page 1')
  await page.locator('[aria-label="コンポーネントの並べ方"]').selectOption('name')
  check('名前順では、別のページの元にページ名を添える', (await componentRows.first().locator('.component-page').textContent()) === 'Page 1')
  await page.locator('[aria-label="コンポーネントの並べ方"]').selectOption('document')
  await componentRows.first().click()
  second = await nodesOf(1)
  check('別のページにも一覧から置ける', instances(second).length === 2, String(instances(second).length))
  await componentRows.first().hover()
  await page.locator('[aria-label="Frame 1 の元を表示"]').click()
  check('一覧から元を表示できる', (await page.locator('.page-row[data-selected="true"] .page-name').textContent()) === 'Page 1' && (await button('インスタンスを作る').count()) === 1)
  await page.screenshot({ path: path.join(OUT, '39-components-panel.png') })

  // ── コンポーネントは紫で見分けられる ──
  check('一覧で、コンポーネントの行に印が付く',
    (await row('Frame 4').first().getAttribute('data-component')) === 'false' && (await page.locator('.layer-row[data-component="true"]').count()) >= 3)
  // 選択枠の色（元を選んでいる）。枠の左上の辺の画素が紫（#9747ff）になる
  const mainBox = nodes.find((n) => n.type === 'frame' && n.component && n.component.role === 'main')
  const pixel = await page.evaluate(([x, y]) => {
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    return [...canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data]
  }, [mainBox.x + 10, mainBox.y])
  check('元を選ぶと、選択枠が紫になる', pixel[0] === 0x97 && pixel[1] === 0x47 && pixel[2] === 0xff, pixel.join())

  // ── インスタンスの元を差し替える ──
  await row('Frame 4').first().click()
  await button('コンポーネントにする').click()
  await deselect()
  await page.mouse.click(...at(425, 318))
  const swapSelect = page.locator('[aria-label="インスタンスの元"]')
  check('インスタンスでは、元を選べる', (await swapSelect.locator('option').allTextContents()).join() === 'Frame 1,Frame 4', (await swapSelect.locator('option').allTextContents()).join())
  await swapSelect.selectOption({ label: 'Frame 4' })
  nodes = await nodesOf()
  const frame4 = nodes.find((n) => n.type === 'frame' && n.component && n.component.role === 'main' && n.x === 600)
  const swapped = instances(nodes).find((n) => n.x === 400 && n.y === 300)
  check('元を差し替えると、新しい元の大きさと中身になる', swapped && swapped.component.id === frame4.component.id && swapped.width === 300 && swapped.name === 'Frame 4',
    JSON.stringify(swapped && [swapped.name, swapped.width]))
  await page.keyboard.press('Meta+z')
  nodes = await nodesOf()
  check('undo で元に戻る', instances(nodes).some((n) => n.x === 400 && n.y === 300 && n.width === 104))

  // ── バリアント ──
  await row('Frame 4').first().click()
  await button('バリアントを追加').click()
  nodes = await nodesOf()
  const variantSet = nodes.find((n) => n.type === 'frame' && !n.component && n.name === 'Frame 4')
  const variantNames = () => variantSet.children.map((id) => nodes.find((n) => n.id === id).name)
  check('バリアントを追加すると、元をまとまりで包み、複製を 2 つめのバリアントにする',
    variantSet && variantNames().join() === '種類=標準,種類=2' && (await selected()).join() === '種類=2',
    variantSet ? variantNames().join() : 'まとまりがない')
  await set('種類', '押下')
  nodes = await nodesOf()
  check('プロパティの値を変えられる', nodes.some((n) => n.name === '種類=押下'))
  const componentRow = page.locator('.component-row:has(.component-name:text-is("Frame 4"))')
  check('一覧では、まとまりを 1 行にまとめる', (await componentRow.count()) === 1 && (await componentRow.locator('.component-page').textContent()) === '2 種類')
  await deselect()
  await page.mouse.click(...at(425, 318))
  await swapSelect.selectOption({ label: 'Frame 4（種類=標準）' })
  const kind = page.locator('.field:has(.field-label:text-is("種類")) select')
  check('バリアントのインスタンスでは、プロパティを選べる', (await kind.locator('option').allTextContents()).join() === '標準,押下', (await kind.locator('option').allTextContents()).join())
  await kind.selectOption('押下')
  nodes = await nodesOf()
  const pressed = nodes.find((n) => n.name === '種類=押下')
  const variantInstance = instances(nodes).find((n) => n.x === 400 && n.y === 300)
  check('値を選ぶと、そのバリアントに差し替わる。名前はまとまりの名前', variantInstance.component.id === pressed.component.id && variantInstance.name === 'Frame 4',
    JSON.stringify([variantInstance.name, variantInstance.component.id === pressed.component.id]))
  await page.screenshot({ path: path.join(OUT, '39-variants.png') })

  // ── バリアントのまとまりに破線の枠が出る ──
  const setNow = nodes.find((n) => n.id === variantSet.id)
  const setPixel = await page.evaluate(([x, y]) => {
    const canvas = document.querySelector('.canvas-view canvas')
    const ratio = canvas.width / canvas.clientWidth
    const data = canvas.getContext('2d').getImageData(Math.round(x * ratio), Math.round(y * ratio) - 1, 1, 3).data
    return [0, 4, 8].some((i) => data[i] === 0x97 && data[i + 1] === 0x47 && data[i + 2] === 0xff)
  }, [setNow.x + 2, setNow.y])
  check('バリアントのまとまりを紫の破線で囲む', setPixel)

  // ── プロパティを足す・消す、真偽値のプロパティ ──
  const selectSet = async () => {
    const rows = page.locator('.layer-row:has(.layer-name:text-is("Frame 4"))')
    for (let i = 0; i < (await rows.count()); i++) {
      await rows.nth(i).click()
      if ((await page.locator('.properties-panel .section-title:text-is("バリアント")').count()) === 1) return
    }
  }
  const names = async () => { nodes = await nodesOf(); const set = nodes.find((n) => n.id === variantSet.id); return set.children.map((id) => nodes.find((n) => n.id === id).name) }
  await selectSet()
  await button('プロパティを追加').click()
  check('プロパティを足すと、すべてのバリアントの名前に書き足す', (await names()).join('|') === '種類=標準, プロパティ1=標準|種類=押下, プロパティ1=標準', (await names()).join('|'))
  const propertyName = page.locator('.variant-property-block > .variant-property input').nth(1)
  await propertyName.fill('選択'); await propertyName.press('Enter')
  await page.locator('.layer-row:has(.layer-name:text-is("種類=標準, 選択=標準"))').click()
  await set('選択', 'false')
  await page.locator('.layer-row:has(.layer-name:text-is("種類=押下, 選択=標準"))').click()
  await set('選択', 'true')
  check('値が true / false だけのプロパティは、バリアントではチェック欄になる', (await page.locator('.check-field:has-text("選択") input').isChecked()) === true)
  await selectSet()
  check('まとまりでは、真偽値のプロパティと分かる', (await page.locator('.variant-property-block > .variant-property .field-label').allTextContents()).join() === '2 値,真偽', (await page.locator('.variant-property-block > .variant-property .field-label').allTextContents()).join())
  await button('プロパティを追加').click()
  await page.locator('[aria-label="プロパティ プロパティ1 を消す"]').click()
  check('プロパティを消すと、すべてのバリアントの名前から外す', (await names()).join('|') === '種類=標準, 選択=false|種類=押下, 選択=true', (await names()).join('|'))
  await deselect()
  await page.mouse.click(...at(425, 318))
  const toggle = page.locator('.properties-panel .check-field:has-text("選択") input')
  check('インスタンスでは、真偽値のプロパティをチェック欄で選べる', (await toggle.count()) === 1 && (await toggle.isChecked()) === true)
  await toggle.uncheck()
  nodes = await nodesOf()
  const unchecked = nodes.find((n) => n.name === '種類=標準, 選択=false')
  check('チェックを外すと、false のバリアントに差し替わる', instances(nodes).find((n) => n.x === 400 && n.y === 300).component.id === unchecked.component.id)
  await page.screenshot({ path: path.join(OUT, '39-variant-properties.png') })

  // ── 一覧からバリアントを選んで置く ──
  const setRow = page.locator('.component-row:has(.component-name:text-is("Frame 4"))')
  await setRow.locator('.component-toggle').click()
  const variantRows = page.locator('.component-row[data-depth="1"]')
  check('一覧でまとまりを開くと、バリアントが並ぶ', (await variantRows.locator('.component-name').allTextContents()).join('|') === '種類=標準, 選択=false|種類=押下, 選択=true', (await variantRows.locator('.component-name').allTextContents()).join('|'))
  const countOf = (componentId) => instances(nodes).filter((n) => n.component.id === componentId).length
  const pressedNow = nodes.find((n) => n.name === '種類=押下, 選択=true')
  const placedBefore = countOf(pressedNow.component.id)
  await variantRows.nth(1).click()
  nodes = await nodesOf()
  check('バリアントの行を押すと、そのバリアントのインスタンスを置く', countOf(pressedNow.component.id) === placedBefore + 1)
  await page.keyboard.press('Meta+z')

  // ── 一覧の検索と並べ替え ──
  const search = page.locator('[aria-label="コンポーネントを検索"]')
  const listed = () => page.locator('.component-row .component-name').allTextContents()
  await search.fill('frame 1')
  check('名前で絞り込める（大文字と小文字は区別しない）', (await listed()).join() === 'Frame 1', (await listed()).join())
  await search.fill('true')
  check('バリアントの名前でも絞り込め、当てはまるものを開いて見せる', (await listed()).join('|') === 'Frame 4|種類=押下, 選択=true', (await listed()).join('|'))
  await search.fill('ない名前')
  check('当てはまるものがなければ、そう出す', (await page.locator('.components .panel-hint').textContent()).includes('ない名前'))
  await search.press('Escape')
  await setRow.locator('.component-toggle').click()
  await page.locator('[aria-label="コンポーネントの並べ方"]').selectOption('name')
  check('名前の順に並べ替えられる', (await listed()).join() === 'Frame 1,Frame 4', (await listed()).join())

  const viewer = await context.newPage()
  watchErrors(viewer, errors, 'viewer: ')
  await viewer.goto(VIEWER)
  await viewer.locator('input[type=file]').setInputFiles(kdrPath)
  await viewer.waitForSelector('.canvas-view canvas')
  await viewer.waitForTimeout(300)
  await viewer.screenshot({ path: path.join(OUT, '38-viewer-components.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
