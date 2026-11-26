// kdr replace（テキストの内容の一括置き換え）。CLI で置き換えた kdr を editor で開くと、文言が変わり、インスタンスの上書きが残り、
// テキストの大きさと自動の並びが、editor で同じ文字を打ち直したときと揃うことを確かめる
const { chromium } = require('playwright-core')
const { execFileSync, spawnSync } = require('child_process')
const path = require('path')

const { OUT, EDITOR, check, finish, crashed, watchErrors, savedDocument, rowFinder } = require('./harness.cjs')
const CLI = path.join(__dirname, '..', 'cli', 'kadrokreo.ts')
const cli = (args) => execFileSync(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })

;(async () => {
  // ── CLI で作って置き換える ──
  const kdrPath = path.join(OUT, 'replace.kdr')
  cli(['new', 'Replace', '+', 'add', 'frame', '--name', 'Card', '--id', 'card', 'layout=column', 'padding=8', 'fill=#f5f5ff',
    '+', 'add', 'text', '--parent', 'card', '--name', 'A', '--id', 'a', '--text', 'ログインする',
    '+', 'add', 'frame', '--name', 'Button', '--id', 'btn', '--x', '200', 'layout=row', 'padding=8', 'fill=#5b4cf5',
    '+', 'add', 'text', '--parent', 'btn', '--name', 'Label', '--id', 'label', '--text', 'ログイン', 'fill=#ffffff', '+', 'component', 'btn',
    '+', 'instance', 'Button', '--id', 'i1', '--x', '200', '--y', '100',
    '+', 'instance', 'Button', '--id', 'i2', '--x', '200', '--y', '200', '+', 'set', 'i2/Label', 'text=ログインして', '-o', kdrPath])
  const replaced = spawnSync(process.execPath, [CLI, '-f', kdrPath, '-w', 'replace', 'ログイン', 'サインイン'], { encoding: 'utf8' })
  check('CLI の replace が、置き換えたノードと件数を標準エラーに出す',
    replaced.status === 0 && replaced.stderr.includes('Page 1\ta\tCard/A\t1 か所') && replaced.stderr.includes('個のテキストの') && replaced.stdout === '',
    replaced.stderr)

  const browser = await chromium.launch({ channel: 'chrome' })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
  const page = await context.newPage()
  const errors = []
  watchErrors(page, errors)
  await page.goto(EDITOR)
  await page.waitForSelector('.canvas-view canvas')
  const saved = async () => { await page.waitForTimeout(600); return (await savedDocument(page)).pages[0].nodes }
  const row = rowFinder(page, { originals: true, first: true })

  // ── editor で開く: 文言が変わり、上書きが残る ──
  await page.locator('input[type=file][accept^=".kdr"]').setInputFiles(kdrPath)
  await page.waitForTimeout(800)
  let nodes = await saved()
  const copyText = (id) => nodes[nodes[id].children[0]].text
  check('置き換えた文言で開く', nodes.a.text === 'サインインする' && nodes.label.text === 'サインイン', JSON.stringify([nodes.a.text, nodes.label.text]))
  check('元を置き換えるとインスタンスに伝わり、上書きした文言は上書きが置き換わる',
    copyText('i1') === 'サインイン' && copyText('i2') === 'サインインして'
      && JSON.stringify(nodes.i1.component.overrides) === '{}' && nodes.i2.component.overrides.label?.text === 'サインインして',
    JSON.stringify([copyText('i1'), copyText('i2'), nodes.i2.component.overrides]))
  const fromCli = { a: nodes.a.width, card: nodes.card.width, label: nodes.label.width, btn: nodes.btn.width, i1: nodes.i1.width }

  // ── editor で同じ文字を打ち直すと、同じ大きさ・並びになる ──
  const retype = async (name, text) => {
    await row(name).click()
    await page.keyboard.press('Enter')
    await page.locator('textarea.text-editor').waitFor()
    await page.keyboard.press('Meta+a')
    await page.keyboard.type(text)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  }
  await retype('A', 'サインインする')
  await retype('Label', 'サインイン')
  nodes = await saved()
  const fromEditor = { a: nodes.a.width, card: nodes.card.width, label: nodes.label.width, btn: nodes.btn.width, i1: nodes.i1.width }
  const near = Object.keys(fromCli).every((key) => Math.abs(fromCli[key] - fromEditor[key]) <= 2)
  check('置き換えたテキストと自動の並びの大きさが、editor で打ち直したときと揃う', near, `CLI ${JSON.stringify(fromCli)} / editor ${JSON.stringify(fromEditor)}`)
  await page.locator('.canvas-view').screenshot({ path: path.join(OUT, '50-replace.png') })

  check('コンソールエラーなし', errors.length === 0, errors.join(' | '))
  await browser.close()
  finish()
})().catch(crashed)
