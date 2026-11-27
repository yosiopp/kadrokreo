export type NodeId = string
export type AssetId = string
export type PageId = string

/**
 * 1 つの向きの大きさの決め方。fixed は width / height のまま、hug は中身に合わせる、fill は親いっぱいに伸ばす。
 * hug は自動で並べるフレーム（layout があるもの）とテキストの幅だけが持てる（テキストの高さは常に hug）。
 * fill は親が自動で並べるときだけ効き、そうでなければ fixed と同じ（親を移しても残る）
 */
export type Sizing = 'fixed' | 'hug' | 'fill'

/**
 * 親の大きさが変わったときの、1 つの向きの追従のしかた（既存のデザインツールの constraints に当たる）。
 * start は先頭の辺（左・上）からの距離を保ち、end は末尾の辺（右・下）からの距離を保ち、
 * stretch は両方の辺からの距離を保って伸縮し、center は親の中心からのずれを保ち、scale は親と同じ割合で位置と大きさを変える
 */
export type Constraint = 'start' | 'end' | 'stretch' | 'center' | 'scale'

type BaseNode = {
  id: NodeId
  name: string
  /** null はページ直下。kdr ファイルには書かない（入れ子から決まる） */
  parentId: NodeId | null
  /** 親の左上を原点とする座標。回転していても、回す前の枠の左上を指す */
  x: number
  y: number
  width: number
  height: number
  /** 枠の中心を軸にした時計回りの角度（度）。子も一緒に回る */
  rotation: number
  visible: boolean
  locked: boolean
  opacity: number
  /**
   * ノードを後ろに見えているものへ重ねるときの描画モード。子を持つフレームは、中身を 1 枚の絵にまとめてから重ねる
   * （既存のデザインツールのフレームと同じ。子はフレームの中でだけ混ざる）
   */
  blendMode: BlendMode
  /**
   * 向きごとの大きさの決め方。fill は、並べる向きなら余った場所を分け合い、直交する向きなら余白の内側いっぱいになる
   */
  sizing: { width: Sizing; height: Sizing }
  /**
   * 自動で並べるフレームの子のとき、並びに加わるか（auto）、並びから外れて x / y のまま置かれるか（absolute）。
   * 親が自動で並べないなら意味はない
   */
  layoutPositioning: 'auto' | 'absolute'
  /**
   * 親のフレームの大きさが変わったときの追従のしかた。親が自動で並べないフレームか、並びから外した（absolute）ときだけ効く。
   * ページ直下のものや、並びに加わっている子では意味はない
   */
  constraints: { horizontal: Constraint; vertical: Constraint }
  /**
   * 大きさの下限と上限（null は決めない）。大きさを自動で決める向きでだけ効く:
   * fill で伸ばしている向きと、hug で中身に合わせている向き（`sizeLimited`）
   */
  minWidth: number | null
  maxWidth: number | null
  minHeight: number | null
  maxHeight: number | null
}

/**
 * グラデーションの色の位置。offset（0〜1）の小さい順に並べる。
 * opacity（0〜1）はその色の不透明度（SVG の stop-opacity）。色の間は透明度も滑らかにつなぐ。塗りの opacity とは別に重なる
 */
export type ColorStop = {
  offset: number
  color: string
  opacity: number
  /** 色をつないだ変数（color の変数の id）。あれば color はその変数を解決した値（document/variables.ts）。なければ持たない */
  variable?: VariableId
}

/**
 * 塗り（面・線・文字に使う）。色は #rrggbb。
 * linear は直線状のグラデーションで、始点 x1 / y1 と終点 x2 / y2 は枠の左上からの位置（枠の幅・高さに対する割合。0〜1 の外にも置ける）。
 * 始点が最初の色、終点が最後の色で、色が同じ線は始点から終点への線に（ピクセルで）垂直、外側は両端の色のまま（SVG の linearGradient と同じ）。
 * 向き（度）は始点から終点への向きで、0 が左から右、90 が上から下。向きだけを決めたときは、枠の中心を通り、枠の角がちょうど両端の色になる線にする
 * （paint.ts の linearFromAngle。CSS の linear-gradient の角度と同じ線）。
 * radial は円形（楕円）のグラデーションで、中心 cx / cy は枠の左上からの位置、半径 rx / ry は横・縦の半径で、
 * どれも枠の幅・高さに対する割合（SVG の objectBoundingBox、CSS の radial-gradient の % と同じ）。
 * 中心が最初の色、半径の楕円の上が最後の色で、その外は最後の色のまま。既定（枠に内接する楕円）は 0.5 が 4 つ。
 * angle は楕円を中心のまわりに回す角度（度、時計回り）。横・縦の半径をピクセル（rx × 幅、ry × 高さ）にしてから回すので、
 * rx は angle の向き、ry はそれに直交する向きの半径になる。0 なら回さない（軸に沿った楕円）。
 * fx / fy は焦点（最初の色が始まる点）で、中心からのずれを横・縦の半径に対する割合で持つ（楕円の軸に沿う。回せば一緒に回る）。
 * 0 / 0 なら中心と同じ（焦点なし）。楕円の中か上（fx² + fy² ≤ 1）に限る（SVG の radialGradient の fx / fy を、楕円の単位円で表したもの）。
 * conic は角度のグラデーション（CSS の conic-gradient）で、中心 cx / cy は radial と同じく枠に対する割合。
 * angle は最初の色を置く向き（度）で、直線の向きと同じく 0 が右、90 が下（時計回り）。CSS の `from` は angle + 90 になる。
 * 色の位置 0〜1 が、その向きから時計回りに 1 周する角度に当たる。
 * 円は枠の大きさによらず正円（ピクセルで角度を測る）。
 * opacity（0〜1）は塗りごとの不透明度で、色（グラデーションならすべての色）にかける。ノードの opacity とは別に重なる。
 * visible は塗りごとの表示（既存のデザインツールの目のアイコン）。false の塗りは描かず、CSS・SVG・色の一覧にも出さないが、消さずに残す。
 * blendMode は、その塗りを下（同じノードの下の塗りと、ノードの後ろに見えているもの）に重ねるときの描画モード。
 * 種類を足すときは type を増やす
 */
export type Paint = PaintCommon &
  (
    | {
        type: 'solid'
        color: string
        /** 色をつないだ変数（color の変数の id）。あれば color はその変数を解決した値（document/variables.ts）。なければ持たない */
        variable?: VariableId
      }
    | { type: 'linear'; x1: number; y1: number; x2: number; y2: number; stops: ColorStop[] }
    | { type: 'radial'; cx: number; cy: number; rx: number; ry: number; angle: number; fx: number; fy: number; stops: ColorStop[] }
    | { type: 'conic'; cx: number; cy: number; angle: number; stops: ColorStop[] }
  )

/** 塗りの種類によらない項目 */
export type PaintCommon = { opacity: number; visible: boolean; blendMode: BlendMode }

/**
 * 描画モード（既存のデザインツールの blend mode）。名前は CSS の mix-blend-mode と Canvas の globalCompositeOperation と同じ。
 * normal はふつうに重ねる
 */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity'

export type LinearGradient = Extract<Paint, { type: 'linear' }>
export type RadialGradient = Extract<Paint, { type: 'radial' }>
export type ConicGradient = Extract<Paint, { type: 'conic' }>
/** 色の位置を持つ塗り（グラデーション） */
export type Gradient = LinearGradient | RadialGradient | ConicGradient

/**
 * 効果。影（Shadow）とぼかし（Blur）がある。visible は効果ごとの表示（塗りの visible と同じ）。種類を足すときは type を増やす
 */
export type Effect = Shadow | Blur

/**
 * 影の効果。color は #rrggbb、濃さは opacity（0〜1）で持つ。
 * drop-shadow は図形の外に落ちる影（CSS の box-shadow）、inner-shadow は図形の内側の縁に付く影（box-shadow の inset）。
 * 内側の影は塗りの上・線の下に描き、図形の外へははみ出さない。
 * blur はぼかしの半径（CSS の box-shadow のぼかしと同じ。標準偏差はその半分）。
 * spread は影の広がり（CSS の box-shadow の spread と同じ）。落ち影は形をこの長さだけ太らせ（負なら細らせ）てから影にし、
 * 内側の影は縁から内へこの長さだけ影を広げる。
 * blendMode は、影を後ろ（ノードより先に描いてあるもの。内側の影なら塗り）に重ねるときの描画モード（既存のデザインツールの影の描画モード）。
 * CSS の box-shadow や SVG の filter には影ごとの描画モードがないので、Dev モードのコードと SVG の書き出しはふつうに重ねる
 */
export type Shadow = {
  type: 'drop-shadow' | 'inner-shadow'
  x: number
  y: number
  blur: number
  spread: number
  color: string
  /** 色をつないだ変数（color の変数の id）。あれば color はその変数を解決した値（document/variables.ts）。なければ持たない */
  variable?: VariableId
  opacity: number
  visible: boolean
  blendMode: BlendMode
}

/**
 * ぼかしの効果。layer-blur はノードそのもの（子を含む）をぼかし（CSS の filter: blur）、
 * background-blur はノードの形の内側で、後ろに見えているものをぼかす（CSS の backdrop-filter: blur。塗りが半透明のときに見える）。
 * blur はぼかしの半径で、影の blur と同じ長さ（CSS の blur() の値はその半分）
 */
export type Blur = {
  type: 'layer-blur' | 'background-blur'
  blur: number
  visible: boolean
}

/**
 * 図形の見た目。fills は下から順に重ねて塗る（先頭が一番下）。strokes も同じで、太さは strokeWidth の 1 つだけ。
 * effects も先頭から順にかける。どれも空の配列なら、その見た目はない
 */
export type Style = {
  fills: Paint[]
  strokes: Paint[]
  strokeWidth: number
  /**
   * 線の破線の並び（px。線を引く長さ・空ける長さを交互に。CSS・SVG の stroke-dasharray と同じで、数が奇数なら 2 回繰り返した並びになる）。
   * 空なら実線。線がなければ意味はない
   */
  strokeDashes: number[]
  /** 破線の並びを始める位置のずれ（px。CSS・SVG の stroke-dashoffset と同じで、正なら並びを線の進む向きと逆へずらす）。実線なら意味はない */
  strokeDashOffset: number
  /** 線の角の形（SVG の stroke-linejoin、Canvas の lineJoin と同じ）。角のない形（楕円・直線）では意味はない */
  strokeJoin: StrokeJoin
  effects: Effect[]
}

/** 線の角の形。miter はとがらせる（長すぎれば切り落とす）、round は丸める、bevel は切り落とす */
export type StrokeJoin = 'miter' | 'round' | 'bevel'

/**
 * 角丸の半径。数値なら 4 隅とも同じ。配列なら左上・右上・右下・左下の順（CSS の border-radius と同じ）。
 * 4 隅が同じ値なら数値で持つ（editor の操作がそう揃える。読み込みは配列のままでも受け付ける）
 */
export type CornerRadius = number | [number, number, number, number]

/**
 * マスクとして使うノード（既存のデザインツールの「マスクとして使う」）。isMask が true なら、自分は描かず、同じ親の中で自分より手前（children / rootIds で後ろ）にある兄弟を、
 * 次のマスクが現れるまで自分の形・絵で切り取る（document/mask.ts）。
 * 隠したマスク（visible が false）は何も切り取らないが、手前のマスクの範囲はそこで終わる。
 * 持てるのは矩形・楕円・パス・テキスト・画像・フレーム（ブーリアン演算のノードは持てても意味はない）
 */
export type Maskable = {
  isMask: boolean
  /**
   * マスクの種類（既存のデザインツールの mask type）。
   * vector は形だけで、塗りの色・不透明度・線・効果は見ない（パスは開いていても閉じた形、テキストは文字の形、画像・フレームは枠（角丸を含む）の形）。
   * alpha は塗りの不透明度（グラデーションの透明さ、画像の透明な所も）で透かし、luminance は塗りの明るさ（白が見え、黒が消える）に不透明度を掛けたもので透かす。
   * alpha / luminance ではノードの opacity も効き、線と効果は見ない（フレームは自分の塗りと子の絵。子は線・効果も含めてふつうに描いたもの）。
   * isMask が false なら意味はない
   */
  maskType: MaskType
}

export type MaskType = 'vector' | 'alpha' | 'luminance'

export type RectNode = BaseNode & Style & Maskable & { type: 'rect'; cornerRadius: CornerRadius }

export type EllipseNode = BaseNode & Style & Maskable & { type: 'ellipse' }

/**
 * 線の端の形。round / square は線の太さで決まる端（CSS・SVG の stroke-linecap と同じ形で、線の太さの半分だけ端の外へ出る）。
 * arrow / circle / diamond は端に付ける印で、大きさは capSize。矢印は先が端に来るよう線を短くし、丸とひし形は端を中心に置く
 */
export type Cap = 'none' | 'round' | 'square' | 'arrow' | 'circle' | 'diamond'

/**
 * パスの頂点。枠に対する割合（0〜1）で持つので、枠の大きさを変えれば形も一緒に伸縮する。
 * in / out は 3 次ベジェ曲線の制御点で、頂点からのずれ（同じく枠に対する割合）。in は前の頂点から来る辺、out は次の頂点へ向かう辺に効く。
 * 辺の両端の制御点がどちらもなければ、その辺は直線。片方だけなら、ないほうは頂点そのものを制御点とみなす（SVG の C と同じ）。
 * 枠は曲線そのものを囲む矩形なので、制御点は 0〜1 の外に出ることがある。
 * 省略できる項目で、kdr ファイルでもメモリ上でも、ないときは書かない（角の頂点）。
 * radius は角の丸めの半径（px。割合ではないので、枠の大きさを変えても丸めの大きさは変わらない）。0 より大きいときだけ書く。
 * 効くのは制御点を持たない頂点で、両側の辺が直線のときだけ（開いたパスの両端には効かない）。両側の辺の半分の長さまでに抑えて描く
 */
export type PathPoint = {
  x: number
  y: number
  in?: { x: number; y: number }
  out?: { x: number; y: number }
  radius?: number
}

/**
 * 頂点を直線か 3 次ベジェ曲線でつないだ線や形。直線も 2 つの頂点を持つ開いたパスで表す（`isLine`）。
 * 頂点の順に引くので、最初の頂点が始点、最後の頂点が終点。水平・垂直の直線は高さ・幅が 0 になる。
 */
export type PathNode = BaseNode &
  Style &
  Maskable & {
    type: 'path'
    points: PathPoint[]
    /** 最後の頂点と最初の頂点をつなぐ */
    closed: boolean
    startCap: Cap
    endCap: Cap
    /** 端の印（矢印・丸・ひし形）の大きさ（px、矢印なら長さ）。0 なら線の太さから決める（太さの 4 倍、最小 10） */
    capSize: number
    /**
     * 2 つ目以降の輪郭（穴や、離れた形）。頂点は points と同じく枠に対する割合で、枠はすべての輪郭を囲む。
     * 端の形（startCap / endCap）は最初の輪郭（points）にだけ付く。空なら輪郭は points の 1 つだけ
     */
    contours: PathContour[]
    /** 塗る範囲の決め方（SVG・Canvas の fill-rule と同じ）。輪郭が重なった所や自分と交わる所を、evenodd は偶奇で、nonzero は巻き数で決める */
    fillRule: 'nonzero' | 'evenodd'
  }

/** パスの 2 つ目以降の輪郭 */
export type PathContour = { points: PathPoint[]; closed: boolean }

/**
 * 字や絵そのものの裏返し（テキストと画像だけが持つ）。枠の中心を通る縦（flipX）・横（flipY）の線で中身を鏡に映して描く。
 * 枠の位置・大きさは変わらない（裏返しても枠は同じ矩形）。回転は裏返した後にかかる（CSS の transform: rotate() scale(-1, 1) と同じ順）。
 * 影のずれはほかの効果と同じくページの向きのままで、裏返さない
 */
export type Flippable = {
  flipX: boolean
  flipY: boolean
}

export type TextNode = BaseNode &
  Maskable & {
  type: 'text'
  /** 効果（Style の effects と同じ）。内側の影は文字の形の内側に描く（CSS の text-shadow では表せないので、Dev モードのコードには含めない） */
  effects: Effect[]
  text: string
  fontSize: number
  fontFamily: string
  /** 文字の塗り。先頭が一番下 */
  fills: Paint[]
  /** 100〜900 の 100 刻み（CSS の font-weight と同じ） */
  fontWeight: number
  textAlign: 'left' | 'center' | 'right'
  /** 行の高さ。fontSize に対する倍率 */
  lineHeight: number
  /**
   * 字間（px。CSS の letter-spacing と同じ）。文字（書記素のまとまり）ごとに、その後ろへ足す。行の最後の文字の後ろにも足すので、
   * 行の幅・折り返し・中身に合わせる大きさに効く。負の値は詰める。0 は書体のまま
   */
  letterSpacing: number
  /**
   * 文字の装飾（CSS の text-decoration-line と同じ）。underline は下線、line-through は取り消し線。線の色は文字の塗り、
   * 長さは行の幅（字間を含む）。線に沿う文字では文字ごとに線を引く。1 つのテキストの一部だけには付けられない
   */
  textDecoration: 'none' | 'underline' | 'line-through'
  /**
   * 文字を沿わせる線（SVG の textPath）。null ならふつうに行に並べる。
   * 沿わせるときは改行を空白として 1 行に並べ、折り返し・行の高さ・大きさの決め方（sizing）は効かない。枠は線を囲む矩形で、線と一緒に伸縮する
   */
  textPath: TextPath | null
} & Flippable

/**
 * テキストを沿わせる線。文字の基線を線に乗せ、1 文字ずつ線の向きに回して並べる（SVG の textPath と同じ置き方）。
 * points はパスの頂点（PathPoint）と同じく、テキストの枠に対する割合。startOffset は並べ始める位置で、線の長さに対する割合（0〜1。SVG の startOffset の %）。
 * 行揃え（textAlign）はこの位置に文字の並びのどこを合わせるか（left は始まり、center は真ん中、right は終わり。SVG の text-anchor）。
 * 線の外（始まりより前、終わりより後）に出た文字は描かない
 */
export type TextPath = {
  points: PathPoint[]
  closed: boolean
  startOffset: number
}

/**
 * fit は、枠と画像の縦横比が違うときの収め方。
 * cover は枠を埋めてはみ出した分を切り落とし、contain は全体が入るよう余白を空け、stretch は引き伸ばす。
 */
export type ImageNode = BaseNode &
  Maskable & {
  type: 'image'
  /** 効果（Style の effects と同じ）。影は枠（角丸を含む）の形に付く */
  effects: Effect[]
  assetId: AssetId
  cornerRadius: CornerRadius
  fit: 'stretch' | 'cover' | 'contain'
  /**
   * 画像を枠のどこに寄せるか（0〜1。CSS の object-position の % と同じ）。0 は左（上）端、1 は右（下）端、0.5 は中央。
   * cover では切り抜く位置（はみ出した分のどこを残すか）、contain では余白の配り方になる。stretch では意味はない
   */
  positionX: number
  positionY: number
  /**
   * 切り抜きの拡大（1 以上。既存のデザインツールの crop の大きさ）。fit で決まる画像の大きさをこの倍率で大きくし、
   * positionX / positionY の割合で寄せて、枠からはみ出した分を切り落とす。1 は拡大しない
   */
  scale: number
} & Flippable

/**
 * フレームの中身を自動で並べる設定。子は children の順に、direction の向きへ並ぶ。
 * 並べた結果の位置と大きさは各ノードの x / y / width / height にも入っているので、
 * 表示するだけなら、この設定を読まなくてよい。フレーム自身の大きさの決め方は sizing にある。
 */
export type AutoLayout = {
  direction: 'horizontal' | 'vertical'
  /** 子と子の間隔 */
  gap: number
  /** 内側の余白 */
  paddingTop: number
  paddingRight: number
  paddingBottom: number
  paddingLeft: number
  /** 並べる向きと直交する向きの揃え方 */
  align: 'start' | 'center' | 'end'
  /** 並べる向きの寄せ方。並べる向きの大きさが中身に合わせる（hug）でないときだけ意味がある */
  justify: 'start' | 'center' | 'end' | 'space-between'
  /**
   * 並べる向きに収まらない子を、次の行（縦に並べるなら次の列）へ折り返すか。
   * 並べる向きの大きさが中身に合わせる（hug）なら折り返さない
   */
  wrap: boolean
  /** 折り返したときの、行と行の間隔 */
  crossGap: number
  /**
   * 折り返したときの、行のまとまりの置き方（CSS の align-content）。auto は align に従って寄せ、
   * space-between は直交する向きの余りを行の間に均等に配る。折り返さないなら意味はない
   */
  alignContent: 'auto' | 'space-between'
}

/**
 * コンポーネントとのつながり。main は部品の元になるフレームで、instance はそれを配置したもの。
 * instance の中身（子孫と見た目）は main の写しで、main を変えると作り直される。
 * 写しは普通のノードとしてページに入っているので、表示するだけなら、このつながりを読まなくてよい。
 */
export type ComponentLink =
  /** id はドキュメントの中で一意。main と、その instance が同じ値を持つ */
  | {
      id: string
      role: 'main'
      /** コンポーネントの説明文（使い方など）。空ならなし */
      description: string
      /** コンポーネントのプロパティ。名前は main の中で一意 */
      properties: ComponentProperty[]
      /**
       * 実装側の部品（viewer のコードで、インスタンスをこの部品の呼び出しとして出す）。null なら対応なし（中身を展開する）。
       * バリアント（まとまりの中の元）では使わず、まとまりのフレームの setCode を使う
       */
      code: CodeComponent | null
    }
  | {
      id: string
      role: 'instance'
      /**
       * このインスタンスだけの上書き。キーは main の側のノードの id（main 自身の id なら、インスタンスの根への上書き）。
       * 上書きした結果も写しに入っているので、表示するだけなら読まなくてよい。
       */
      overrides: Record<NodeId, Override>
      /**
       * 中身を元から鏡に映した写しにするか。flipX はインスタンスの枠の中心を通る縦の線、flipY は横の線で、
       * 写し（子孫の位置と角度・パスの形・角丸・グラデーション・影のずれ・テキストと画像の裏返し）を映す。
       * 写しには映した結果が入っているので、表示するだけなら読まなくてよい（描画の変換には入らない）。
       * 上書きの値は映す前の（元の向きの）値で持つ
       */
      flipX: boolean
      flipY: boolean
    }

/**
 * コンポーネントのプロパティ（既存のデザインツールのコンポーネントプロパティ）。main の中のノードに結び、インスタンスごとに値を選べる。
 * インスタンスでの値は、結んだノードへの上書き（Override）そのもので、別には持たない。既定値は main での値。
 * バリアントのプロパティは名前（`プロパティ=値`）で表すので、ここには入れない。
 */
export type ComponentProperty = {
  name: string
  /**
   * text: 結んだテキストの文言（上書きの text）、boolean: 結んだノードの表示（上書きの visible）、
   * instance: 結んだ入れ子のインスタンスの元（上書きの componentId）。種類の合わないノードは無視する
   */
  type: 'text' | 'boolean' | 'instance'
  /**
   * 結んだノード。main の中のノード（上書きのキーと同じ、main の側の id）。main の中に置いた入れ子のインスタンスの中身（写し）も結べる
   * （文言・表示だけ）。main の外や、ないノードは無視する
   */
  targets: NodeId[]
  /**
   * 差し替え（instance）のプロパティで、インスタンスで選ぶ欄の先頭に出すコンポーネントの id（既存のデザインツールの preferred values）。
   * ほかのコンポーネントも選べる。instance 以外では意味はない。ないコンポーネントは無視する
   */
  preferred: string[]
}

/**
 * コンポーネントに対応する、実装側の部品（React・Vue のコンポーネント）。viewer のコード（document/codeComponent.ts）が、
 * インスタンスを `<name props…>` の呼び出しと import として出す
 */
export type CodeComponent = {
  /** 部品の名前（JSX・Vue のタグ名）。英大文字で始まる識別子か、. でつないだもの（UI.Button。import するのは先頭の UI） */
  name: string
  /** import の場所（モジュールの指定子）。空なら import を書かない */
  from: string
  /** true なら既定の export（import Button from …）、false なら名前付き（import { Button } from …） */
  defaultExport: boolean
  /** プロパティから props への読み替え。property は一意。ここにないプロパティは、名前から props の名前を作る */
  props: CodeProp[]
}

/** コンポーネントのプロパティ（バリアントのプロパティも）から、部品の props への読み替え */
export type CodeProp = {
  /** コンポーネントのプロパティの名前。バリアントのプロパティなら `プロパティ=値` のプロパティの側 */
  property: string
  /** 写す先の props の名前。'children' なら中身（Vue は既定のスロット）にする。空なら写さない */
  prop: string
  /** バリアントのプロパティの値の読み替え（kdr の値 → props の値）。ここにない値はそのまま。ほかの種類では意味はない */
  values: Record<string, string>
}

/**
 * main の値の代わりに使う値。指定した項目だけが変わる。
 * そのノードが持たない項目は無視する。
 */
export type Override = {
  text?: string
  fills?: Paint[]
  strokes?: Paint[]
  /** 破線の並び（Style の strokeDashes と同じ。空なら実線に戻す） */
  strokeDashes?: number[]
  /** 破線のずれ（Style の strokeDashOffset と同じ） */
  strokeDashOffset?: number
  visible?: boolean
  /** テキストの書式。大きさは、写しを作り直すときに測り直す */
  fontSize?: number
  fontFamily?: string
  fontWeight?: number
  /** 字間・文字の装飾（TextNode と同じ）。行の高さ・行揃えは段落の書式なので上書きできない */
  letterSpacing?: number
  textDecoration?: TextNode['textDecoration']
  /** 画像の差し替え。ドキュメントの assets にあるもの */
  assetId?: AssetId
  /** テキスト・画像の裏返し（Flippable と同じ） */
  flipX?: boolean
  flipY?: boolean
  /**
   * 入れ子のインスタンスの差し替え。キーのノードが main の中に置いたインスタンスのとき、
   * そこをこの id のコンポーネントのインスタンスにする。そのほかのノードや、元が見つからない・循環するときは無視する
   */
  componentId?: string
}

export type FrameNode = BaseNode &
  Style &
  Maskable & {
    type: 'frame'
    /** 先頭が最背面。自動で並べるときは、先頭から順に並ぶ */
    children: NodeId[]
    clipContent: boolean
    /**
     * 通過（既存のデザインツールの pass through）。true なら、半透明でも中身をまとめずに、子をそれぞれ後ろと直接混ぜる
     * （子の描画モードや背景のぼかしがフレームの後ろにも効く）。不透明度は、混ぜた結果と後ろの間で効く。
     * 描画モード（blendMode）が normal でなければ意味はない（まとめてから混ぜる）。不透明なら false と同じ見た目
     */
    passThrough: boolean
    cornerRadius: CornerRadius
    layout: AutoLayout | null
    component: ComponentLink | null
    /**
     * バリアントのまとまりの説明文（使い方など）。空ならなし。このフレームがバリアントのまとまり
     * （document/variants.ts の isVariantSet）でなければ意味はない。バリアントそれぞれの説明は component.description
     */
    setDescription: string
    /**
     * バリアントのまとまりに対応する実装側の部品。null なら対応なし。このフレームがバリアントのまとまりでなければ意味はない。
     * まとまりの中のバリアントのインスタンスは、これだけを使う（バリアントの component.code は使わない）
     */
    setCode: CodeComponent | null
    /**
     * ブーリアン演算のノード（既存のデザインツールの boolean operation）にするときの演算。null なら普通のフレーム。
     * 演算のノードは子を描かず、表示している子（矩形・楕円・パス・画像の枠・フレームの枠・入れ子の演算のノード。テキストは入らない）の形に
     * 演算をかけた結果を、このフレームの塗り・線・効果で描く（document/booleanNode.ts）。子を変えれば結果も変わる。
     * union は合体、subtract は最背面の子から残りを引く、intersect は交差、exclude は除外。
     * 演算のノードでは layout は null で、clipContent と cornerRadius は意味はない。枠は editor が結果を囲む矩形に合わせる
     */
    booleanOperation: BooleanOperation | null
    /**
     * ブーリアン演算のノードで、子の線の形も演算に含めるか。true なら、子ごとに線を輪郭化した形（document/outlineStroke.ts）を
     * 子の形に合体してから演算する（線の外形まで結果に入る）。false なら子の形だけ。演算のノードでなければ意味はない
     */
    booleanIncludeStrokes: boolean
    /**
     * 変数のモードの指定（コレクションの id → モードの id）。中のノードは、自分から上へたどって最初に指定のあるフレーム、
     * 無ければページ、それも無ければコレクションの最初のモードで変数を解決する。指定が無ければ持たない（空にしない）
     */
    modes?: ModeSelection
    /**
     * レイアウトグリッド（カラム・行・方眼）。editor でフレームに重ねて出し、図形の吸着の相手にする。描画・書き出し・viewer には効かない。
     * 空ならなし。並びは足した順
     */
    layoutGrids: LayoutGrid[]
  }

/**
 * フレームのレイアウトグリッド 1 つ。columns は縦の帯（カラム）、rows は横の帯（行）で、count 本の帯を、
 * フレームの両端から margin ずつ空けた内側に gutter（溝）を挟んで均等に並べる。grid は size 間隔の方眼（左上から）
 */
export type LayoutGrid =
  | { type: 'columns' | 'rows'; count: number; gutter: number; margin: number }
  | { type: 'grid'; size: number }

/** ブーリアン演算の種類（document/pathBoolean.ts の BooleanOp と同じ） */
export type BooleanOperation = 'union' | 'subtract' | 'intersect' | 'exclude'

export type SceneNode =
  | RectNode
  | EllipseNode
  | PathNode
  | TextNode
  | FrameNode
  | ImageNode

/**
 * 埋め込みファイル（画像か書体の元のファイルそのもの）。id は中身の SHA-256（document/sha256.ts）。
 * kdr では tar の assets/<id>.<拡張子> に入る。メモリ上も自動保存（IndexedDB）でもバイト列のまま持つ（base64 にしない）。
 * 画像のノード（と上書き）は画像の mime のものだけを、埋め込んだ書体（EmbeddedFont）は書体の mime のものだけを指す
 */
export type Asset = { mime: string; bytes: Uint8Array<ArrayBuffer> }

/**
 * ドキュメントに埋め込んだ書体。テキストの書体名（fontFamily）の先頭が family と同じなら、OS やブラウザの書体より先にこれで描く。
 * family・weight・style は書体ファイルの name / OS/2 の表から読んだ値（document/fontFile.ts）。
 * 同じ family・weight・style の組は 1 つだけ。再配布できる書体（SIL Open Font License など）だけを入れる前提で、ファイルは手を加えずに持つ
 */
export type EmbeddedFont = {
  /** 書体ファイル。ドキュメントの assets にある書体の mime のもの */
  assetId: AssetId
  family: string
  /** 100〜900 の 100 刻み */
  weight: number
  style: 'normal' | 'italic'
}

/** 1 ページ分のノードの木 */
export type Scene = {
  nodes: Record<NodeId, SceneNode>
  /** ページ直下のノード。先頭が最背面 */
  rootIds: NodeId[]
}

/** ページごとに独立したキャンバスを持つ。ノードの id はページの中で一意であればよい */
export type Page = Scene & {
  id: PageId
  name: string
  /** ルーラーから引き出して置いたガイド線（editor で吸着の相手になる。書き出しには出ない）。並びは置いた順 */
  guides: PageGuide[]
  /** ページ全体の変数のモードの指定（FrameNode の modes と同じ。指定が無ければ持たない） */
  modes?: ModeSelection
}

/** ページのガイド線。axis が 'x' なら x = position の縦の線、'y' なら y = position の横の線（ページ座標） */
export type PageGuide = { axis: 'x' | 'y'; position: number }

export type CollectionId = string
export type ModeId = string
export type VariableId = string

/** 変数のモードの指定。コレクションの id → そのコレクションのモードの id */
export type ModeSelection = Record<CollectionId, ModeId>

/** 変数の種類。color は #rrggbb */
export type VariableType = 'color' | 'number' | 'string' | 'boolean'

/** 変数の 1 つのモードの値。{ alias } は同じ種類の別の変数を指す（別名。別のコレクションの変数も指せる） */
export type VariableValue = string | number | boolean | { alias: VariableId }

/**
 * 名前の付いた値（デザイントークン）。name の / はグループの区切り（color/primary）で、コレクションの中で一意。
 * values はコレクションのモードの id ごとの値で、どのモードにもある
 */
export type Variable = { id: VariableId; name: string; type: VariableType; values: Record<ModeId, VariableValue> }

export type VariableMode = { id: ModeId; name: string }

/**
 * 変数のまとまり。モード（ライト / ダークなど）の並びを持ち、変数はモードごとに値を持つ。modes は 1 つ以上で、先頭が既定のモード。
 * コレクション・モード・変数の id はドキュメント全体で一意
 */
export type VariableCollection = { id: CollectionId; name: string; modes: VariableMode[]; variables: Variable[] }

export type DesignDocument = {
  name: string
  /** 必ず 1 ページ以上ある */
  pages: Page[]
  /** 全ページで共有する */
  assets: Record<AssetId, Asset>
  /** 埋め込んだ書体。全ページで共有する。並びは取り込んだ順 */
  fonts: EmbeddedFont[]
  /** 変数のコレクション。全ページで共有する */
  collections: VariableCollection[]
}
