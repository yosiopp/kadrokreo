import { isInstance } from '../../document/component.ts'
import type { AutoLayout } from '../../document/types.ts'
import { SIZE_MODE_LABELS, alignLabels, optionsOf } from '../../ui/labels.ts'
import { patchLayouts, setAutoLayoutEnabled, setLayoutWrap } from '../layout.ts'
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
  const frames = (inner ? [] : nodes).filter((node) => !isInstance(node)).filter((node) => node.type === 'frame')
  const allFrames = frames.length === nodes.length
  if (!allFrames) return null

  const layouts = frames.flatMap((node) => (node.layout ? [node.layout] : []))
  /** 設定項目 1 つの、選択中のフレームに共通の値 */
  const layoutValue = <K extends keyof AutoLayout>(key: K) => common(layouts.map((layout) => layout[key]))
  /** 自動で並べているフレームだけ、設定の一部を書き換える */
  const setLayout = (patch: Partial<AutoLayout>) => store.apply((base) => patchLayouts(base, selection, patch))

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
              <NumberField
                label="行の間隔"
                value={layoutValue('crossGap')}
                onCommit={(crossGap) => setLayout({ crossGap })}
              />
            )}
            <SelectField
              label="幅"
              value={layoutValue('widthMode')}
              options={optionsOf(SIZE_MODE_LABELS)}
              onChange={(widthMode) => setLayout({ widthMode })}
            />
            <SelectField
              label="高さ"
              value={layoutValue('heightMode')}
              options={optionsOf(SIZE_MODE_LABELS)}
              onChange={(heightMode) => setLayout({ heightMode })}
            />
          </>
        )}
      </Section>
    </>
  )
}
