import type { DesignDocument, FrameNode, RectNode, Scene, SceneNode, TextNode } from './types.ts'

// テストで使うノードの組み立て。editor の側にあるノードの生成（nodes.ts）は、共通側や viewer のテストからは使えない

export const base = {
  name: 'Node',
  parentId: null,
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  rotation: 0,
  visible: true,
  locked: false,
  opacity: 1,
  layoutFill: { width: false, height: false },
  layoutPositioning: 'auto' as const,
  minWidth: null,
  maxWidth: null,
  minHeight: null,
  maxHeight: null,
}
export const paint = { fill: '#ff0000', fillGradient: null, stroke: null, strokeWidth: 1, shadow: null }

export const rect = (patch: Partial<RectNode> = {}): RectNode => ({
  ...base,
  ...paint,
  id: 'rect',
  type: 'rect',
  cornerRadius: 0,
  ...patch,
})
export const frame = (patch: Partial<FrameNode> = {}): FrameNode => ({
  ...base,
  ...paint,
  id: 'frame',
  type: 'frame',
  children: [],
  clipContent: true,
  cornerRadius: 0,
  layout: null,
  component: null,
  ...patch,
})
export const text = (patch: Partial<TextNode> = {}): TextNode => ({
  ...base,
  id: 'text',
  type: 'text',
  text: 'こんにちは',
  fontSize: 16,
  fontFamily: 'sans-serif',
  fill: '#111111',
  autoWidth: true,
  fontWeight: 400,
  textAlign: 'left',
  lineHeight: 1.5,
  ...patch,
})

export function sceneOf(...nodes: SceneNode[]): Scene {
  return {
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    rootIds: nodes.filter((node) => node.parentId === null).map((node) => node.id),
  }
}

export function docOf(scene: Scene): DesignDocument {
  return {
    name: 'x',
    pages: [{ id: 'p1', name: 'Page 1', ...scene }],
    assets: { a1: { mime: 'image/png', data: '' } },
  }
}
