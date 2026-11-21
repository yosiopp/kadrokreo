"""kadrokreo のロゴ（ワードマークとシンボル）の SVG を作る。文字はすべてアウトライン化する。

書体は Red Hat Display ExtraBold（SIL Open Font License）。フォントファイルはリポジトリに入れていないので、
Google Fonts のリポジトリから可変フォントを取ってきて、そのパスを渡す:

    curl -LO 'https://github.com/google/fonts/raw/main/ofl/redhatdisplay/RedHatDisplay%5Bwght%5D.ttf'
    pip install fonttools uharfbuzz
    python docs/logo/build.py 'RedHatDisplay[wght].ttf'

出力:
    docs/logo/*.svg        … ロゴの原本（ワードマーク明・暗、シンボル、組み合わせ）
    public/favicon.svg     … シンボル
    src/ui/logoPaths.ts    … 画面のヘッダーに出すワードマークのパス
"""

import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "logo"

WEIGHT = 800
TRACKING = -0.035  # em
INK = "#16161d"
ACCENT = "#5b4cf5"
TINT = "#a99fff"  # 暗い背景での反転 k
WHITE = "#ffffff"
MIRRORED = 5  # "kadrokreo" の 6 文字目（kreo の k）を左右反転する


def load(path):
    data = Path(path).read_bytes()
    face = hb.Face(data)
    font = hb.Font(face)
    font.set_variations({"wght": WEIGHT})
    tt = instantiateVariableFont(TTFont(path), {"wght": WEIGHT})
    return font, tt


def shape(font, text):
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, {"kern": True, "liga": False})
    return buf.glyph_infos, buf.glyph_positions


def glyph_paths(font, tt, text, size, mirrored=()):
    """文字列を並べ、文字ごとの (パス, 反転したか) と全体の外接矩形を返す。ベースライン y=0、上が負。"""
    upem = tt["head"].unitsPerEm
    s = size / upem
    gs = tt.getGlyphSet()
    order = tt.getGlyphOrder()
    infos, positions = shape(font, text)
    x = 0.0
    out = []
    bounds = BoundsPen(gs)
    for i, (info, pos) in enumerate(zip(infos, positions)):
        name = order[info.codepoint]
        adv = pos.x_advance * s
        if i in mirrored:
            t = (-s, 0, 0, -s, x + adv, 0)  # 字幅の中で反転する
        else:
            t = (s, 0, 0, -s, x + pos.x_offset * s, -pos.y_offset * s)
        pen = SVGPathPen(gs, ntos=lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
        gs[name].draw(TransformPen(pen, t))
        gs[name].draw(TransformPen(bounds, t))
        out.append((pen.getCommands(), i in mirrored))
        x += adv + TRACKING * size
    return out, bounds.bounds


def wordmark(font, tt, size=100):
    """ワードマークを (インク部分のパス, 反転 k のパス, 幅, 高さ) で返す。外接矩形の左上を原点にする。"""
    glyphs, (xmin, ymin, xmax, ymax) = glyph_paths(font, tt, "kadrokreo", size, {MIRRORED})
    # 外接矩形の左上が原点に来るよう、パス全体をずらす
    ink, accent = [], []
    for d, m in glyphs:
        (accent if m else ink).append(d)
    return " ".join(ink), " ".join(accent), xmax - xmin, ymax - ymin, (-xmin, -ymin)


def symbol(font, tt, side):
    """シンボル（反転 k）のパスを、一辺 side の正方形の中央に置いたときの変換と一緒に返す。"""
    size = side * 0.8
    glyphs, (xmin, ymin, xmax, ymax) = glyph_paths(font, tt, "k", size, {0})
    dx = (side - (xmax - xmin)) / 2 - xmin
    dy = (side - (ymax - ymin)) / 2 - ymin
    return glyphs[0][0], dx, dy


def svg(w, h, body):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.2f} {h:.2f}" '
        f'width="{w:.0f}" height="{h:.0f}" role="img" aria-label="kadrokreo">{body}</svg>\n'
    )


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    print("wrote", path.relative_to(ROOT))


def main(font_path):
    font, tt = load(font_path)

    ink, accent, w, h, (ox, oy) = wordmark(font, tt)
    move = f'transform="translate({ox:.2f} {oy:.2f})"'
    for name, ink_color, k_color in (
        ("kadrokreo-wordmark.svg", INK, ACCENT),
        ("kadrokreo-wordmark-dark.svg", WHITE, TINT),
    ):
        write(OUT / name, svg(w, h, f'<g {move}><path fill="{ink_color}" d="{ink}"/><path fill="{k_color}" d="{accent}"/></g>'))

    side = 160
    k, dx, dy = symbol(font, tt, side)
    sym = f'<rect width="{side}" height="{side}" rx="{side * 0.225:g}" fill="{ACCENT}"/><path fill="{WHITE}" transform="translate({dx:.2f} {dy:.2f})" d="{k}"/>'
    write(OUT / "kadrokreo-symbol.svg", svg(side, side, sym))
    write(ROOT / "public" / "favicon.svg", svg(side, side, sym))

    # 組み合わせ: シンボルの高さをワードマークの高さの 1.3 倍、間をシンボルの 0.3 倍にする
    ws = 1.0
    sh = h * 1.3
    gap = sh * 0.3
    total_w = sh + gap + w * ws
    sym_scaled = f'<g transform="scale({sh / side:.4f})">{sym}</g>'
    for name, ink_color, k_color in (
        ("kadrokreo-lockup.svg", INK, ACCENT),
        ("kadrokreo-lockup-dark.svg", WHITE, TINT),
    ):
        body = (
            sym_scaled
            + f'<g transform="translate({sh + gap:.2f} {(sh - h) / 2:.2f})"><g {move}>'
            + f'<path fill="{ink_color}" d="{ink}"/><path fill="{k_color}" d="{accent}"/></g></g>'
        )
        write(OUT / name, svg(total_w, sh, body))

    # 画面のヘッダー用。色は CSS で付ける（インクは currentColor、反転 k は --logo-accent）
    ts = (
        "// docs/logo/build.py で生成したファイル。手で直さない。\n"
        "// kadrokreo のワードマーク（Red Hat Display ExtraBold、SIL Open Font License）をアウトライン化したもの。\n\n"
        f"export const LOGO_WIDTH = {w:.2f}\n"
        f"export const LOGO_HEIGHT = {h:.2f}\n"
        f"export const LOGO_TRANSFORM = 'translate({ox:.2f} {oy:.2f})'\n"
        f"/** kadro と reo の部分 */\n"
        f"export const LOGO_INK_PATH =\n  '{ink}'\n"
        f"/** 左右反転した k */\n"
        f"export const LOGO_ACCENT_PATH =\n  '{accent}'\n"
    )
    write(ROOT / "src" / "ui" / "logoPaths.ts", ts)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
