export type NodeId = string

type BaseNode = {
  id: NodeId
  name: string
  /** null はページ直下 */
  parentId: NodeId | null
  /** 親の左上を原点とする座標 */
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  locked: boolean
  opacity: number
}

type Paint = {
  fill: string | null
  stroke: string | null
  strokeWidth: number
}

export type RectNode = BaseNode & Paint & { type: 'rect'; cornerRadius: number }

export type EllipseNode = BaseNode & Paint & { type: 'ellipse' }

export type TextNode = BaseNode & {
  type: 'text'
  text: string
  fontSize: number
  fontFamily: string
  fill: string
}

export type FrameNode = BaseNode &
  Paint & {
    type: 'frame'
    /** 先頭が最背面 */
    children: NodeId[]
    clipContent: boolean
  }

export type SceneNode = RectNode | EllipseNode | TextNode | FrameNode

export type DesignDocument = {
  name: string
  nodes: Record<NodeId, SceneNode>
  /** ページ直下のノード。先頭が最背面 */
  rootIds: NodeId[]
}
