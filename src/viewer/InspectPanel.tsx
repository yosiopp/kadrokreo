import { useEffect, useState } from 'react'
import type { DesignDocument, EmbeddedFont, NodeId, Page } from '../document/types.ts'
import { fontFileName } from '../document/fontFace.ts'
import { ExportControls } from '../ui/ExportControls.tsx'
import { copyText } from '../ui/clipboard.ts'
import { TYPE_LABELS } from '../ui/labels.ts'
import { nodeKind } from '../document/path.ts'
import { COLOR_FORMAT_LABELS, type ColorFormat } from './colors.ts'
import {
  type CodeStyle,
  DEFAULT_CODE_STYLE,
  type InspectSection,
  inspectNode,
  inspectSelection,
} from './inspect.ts'
import { CODE_FORMAT_LABELS, type CodeFormat } from './codeFormat.ts'
import { nodeCode, nodeFontFaces, nodeMarkup } from './markup.ts'
import { inspectPage } from './summary.ts'
import { findMain, instanceOf } from '../document/component.ts'

type Props = {
  document: DesignDocument
  page: Page
  /** 選んでいるノード。何も選んでいなければ空 */
  selection: readonly NodeId[]
  scale: number
  onScaleChange: (scale: number) => void
  /** 選んでいるノードを PNG に書き出す（いくつも選んでいれば、まとめて 1 枚に） */
  onExport: () => void
  /** 選んでいるノードを SVG に書き出す（いくつも選んでいれば、まとめて 1 つに） */
  onExportSvg: () => void
  /** 選んでいるノードを SVG の文字にしてクリップボードへ入れる */
  onCopySvg: () => Promise<boolean>
  /** ノードを 1 つ選ぶ */
  onSelect: (id: NodeId) => void
  /** いくつものノードをまとめて選ぶ */
  onSelectNodes: (ids: NodeId[]) => void
  /** 選んでいる画像の、元のファイルを保存する */
  onSaveImage: () => void
  /** テキストが使う、kdr に埋め込んだ書体のファイルを保存する */
  onSaveFont: (font: EmbeddedFont) => void
  /** 選んでいるノードを、中身まで含めた HTML ファイルとして保存する */
  onSaveHtml: (style: CodeStyle) => void
  /** 選んでいるインスタンス（またはその中身）の元へ移る */
  onGoToMain: () => void
}

/**
 * 選んだノードの設定と CSS を見せるパネル。何も選んでいなければ、ページで使われている色と文字の一覧を見せる。
 * 値は、押すとコピーできる。
 */
export function InspectPanel({
  document,
  page,
  selection,
  scale,
  onScaleChange,
  onExport,
  onExportSvg,
  onCopySvg,
  onSelect,
  onSelectNodes,
  onSaveImage,
  onSaveFont,
  onSaveHtml,
  onGoToMain,
}: Props) {
  // コピーした値の目印（どの行か）。少しのあいだ「コピーしました」と出す
  const [copied, setCopied] = useState<string | null>(null)
  // コードの形式・色の書き方・長さの単位。選び直しても、そのまま使う（ブラウザには保存しない）
  const [style, setStyle] = useState<CodeStyle>(DEFAULT_CODE_STYLE)
  // 打ち込み中の rem の基準。正の数になったときだけ style に入れる
  const [remText, setRemText] = useState(String(DEFAULT_CODE_STYLE.remBase))
  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => setCopied(null), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy(key: string, text: string) {
    if (await copyText(text)) setCopied(key)
  }

  const settings = (
    <div className="inspect-settings" aria-label="表示の設定">
      <label>
        形式
        <select
          aria-label="コードの形式"
          value={style.format}
          onChange={(event) => {
            setStyle({ ...style, format: event.target.value as CodeFormat })
            event.target.blur()
          }}
        >
          {Object.entries(CODE_FORMAT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        色
        <select
          aria-label="色の書き方"
          value={style.color}
          onChange={(event) => {
            setStyle({ ...style, color: event.target.value as ColorFormat })
            // フォーカスを残すとキーボードの操作が効かなくなる
            event.target.blur()
          }}
        >
          {Object.entries(COLOR_FORMAT_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        単位
        <select
          aria-label="長さの単位"
          value={style.unit}
          onChange={(event) => {
            setStyle({ ...style, unit: event.target.value === 'rem' ? 'rem' : 'px' })
            event.target.blur()
          }}
        >
          <option value="px">px</option>
          <option value="rem">rem</option>
        </select>
      </label>
      {style.unit === 'rem' && (
        <label title="1rem が何 px か">
          1rem =
          <input
            type="number"
            min={1}
            aria-label="1rem の大きさ（px）"
            value={remText}
            onChange={(event) => {
              setRemText(event.target.value)
              const value = Number(event.target.value)
              if (Number.isFinite(value) && value > 0) setStyle({ ...style, remBase: value })
            }}
            onBlur={() => setRemText(String(style.remBase))}
          />
          px
        </label>
      )}
    </div>
  )

  /** scope は、コピーの目印を、選んでいるものごとに分けるための名前 */
  const sections = (scope: string, list: InspectSection[]) =>
    list.map((section) => (
      <section key={section.title} className="panel-section" aria-label={section.title}>
        <h3 className="section-title">{section.title}</h3>
        <dl className="inspect-list">
          {section.rows.map((row, index) => {
            // 同じ名前の行が並ぶことがあるので、順番で見分ける
            const key = `${scope}/${section.title}/${index}`
            return (
              <div key={key} className="inspect-row">
                <dt>{row.label}</dt>
                <dd>
                  <button
                    type="button"
                    className="inspect-value"
                    title="クリックでコピー"
                    onClick={() => copy(key, row.value)}
                  >
                    {row.color && <span className="inspect-swatch" style={{ background: row.color }} />}
                    <span className="inspect-text">{copied === key ? 'コピーしました' : row.value}</span>
                  </button>
                  {row.nodes && (
                    <button
                      type="button"
                      className="inspect-pick"
                      title="これを使っている図形を選ぶ"
                      aria-label={`${row.value} を使っている図形を選ぶ`}
                      onClick={() => onSelectNodes(row.nodes!)}
                    >
                      選ぶ
                    </button>
                  )}
                </dd>
              </div>
            )
          })}
        </dl>
      </section>
    ))

  const selected = selection.filter((id) => Object.hasOwn(page.nodes, id))
  if (selected.length >= 2) {
    return (
      <aside className="panel inspect-panel" aria-label="インスペクト">
        <h2 className="panel-title">{selected.length} 個を選択</h2>
        <p className="panel-hint">
          {selected.length === 2
            ? '2 つの間隔をキャンバスに出しています。'
            : 'Shift を押しながら押すと、選択に足したり外したりできます。'}
        </p>
        {sections(`selection:${selected.join()}`, inspectSelection(page, selected))}
        <section className="panel-section" aria-label="選んでいるもの">
          <h3 className="section-title">選んでいるもの</h3>
          <ul className="inspect-selection">
            {selected.map((id) => (
              <li key={id}>
                <button type="button" className="list-button" onClick={() => onSelect(id)}>
                  {page.nodes[id].name}
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="panel-section" aria-label="書き出し">
          <h3 className="section-title">書き出し</h3>
          <ExportControls scale={scale} onScaleChange={onScaleChange} onExport={onExport} onExportSvg={onExportSvg} onCopySvg={onCopySvg}>
            まとめて PNG に
          </ExportControls>
        </section>
      </aside>
    )
  }

  const node = selected.length === 1 ? page.nodes[selected[0]] : undefined
  if (!node) {
    return (
      <aside className="panel inspect-panel" aria-label="インスペクト">
        <h2 className="panel-title">インスペクト</h2>
        <p className="panel-hint">
          図形をクリックすると、大きさ・色・文字の設定と CSS を確認できます。
          選んだまま別の図形にポインタを重ねると、その図形との間隔が出ます。
          Shift を押しながら押すと、いくつも選べます。
        </p>
        {settings}
        {sections(`page:${page.id}`, inspectPage(page, { ...style, variables: document.collections }))}
      </aside>
    )
  }

  // コードでは、変数につないだ色を var(--名前) で書く
  const codeStyle = { ...style, variables: document.collections }
  const code = nodeCode(page, node.id, codeStyle, document.assets)
  const cssKey = `${node.id}/css`
  // 中身のあるフレームは、子孫までまとめた HTML（形式が React なら JSX、Vue なら .vue ファイル）と CSS も出す
  const markup =
    node.type === 'frame' && node.children.length > 0
      ? nodeMarkup(page, node.id, { style: codeStyle, assets: document.assets, fonts: document.fonts })
      : null
  // コピー用の CSS の @font-face が指す書体ファイル（保存して HTML の隣に置く）
  const faces = nodeFontFaces(page, node.id, document.fonts, document.assets)
  const markupName = style.format === 'html' ? 'HTML' : style.format === 'vue' ? 'Vue' : 'JSX'
  const instance = instanceOf(page, node.id)
  const main = instance ? findMain(document, instance.component.id) : null
  return (
    <aside className="panel inspect-panel" aria-label="インスペクト">
      <h2 className="panel-title">{node.name}</h2>
      <p className="inspect-type">{TYPE_LABELS[nodeKind(node)]}</p>
      {settings}
      {sections(node.id, inspectNode(document, page, node.id, style.color))}
      {main && (
        <button
          type="button"
          className="inspect-action"
          title={main.page.id === page.id ? undefined : `ページ「${main.page.name}」にあります`}
          onClick={onGoToMain}
        >
          元のコンポーネントへ移動
        </button>
      )}
      <section className="panel-section" aria-label={code.title}>
        <h3 className="section-title">{code.title}</h3>
        <pre className="inspect-code">{code.code}</pre>
        <button type="button" onClick={() => copy(cssKey, code.code)}>
          {copied === cssKey ? 'コピーしました' : code.copyLabel}
        </button>
      </section>
      {markup && (
        <section className="panel-section" aria-label={markupName}>
          <h3 className="section-title">{markupName}（中身を含む）</h3>
          <pre className="inspect-code inspect-code-long">{markup.html}</pre>
          <button type="button" onClick={() => copy(`${node.id}/html`, markup.html)}>
            {copied === `${node.id}/html` ? 'コピーしました' : `${markupName} をコピー`}
          </button>
          {markup.css !== '' && (
            <>
              <pre className="inspect-code inspect-code-long">{markup.css}</pre>
              <button type="button" onClick={() => copy(`${node.id}/markup-css`, markup.css)}>
                {copied === `${node.id}/markup-css` ? 'コピーしました' : 'CSS をコピー'}
              </button>
            </>
          )}
          <button type="button" title="画像と書体を埋め込んだ HTML ファイルとして保存" onClick={() => onSaveHtml(style)}>
            HTML ファイルを保存
          </button>
        </section>
      )}
      <section className="panel-section" aria-label="書き出し">
        <h3 className="section-title">書き出し</h3>
        <ExportControls scale={scale} onScaleChange={onScaleChange} onExport={onExport} onExportSvg={onExportSvg} onCopySvg={onCopySvg}>
          PNG に書き出し
        </ExportControls>
        {node.type === 'image' && Object.hasOwn(document.assets, node.assetId) && (
          <button type="button" title="埋め込んである画像を、元の形式のまま保存" onClick={onSaveImage}>
            元の画像を保存
          </button>
        )}
        {faces.map((font) => {
          const fileName = fontFileName(font, document.assets[font.assetId].mime)
          return (
            <button
              key={`${font.assetId}/${font.family}/${font.weight}/${font.style}`}
              type="button"
              title={`kdr に埋め込んである書体のファイルを、元の形式のまま ${fileName} として保存（CSS の @font-face が指す名前）`}
              onClick={() => onSaveFont(font)}
            >
              書体ファイルを保存（{font.family} {font.weight}{font.style === 'italic' ? ' 斜体' : ''}）
            </button>
          )
        })}
      </section>
    </aside>
  )
}
