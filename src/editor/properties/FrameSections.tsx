import { isInstance } from '../../document/component.ts'
import type { AutoLayout, FrameNode, Sizing } from '../../document/types.ts'
import { ALIGN_CONTENT_LABELS, SIZING_LABELS, alignLabels, optionsOf } from '../../ui/labels.ts'
import { patchLayouts, setAutoLayoutEnabled, setFrameSizing, setLayoutWrap } from '../layout.ts'
import { type PanelContext, common } from './context.ts'
import { CheckField, NumberField, Section, SelectField } from './fields.tsx'

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

      <Section title="オートレイアウト">
        <CheckField
          label="中身を自動で並べる"
          value={common(frames.map((node) => node.layout !== null))}
          onChange={(checked) => store.apply((base) => setAutoLayoutEnabled(base, selection, checked))}
        />
        {layouts.length > 0 && (
          <>
            <SelectField
              label="向き"
              value={layoutValue('direction')}
              options={[
                ['horizontal', '横に並べる'],
                ['vertical', '縦に並べる'],
              ]}
              onChange={(direction) => setLayout({ direction })}
            />
            <NumberField label="間隔" value={layoutValue('gap')} onCommit={(gap) => setLayout({ gap })} />
            <div className="field-grid" aria-label="余白">
              {PADDING_FIELDS.map(([key, label]) => (
                <NumberField
                  key={key}
                  label={label}
                  value={layoutValue(key)}
                  min={0}
                  onCommit={(value) => setLayout({ [key]: value })}
                />
              ))}
            </div>
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
              options={[
                ['start', '先頭に寄せる'],
                ['center', '中央に寄せる'],
                ['end', '末尾に寄せる'],
                ['space-between', '均等に配る'],
              ]}
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
            {sizingField('width', '幅')}
            {sizingField('height', '高さ')}
          </>
        )}
      </Section>
    </>
  )
}
