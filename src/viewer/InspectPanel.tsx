import { useEffect, useState } from 'react'
import type { DesignDocument, NodeId, Page } from '../document/types.ts'
import { ExportControls } from '../ui/ExportControls.tsx'
import { copyText } from '../ui/clipboard.ts'
import { TYPE_LABELS, inspectNode, nodeCss } from './inspect.ts'

type Props = {
  document: DesignDocument
  page: Page
  /** 選んでいるノード。何も選んでいなければ null */
  selectedId: NodeId | null
  scale: number
  onScaleChange: (scale: number) => void
  /** 選んでいるノードを PNG に書き出す */
  onExport: () => void
}

/** 選んだノードの設定と CSS を見せるパネル。値は、押すとコピーできる */
export function InspectPanel({ document, page, selectedId, scale, onScaleChange, onExport }: Props) {
  // コピーした値の目印（どの行か）。少しのあいだ「コピーしました」と出す
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    if (copied === null) return
    const timer = setTimeout(() => setCopied(null), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  const node = selectedId === null ? undefined : page.nodes[selectedId]
  if (!node) {
    return (
      <aside className="panel inspect-panel" aria-label="インスペクト">
        <h2 className="panel-title">インスペクト</h2>
        <p className="panel-hint">
          図形をクリックすると、大きさ・色・文字の設定と CSS を確認できます。
          選んだまま別の図形にポインタを重ねると、その図形との間隔が出ます。
        </p>
      </aside>
    )
  }

  async function copy(key: string, text: string) {
    if (await copyText(text)) setCopied(key)
  }

  const css = nodeCss(page, node.id)
  return (
    <aside className="panel inspect-panel" aria-label="インスペクト">
      <h2 className="panel-title">{node.name}</h2>
      <p className="inspect-type">{TYPE_LABELS[node.type]}</p>
      {inspectNode(document, page, node.id).map((section) => (
        <section key={section.title} className="panel-section" aria-label={section.title}>
          <h3 className="section-title">{section.title}</h3>
          <dl className="inspect-list">
            {section.rows.map((row) => {
              const key = `${section.title}/${row.label}`
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
                  </dd>
                </div>
              )
            })}
          </dl>
        </section>
      ))}
      <section className="panel-section" aria-label="CSS">
        <h3 className="section-title">CSS</h3>
        <pre className="inspect-code">{css}</pre>
        <button type="button" onClick={() => copy('css', css)}>
          {copied === 'css' ? 'コピーしました' : 'CSS をコピー'}
        </button>
      </section>
      <section className="panel-section" aria-label="書き出し">
        <h3 className="section-title">書き出し</h3>
        <ExportControls scale={scale} onScaleChange={onScaleChange} onExport={onExport}>
          PNG に書き出し
        </ExportControls>
      </section>
    </aside>
  )
}
