import { isInstance } from '../../document/component.ts'
import type { AutoLayout, FrameNode, LayoutGrid, Sizing } from '../../document/types.ts'
import { ALIGN_CONTENT_LABELS, SIZING_LABELS, alignLabels, optionsOf } from '../../ui/labels.ts'
import { gridColumnWidth, patchLayouts, setAutoLayoutEnabled, setFrameSizing, setLayoutMode, setLayoutWrap } from '../layout.ts'
import { MAX_GRID_COLUMNS } from '../../document/kdr.ts'
import { type Mixed, type PanelContext, common } from './context.ts'
import { CheckField, NumberField, Section, SelectField } from './fields.tsx'
import { DEFAULT_COLUMNS, MAX_LAYOUT_GRIDS } from '../layoutGrids.ts'

/** 余白の欄。上・右・下・左（CSS と同じ順） */
const PADDING_FIELDS = [
  ['paddingTop', '上'],
  ['paddingRight', '右'],
  ['paddingBottom', '下'],
  ['paddingLeft', '左'],
] as const

/** フレームとオートレイアウト。フレームだけを選んでいるときに出す */
export function FrameSections({ ctx }: { ctx: PanelContext }) {
  const { store, selection, nodes, apply, inner } = ctx
  // ブーリアン演算のノードは、はみ出し・自動で並べる・角丸に意味がないので、フレームの欄を出さない
  const frames = (inner ? [] : nodes).filter((node) => !isInstance(node)).filter((node): node is FrameNode => node.type === 'frame' && node.booleanOperation === null)
  const allFrames = frames.length === nodes.length
  if (!allFrames) return null

  const layouts = frames.flatMap((node) => (node.layout ? [node.layout] : []))
  /** 設定項目 1 つの、選択中のフレームに共通の値 */
  const layoutValue = <K extends keyof AutoLayout>(key: K) => common(layouts.map((layout) => layout[key]))
  /** 自動で並べているフレームだけ、設定の一部を書き換える */
  const setLayout = (patch: Partial<AutoLayout>) => store.apply((base) => patchLayouts(base, selection, patch))
  const laidOut = frames.filter((node) => node.layout)
  /** 大きさの決め方。親いっぱいは「親いっぱいに伸ばす」の欄で決めるので、いまそうなっているときだけ選択肢に出す */
  const sizingField = (axis: 'width' | 'height', label: string) => {
    const value = common(laidOut.map((node) => node.sizing[axis]))
    const options = optionsOf(SIZING_LABELS).filter(([key]) => key !== 'fill' || value === 'fill')
    return (
      <SelectField
        label={label}
        value={value}
        options={options}
        onChange={(sizing: Sizing) => store.apply((base) => setFrameSizing(base, selection, axis, sizing))}
      />
    )
  }

  return (
    <>
      <Section title="フレーム">
        <CheckField
          label="はみ出した中身を隠す"
          value={common(frames.map((node) => node.clipContent))}
          onChange={(checked) => apply({ clipContent: checked })}
        />
      </Section>

      <LayoutGridSection frames={frames} apply={apply} />

      <Section title="オートレイアウト">
        <CheckField
          label="中身を自動で並べる"
          value={common(frames.map((node) => node.layout !== null))}
          onChange={(checked) => store.apply((base) => setAutoLayoutEnabled(base, selection, checked))}
        />
        {layouts.length > 0 && (
          <>
            <SelectField
              label="並べ方"
              value={common(layouts.map((layout) => (layout.mode === 'grid' ? 'grid' : layout.direction)))}
              options={[
                ['horizontal', '横に並べる'],
                ['vertical', '縦に並べる'],
                ['grid', 'グリッド'],
              ]}
              onChange={(value) => store.apply((base) => setLayoutMode(base, selection, value))}
            />
            {layoutValue('mode') === 'grid' ? (
              <GridFields ctx={ctx} frames={laidOut} layoutValue={layoutValue} setLayout={setLayout} />
            ) : layoutValue('mode') === 'flex' ? (
              <FlexFields ctx={ctx} layoutValue={layoutValue} setLayout={setLayout} />
            ) : (
              // 並べ方が混ざっていれば、共通の余白だけ
              <PaddingFields layoutValue={layoutValue} setLayout={setLayout} />
            )}
            {sizingField('width', '幅')}
            {sizingField('height', '高さ')}
          </>
        )}
      </Section>
    </>
  )
}

/** 種類を変えたときの、新しい種類のグリッド（帯の数・溝・余白は、帯どうしなら引き継ぐ） */
/** 余白の 4 辺の欄 */
function PaddingFields({ layoutValue, setLayout }: Pick<LayoutFieldsProps, 'layoutValue' | 'setLayout'>) {
  return (
    <div className="field-grid" aria-label="余白">
      {PADDING_FIELDS.map(([key, label]) => (
        <NumberField key={key} label={label} value={layoutValue(key)} min={0} onCommit={(value) => setLayout({ [key]: value })} />
      ))}
    </div>
  )
}

type LayoutValue = <K extends keyof AutoLayout>(key: K) => AutoLayout[K] | Mixed
type LayoutFieldsProps = { ctx: PanelContext; layoutValue: LayoutValue; setLayout: (patch: Partial<AutoLayout>) => void }

/** 1 方向に並べるときの欄 */
function FlexFields({ ctx, layoutValue, setLayout }: LayoutFieldsProps) {
  const { store, selection } = ctx
  return (
    <>
      <NumberField label="間隔" value={layoutValue('gap')} onCommit={(gap) => setLayout({ gap })} />
      <PaddingFields layoutValue={layoutValue} setLayout={setLayout} />
      <SelectField
        label="揃え"
        value={layoutValue('align')}
        // 向きが混ざっているときは、横に並べるときの呼び名で出す
        options={optionsOf(alignLabels(layoutValue('direction') === 'vertical' ? 'vertical' : 'horizontal'))}
        onChange={(align) => setLayout({ align })}
      />
      <SelectField
        label="寄せ"
        value={layoutValue('justify')}
        options={optionsOf(JUSTIFY_LABELS)}
        onChange={(justify) => setLayout({ justify })}
      />
      <CheckField
        label="収まらなければ折り返す"
        value={layoutValue('wrap')}
        onChange={(checked) => store.apply((base) => setLayoutWrap(base, selection, checked))}
      />
      {layoutValue('wrap') === true && (
        <>
          <NumberField
            label="行の間隔"
            value={layoutValue('crossGap')}
            onCommit={(crossGap) => setLayout({ crossGap })}
          />
          <SelectField
            label="行の配置"
            value={layoutValue('alignContent')}
            options={optionsOf(ALIGN_CONTENT_LABELS)}
            onChange={(alignContent) => setLayout({ alignContent })}
          />
        </>
      )}
    </>
  )
}

/** グリッドで並べるときの欄 */
function GridFields({ frames, layoutValue, setLayout }: LayoutFieldsProps & { frames: FrameNode[] }) {
  const columnWidth = layoutValue('columnWidth')
  const widthMode = common(frames.map((node) => (node.layout?.columnWidth === null ? 'equal' : 'fixed')))
  return (
    <>
      <NumberField
        label="列の数"
        value={layoutValue('columns')}
        min={1}
        max={MAX_GRID_COLUMNS}
        onCommit={(columns) => setLayout({ columns: Math.min(MAX_GRID_COLUMNS, Math.max(1, Math.round(columns))) })}
      />
      <SelectField
        label="列の幅"
        value={widthMode}
        options={[
          ['equal', '等分する'],
          ['fixed', '固定'],
        ]}
        // 固定にするときは、いまの（等分した）幅から始める。複数なら最初のフレームの幅
        onChange={(mode) =>
          setLayout({ columnWidth: mode === 'equal' ? null : Math.max(1, Math.round(gridColumnWidth(frames[0]) ?? 100)) })
        }
      />
      {widthMode === 'fixed' && (
        <NumberField
          label="固定の幅"
          // 固定のときは、どのフレームも数値を持っている
          value={columnWidth as number | Mixed}
          min={1}
          onCommit={(width) => setLayout({ columnWidth: Math.max(1, width) })}
        />
      )}
      <div className="field-grid">
        <NumberField label="列の間隔" value={layoutValue('gap')} onCommit={(gap) => setLayout({ gap })} />
        <NumberField label="行の間隔" value={layoutValue('crossGap')} onCommit={(crossGap) => setLayout({ crossGap })} />
      </div>
      <PaddingFields layoutValue={layoutValue} setLayout={setLayout} />
      <SelectField
        label="揃え"
        value={layoutValue('align')}
        options={optionsOf(alignLabels('horizontal'))}
        onChange={(align) => setLayout({ align })}
      />
      {widthMode === 'fixed' && (
        <SelectField
          label="寄せ"
          value={layoutValue('justify')}
          options={optionsOf(JUSTIFY_LABELS)}
          onChange={(justify) => setLayout({ justify })}
        />
      )}
    </>
  )
}

/** 寄せ方の呼び名（1 方向の並びの寄せ方と、グリッドの列のまとまりの置き方） */
const JUSTIFY_LABELS: Record<AutoLayout['justify'], string> = {
  start: '先頭に寄せる',
  center: '中央に寄せる',
  end: '末尾に寄せる',
  'space-between': '均等に配る',
}

function withType(grid: LayoutGrid, type: LayoutGrid['type']): LayoutGrid {
  if (type === 'grid') return { type, size: 8 }
  return grid.type === 'grid' ? { ...DEFAULT_COLUMNS, type } : { ...grid, type }
}

/** レイアウトグリッド。フレームを 1 つだけ選んでいるときに、足す・変える・消す */
function LayoutGridSection({ frames, apply }: { frames: FrameNode[]; apply: PanelContext['apply'] }) {
  const single = frames.length === 1 ? frames[0] : null
  const grids = single?.layoutGrids ?? []
  const set = (next: LayoutGrid[]) => apply({ layoutGrids: next })
  const update = (index: number, grid: LayoutGrid) => set(grids.with(index, grid))
  const addButton = single && (
    <button
      type="button"
      className="icon-button"
      aria-label="レイアウトグリッドを足す"
      title="カラムのグリッドを足す"
      disabled={grids.length >= MAX_LAYOUT_GRIDS}
      onClick={() => set([...grids, DEFAULT_COLUMNS])}
    >
      +
    </button>
  )
  return (
    <Section title="レイアウトグリッド" action={addButton}>
      {!single ? (
        <p className="section-note">フレームを 1 つだけ選ぶと設定できます。</p>
      ) : (
        grids.map((grid, index) => (
          <div key={index} className="layout-grid-row" aria-label={`レイアウトグリッド ${index + 1}`}>
            <div className="field-row">
              <SelectField
                label="種類"
                value={grid.type}
                options={[
                  ['columns', 'カラム'],
                  ['rows', '行'],
                  ['grid', '方眼'],
                ]}
                onChange={(type: LayoutGrid['type']) => update(index, withType(grid, type))}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`レイアウトグリッド ${index + 1} を外す`}
                title="外す"
                onClick={() => set(grids.toSpliced(index, 1))}
              >
                −
              </button>
            </div>
            {grid.type === 'grid' ? (
              <NumberField label="間隔" value={grid.size} min={1} onCommit={(size) => update(index, { ...grid, size })} />
            ) : (
              <div className="field-grid">
                <NumberField label="数" value={grid.count} min={1} max={1000} onCommit={(count) => update(index, { ...grid, count: Math.round(count) })} />
                <NumberField label="溝" value={grid.gutter} min={0} onCommit={(gutter) => update(index, { ...grid, gutter })} />
                <NumberField label="余白" value={grid.margin} min={0} onCommit={(margin) => update(index, { ...grid, margin })} />
              </div>
            )}
          </div>
        ))
      )}
    </Section>
  )
}
