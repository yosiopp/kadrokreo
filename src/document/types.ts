export type NodeId = string
export type AssetId = string
export type PageId = string

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

/** 落ち影。color は #rrggbb、濃さは opacity（0〜1）で持つ */
export type Shadow = {
  x: number
  y: number
  blur: number
  color: string
  opacity: number
}

type Paint = {
  fill: string | null
  stroke: string | null
  strokeWidth: number
  shadow: Shadow | null
}

export type RectNode = BaseNode & Paint & { type: 'rect'; cornerRadius: number }

export type EllipseNode = BaseNode & Paint & { type: 'ellipse' }

/**
 * 枠の対角線として描く直線。down は左上から右下、up は左下から右上。
 * 水平・垂直の線は高さ・幅が 0 になる。
 */
export type LineNode = BaseNode & {
  type: 'line'
  stroke: string
  strokeWidth: number
  direction: 'down' | 'up'
}

export type TextNode = BaseNode & {
  type: 'text'
  text: string
  fontSize: number
  fontFamily: string
  fill: string
  /** true なら折り返さず、幅は中身に合わせる。false なら width で折り返す。高さはどちらも中身で決まる */
  autoWidth: boolean
  fontWeight: 400 | 700
  textAlign: 'left' | 'center' | 'right'
  /** 行の高さ。fontSize に対する倍率 */
  lineHeight: number
}

/** 画像は枠いっぱいに引き伸ばして描く */
export type ImageNode = BaseNode & { type: 'image'; assetId: AssetId; cornerRadius: number }

export type FrameNode = BaseNode &
  Paint & {
    type: 'frame'
    /** 先頭が最背面 */
    children: NodeId[]
    clipContent: boolean
    cornerRadius: number
  }

export type SceneNode = RectNode | EllipseNode | LineNode | TextNode | FrameNode | ImageNode

/** 埋め込みファイル。kdr は 1 つの JSON なので、中身は base64 で持つ */
export type Asset = { mime: string; data: string }

/** 1 ページ分のノードの木 */
export type Scene = {
  nodes: Record<NodeId, SceneNode>
  /** ページ直下のノード。先頭が最背面 */
  rootIds: NodeId[]
}

/** ページごとに独立したキャンバスを持つ。ノードの id はページの中で一意であればよい */
export type Page = Scene & { id: PageId; name: string }

export type DesignDocument = {
  name: string
  /** 必ず 1 ページ以上ある */
  pages: Page[]
  /** 全ページで共有する */
  assets: Record<AssetId, Asset>
}
