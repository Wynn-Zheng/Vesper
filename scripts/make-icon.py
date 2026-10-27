"""
生成 electron/icon.png（256x256）。

设计：深色圆角方底（#0d1117，跟控制台主题同色）+ 青色渐变对话气泡
+ 气泡里三个深色打字点。

为什么这么设计：
  - 深色底跟控制台一致，不像个外来程序
  - 青色（#5eead4 → #38bdf8）在深色和浅色任务栏上都够醒目
  - 形状只有"气泡"一个主体，缩到 16x16 还能认出是个聊天工具
  - 三个点表示"正在打字"，比画个机器人脸更少细节、更耐缩小

用法：python scripts/make-icon.py
"""
import numpy as np
from PIL import Image, ImageDraw

S = 1024   # 超采样画布，最后缩到 256（抗锯齿）
OUT = 256

BG = (13, 17, 23, 255)        # #0d1117
BORDER = (61, 68, 77, 255)    # #3d444d
C1 = (94, 234, 212)           # #5eead4 青
C2 = (56, 189, 248)           # #38bdf8 蓝

# 气泡在 1024 画布上的位置。左右各留 200，上下留 270/820 —— 视觉重心居中，
# 不会像第一版那样显得偏左上、右下空一大块。
BX0, BY0, BX1, BY1 = 200, 270, 824, 700
RADIUS = 92
# 尾巴（左下角的小三角）
TAIL = [(272, 692), (272, 826), (400, 692)]
# 三个点子
DOT_Y = 484
DOT_X = (400, 512, 624)
DOT_R = 44


def rounded_mask(size: int, radius: int) -> Image.Image:
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def bubble_mask() -> Image.Image:
    m = Image.new('L', (S, S), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([BX0, BY0, BX1, BY1], radius=RADIUS, fill=255)
    d.polygon(TAIL, fill=255)
    return m


def gradient() -> Image.Image:
    """左上青、右下蓝的对角渐变"""
    xs = np.linspace(0, 1, S, dtype=np.float32)
    ys = np.linspace(0, 1, S, dtype=np.float32)
    X, Y = np.meshgrid(xs, ys)
    T = np.clip(X * 0.45 + Y * 0.55, 0, 1)[..., None]

    c1 = np.array(C1[:3], dtype=np.float32)
    c2 = np.array(C2[:3], dtype=np.float32)
    rgb = c1 + (c2 - c1) * T

    arr = np.zeros((S, S, 4), dtype=np.uint8)
    arr[..., :3] = rgb.astype(np.uint8)
    arr[..., 3] = 255
    return Image.fromarray(arr, 'RGBA')


def main() -> None:
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # 1. 深色圆角底
    img.paste(Image.new('RGBA', (S, S), BG), (0, 0), rounded_mask(S, 224))

    # 2. 一圈细边框，浅色背景上不至于糊成一块
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([5, 5, S - 6, S - 6], radius=219, outline=BORDER, width=9)

    # 3. 青色渐变气泡（用 mask 裁剪成气泡形状）
    img.paste(gradient(), (0, 0), bubble_mask())

    # 4. 气泡里的三个深色点
    for cx in DOT_X:
        d.ellipse([cx - DOT_R, DOT_Y - DOT_R, cx + DOT_R, DOT_Y + DOT_R], fill=BG)

    # 5. 缩到目标尺寸
    out = img.resize((OUT, OUT), Image.LANCZOS)
    out.save('electron/icon.png', 'PNG')
    print(f'electron/icon.png  {out.size[0]}x{out.size[1]}')


if __name__ == '__main__':
    main()
