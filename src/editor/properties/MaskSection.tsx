import { BOOLEAN_OPERATION_LABELS, isBooleanNode } from '../../document/booleanNode.ts'
import { canMask } from '../../document/mask.ts'
import type { BooleanOperation, MaskType } from '../../document/types.ts'
import { setBooleanOperation } from '../operations/booleanNodes.ts'
import { MASK_TYPE_LABELS } from '../../ui/labels.ts'
import { type PanelContext, common } from './context.ts'
import { CheckField, Section, SelectField } from './fields.tsx'

const MASK_HINTS: Record<MaskType, string> = {
  vector: 'この形は描かれず、同じ親の中で手前にあるものを、次のマスクまでこの形で切り取ります。',
  alpha: 'この形は描かれず、手前にあるものを、この形の塗りの不透明度で透かします（グラデーションの透明さも効きます）。',
  luminance: 'この形は描かれず、手前にあるものを、この形の塗りの明るさで透かします（白は見え、黒は消えます）。',
}

/** マスクとして使うか（矩形・楕円・パスだけ）と、マスクの種類。マスクは描かれず、同じ親の中で手前にある兄弟を、次のマスクまで切り取る */
export function MaskSection({ ctx }: { ctx: PanelContext }) {
  const { nodes, apply, inner } = ctx
  if (inner || !nodes.every(canMask)) return null
  const masks = nodes.filter(canMask)
  const value = common(masks.map((node) => node.isMask))
  const type = common(masks.map((node) => node.maskType))
  return (
    <Section title="マスク">
      <CheckField label="マスクとして使う" value={value} onChange={(checked) => apply({ isMask: checked })} />
      {value === true && (
        <SelectField
          label="種類"
          value={type}
          options={Object.entries(MASK_TYPE_LABELS) as [MaskType, string][]}
          onChange={(maskType: MaskType) => apply({ maskType })}
        />
      )}
      {value === true && typeof type === 'string' && type in MASK_HINTS && <p className="panel-hint">{MASK_HINTS[type as MaskType]}</p>}
    </Section>
  )
}

/** ブーリアン演算のノードの演算。元の図形（子）を変えると結果も変わる */
export function BooleanSection({ ctx }: { ctx: PanelContext }) {
  const { nodes, store, selection, inner } = ctx
  if (inner || !nodes.every(isBooleanNode)) return null
  const op = common(nodes.flatMap((node) => (isBooleanNode(node) ? [node.booleanOperation] : [])))
  return (
    <Section title="ブーリアン演算">
      <SelectField
        label="演算"
        value={op}
        options={Object.entries(BOOLEAN_OPERATION_LABELS) as [BooleanOperation, string][]}
        onChange={(value: BooleanOperation) => store.apply((base) => setBooleanOperation(base, selection, value))}
      />
      <p className="panel-hint">元の図形は子として残っています。ダブルクリックで選んで動かすと、結果も変わります。</p>
    </Section>
  )
}
