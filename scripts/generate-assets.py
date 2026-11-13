#!/usr/bin/env python3
"""Draws MemeFactory's original artwork and builds the asset catalogs.

Outputs:
  public/starter/*.png|jpg            bundled starter assets (ship with the app)
  src/studio/assets/starter.json      their metadata
  catalog/                            sample remote catalog + downloadable pack

Everything here is original artwork drawn from code, so it can be licensed
freely. Run from the repo root:  python3 scripts/generate-assets.py
Requires Pillow.
"""

import hashlib
import io
import json
import math
import os
import shutil
import zipfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STARTER_DIR = os.path.join(ROOT, "public", "starter")
CATALOG_DIR = os.path.join(ROOT, "catalog")

INK = (18, 18, 18, 255)
WHITE = (255, 255, 255, 255)
YELLOW = (255, 214, 64, 255)
PAPER = (255, 247, 232, 255)
RED = (255, 59, 59, 255)
CYAN = (46, 196, 255, 255)
BLUE_TEAR = (90, 180, 255, 255)
BLUSH = (255, 130, 150, 200)
YELLOW_DEEP = (255, 190, 30, 255)
SKIN = (255, 224, 196, 255)
GREEN = (120, 205, 90, 255)

LICENSE = {
    "license": "MIT (MemeFactory original artwork)",
    "licenseUrl": "https://github.com/gabojkz/meme-factory/blob/main/LICENSE",
    "commercialUse": True,
    "modification": True,
    "redistribution": True,
    "attributionRequired": False,
    "verified": True,
    "verifiedAt": "2026-11-03",
    "declaredBy": "MemeFactory",
    "attributionText": None,
}
SOURCE = {"name": "MemeFactory", "url": "https://github.com/gabojkz/meme-factory"}

SS = 4  # supersampling factor for smooth edges


def font(size):
    for path in (
        "/System/Library/Fonts/Supplemental/Impact.ttf",
        "/System/Library/Fonts/Supplemental/Arial Black.ttf",
        "/Library/Fonts/Impact.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


class Canvas:
    """A supersampled RGBA drawing surface working in final-pixel units."""

    def __init__(self, w, h, bg=(0, 0, 0, 0)):
        self.w, self.h = w, h
        self.img = Image.new("RGBA", (w * SS, h * SS), bg)
        self.d = ImageDraw.Draw(self.img)

    def s(self, *v):
        return [x * SS for x in v]

    def ellipse(self, cx, cy, rx, ry, fill=None, outline=INK, width=6):
        self.d.ellipse(self.s(cx - rx, cy - ry, cx + rx, cy + ry), fill=fill, outline=outline, width=int(width * SS) if outline else 0)

    def circle(self, cx, cy, r, **kw):
        self.ellipse(cx, cy, r, r, **kw)

    def line(self, pts, width=6, fill=INK):
        flat = [c * SS for p in pts for c in p]
        self.d.line(flat, fill=fill, width=int(width * SS), joint="curve")
        for x, y in (pts[0], pts[-1]):
            r = width / 2
            self.d.ellipse(self.s(x - r, y - r, x + r, y + r), fill=fill)

    def poly(self, pts, fill=None, outline=INK, width=6):
        flat = [(x * SS, y * SS) for x, y in pts]
        if fill:
            self.d.polygon(flat, fill=fill)
        if outline:
            self.line(list(pts) + [pts[0]], width=width, fill=outline)

    def arc(self, cx, cy, rx, ry, start, end, width=6, fill=INK):
        pts = [
            (cx + rx * math.cos(math.radians(a)), cy + ry * math.sin(math.radians(a)))
            for a in frange(start, end, 4)
        ]
        self.line(pts, width=width, fill=fill)

    def rect(self, x0, y0, x1, y1, fill=None, outline=INK, width=6, radius=0):
        self.d.rounded_rectangle(self.s(x0, y0, x1, y1), radius=radius * SS, fill=fill, outline=outline, width=int(width * SS) if outline else 0)

    def text(self, cx, cy, txt, size, fill=WHITE, stroke=INK, stroke_w=8, angle=0):
        f = font(size * SS)
        layer = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ld.text((cx * SS, cy * SS), txt, font=f, fill=fill, anchor="mm", stroke_width=int(stroke_w * SS), stroke_fill=stroke)
        if angle:
            layer = layer.rotate(angle, center=(cx * SS, cy * SS), resample=Image.BICUBIC)
        self.img.alpha_composite(layer)

    def result(self, trim=True, pad=8):
        img = self.img.resize((self.w, self.h), Image.LANCZOS)
        if trim:
            box = img.getbbox()
            if box:
                x0, y0, x1, y1 = box
                img = img.crop((max(0, x0 - pad), max(0, y0 - pad), min(self.w, x1 + pad), min(self.h, y1 + pad)))
        return img


def frange(a, b, step):
    out = []
    x = a
    while x <= b:
        out.append(x)
        x += step
    out.append(b)
    return out


# ------------------------------------------------------------ reaction faces

def face_base(c, color=YELLOW):
    c.circle(256, 256, 220, fill=color, width=10)


def heart(c, cx, cy, k, fill=RED, width=6):
    pts = []
    for i in range(60):
        t = i / 60 * 2 * math.pi
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((cx + x * k, cy - y * k))
    c.poly(pts, fill=fill, width=width)


def star(c, cx, cy, r, fill, points=5, width=6):
    pts = []
    for i in range(points * 2):
        a = math.radians(i * 180 / points - 90)
        rr = r if i % 2 == 0 else r * 0.45
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    c.poly(pts, fill=fill, width=width)


def eyes_dots(c, y=210, dx=75, r=20):
    for sx in (-1, 1):
        c.circle(256 + sx * dx, y, r, fill=INK, outline=None)


def draw_face(emotion):
    c = Canvas(512, 512)
    tint = {"angry": (255, 122, 89, 255), "disgusted": (170, 214, 110, 255), "scared": (200, 228, 255, 255)}.get(emotion, YELLOW)
    face_base(c, tint)
    if emotion == "happy":
        for sx in (-1, 1):
            c.arc(256 + sx * 75, 220, 32, 28, 200, 340, width=12)
        c.arc(256, 280, 110, 80, 15, 165, width=12)
    elif emotion == "sad":
        eyes_dots(c, 220)
        c.line([(150, 170), (215, 150)], width=10)
        c.line([(297, 150), (362, 170)], width=10)
        c.arc(256, 380, 90, 50, 200, 340, width=12)
    elif emotion == "angry":
        eyes_dots(c, 225, r=18)
        c.line([(150, 155), (225, 195)], width=14)
        c.line([(287, 195), (362, 155)], width=14)
        c.rect(170, 320, 342, 370, fill=WHITE, width=10, radius=12)
        for x in (213, 256, 299):
            c.line([(x, 322), (x, 368)], width=6)
    elif emotion == "laughing":
        for sx in (-1, 1):
            c.line([(256 + sx * 105, 200), (256 + sx * 65, 220), (256 + sx * 105, 240)], width=12)
        c.d.pieslice(c.s(146, 210, 366, 410), 0, 180, fill=(120, 20, 30, 255), outline=INK, width=10 * SS)
        c.d.pieslice(c.s(196, 330, 316, 420), 200, 340, fill=(255, 120, 140, 255))
        for sx in (-1, 1):
            c.ellipse(256 + sx * 150, 250, 14, 24, fill=BLUE_TEAR, width=4)
    elif emotion == "crying":
        for sx in (-1, 1):
            c.arc(256 + sx * 75, 215, 30, 18, 20, 160, width=10)
            c.poly([(256 + sx * 75 - 18, 235), (256 + sx * 75 + 18, 235), (256 + sx * 75 + 24, 440), (256 + sx * 75 - 24, 440)], fill=BLUE_TEAR, width=5)
        c.line([(190, 360), (215, 345), (240, 360), (265, 345), (290, 360), (322, 345)], width=10)
    elif emotion == "shocked":
        for sx in (-1, 1):
            c.circle(256 + sx * 75, 200, 42, fill=WHITE, width=8)
            c.circle(256 + sx * 75, 200, 14, fill=INK, outline=None)
            c.arc(256 + sx * 75, 140, 40, 20, 200, 340, width=8)
        c.ellipse(256, 350, 45, 60, fill=(120, 20, 30, 255), width=10)
    elif emotion == "confused":
        eyes_dots(c, 220)
        c.arc(181, 160, 40, 25, 200, 340, width=10)
        c.line([(290, 175), (360, 175)], width=10)
        c.line([(180, 350), (220, 335), (260, 355), (300, 335), (335, 350)], width=10)
        c.text(420, 90, "?", 130, fill=CYAN, stroke_w=8)
    elif emotion == "disgusted":
        for sx in (-1, 1):
            c.line([(256 + sx * 105, 215), (256 + sx * 45, 215)], width=12)
        c.line([(150, 165), (215, 185)], width=10)
        c.line([(297, 185), (362, 165)], width=10)
        c.line([(175, 350), (215, 330), (256, 350), (297, 330), (337, 350)], width=10)
        c.ellipse(285, 375, 30, 32, fill=(255, 120, 140, 255), width=6)
    elif emotion == "scared":
        for sx in (-1, 1):
            c.circle(256 + sx * 75, 210, 40, fill=WHITE, width=8)
            c.circle(256 + sx * 75, 210, 8, fill=INK, outline=None)
            c.line([(256 + sx * 115, 150), (256 + sx * 40, 130)], width=9)
        c.line([(175, 355), (200, 335), (228, 355), (256, 335), (284, 355), (312, 335), (337, 355)], width=9)
        c.ellipse(395, 150, 18, 28, fill=BLUE_TEAR, width=5)
    elif emotion == "smug":
        for sx in (-1, 1):
            c.d.chord(c.s(256 + sx * 75 - 38, 175, 256 + sx * 75 + 38, 245), 0, 180, fill=WHITE, outline=INK, width=8 * SS)
            c.circle(256 + sx * 75 + 12, 222, 12, fill=INK, outline=None)
            c.line([(256 + sx * 75 - 42, 208), (256 + sx * 75 + 42, 208)], width=10)
        c.line([(195, 350), (280, 355), (325, 325)], width=12)
    elif emotion == "neutral":
        eyes_dots(c, 215)
        c.line([(195, 345), (317, 345)], width=12)
    elif emotion == "thinking":
        for sx in (-1, 1):
            c.circle(256 + sx * 75, 205, 30, fill=WHITE, width=7)
            c.circle(256 + sx * 75 + 10, 192, 11, fill=INK, outline=None)
        c.line([(285, 150), (350, 135)], width=10)
        c.line([(200, 340), (290, 330)], width=10)
        for i, r in enumerate((10, 15, 22)):
            c.circle(400 + i * 28, 140 - i * 40, r, fill=WHITE, width=5)
    elif emotion == "love":
        for sx in (-1, 1):
            heart(c, 256 + sx * 75, 215, 3.4)
        c.arc(256, 290, 95, 70, 15, 165, width=12)
    elif emotion == "cool":
        c.rect(120, 170, 392, 250, fill=INK, outline=None, radius=8)
        c.poly([(120, 170), (240, 170), (225, 255), (135, 255)], fill=INK, width=6)
        c.poly([(272, 170), (392, 170), (377, 255), (287, 255)], fill=INK, width=6)
        c.line([(150, 190), (180, 190)], width=8, fill=WHITE)
        c.line([(195, 340), (260, 350), (320, 325)], width=12)
    elif emotion == "sleepy":
        for sx in (-1, 1):
            c.arc(256 + sx * 75, 205, 32, 20, 20, 160, width=10)
        c.ellipse(256, 350, 26, 18, fill=(120, 20, 30, 255), width=8)
        for i, size in enumerate((70, 55, 40)):
            c.text(400 + i * 34, 120 - i * 45, "Z", size, fill=CYAN, stroke_w=6)
    elif emotion == "embarrassed":
        for sx in (-1, 1):
            c.arc(256 + sx * 75, 225, 30, 24, 200, 340, width=10)
            c.ellipse(256 + sx * 120, 285, 45, 24, fill=BLUSH, outline=None)
        c.line([(215, 345), (240, 335), (256, 345), (272, 335), (297, 345)], width=10)
        c.ellipse(400, 150, 16, 26, fill=BLUE_TEAR, width=5)
    elif emotion == "excited":
        for sx in (-1, 1):
            star(c, 256 + sx * 75, 210, 42, YELLOW_DEEP)
        c.d.pieslice(c.s(166, 250, 346, 410), 0, 180, fill=(120, 20, 30, 255), outline=INK, width=10 * SS)
    return c.result()


EMOTIONS = ["happy", "sad", "angry", "laughing", "crying", "shocked", "confused", "disgusted", "scared", "smug", "neutral", "thinking", "love", "cool", "sleepy", "embarrassed", "excited"]


# ------------------------------------------------------------ blob characters

def draw_blob(color, pose, mood="happy"):
    c = Canvas(512, 600)
    body = (256, 330)
    # limbs behind the body
    if pose == "wave":
        c.line([(170, 360), (110, 300), (90, 220)], width=12)
        c.line([(342, 360), (400, 420)], width=12)
    elif pose == "cheer":
        c.line([(170, 330), (110, 230), (95, 160)], width=12)
        c.line([(342, 330), (402, 230), (417, 160)], width=12)
    elif pose == "shrug":
        c.line([(170, 360), (110, 330), (90, 280)], width=12)
        c.line([(342, 360), (402, 330), (422, 280)], width=12)
    elif pose == "point":
        c.line([(342, 340), (440, 300)], width=12)
        c.line([(170, 360), (120, 430)], width=12)
    elif pose == "facepalm":
        c.line([(342, 380), (380, 340), (320, 230)], width=12)
        c.line([(170, 360), (130, 440)], width=12)
    else:  # sit
        c.line([(170, 360), (140, 430)], width=12)
        c.line([(342, 360), (372, 430)], width=12)
    # legs
    for sx in (-1, 1):
        c.line([(256 + sx * 50, 470), (256 + sx * 60, 545)], width=12)
        c.ellipse(256 + sx * 72, 548, 28, 14, fill=INK, outline=None)
    if pose == "sit":
        c.rect(120, 440, 392, 470, fill=(150, 100, 60, 255), width=8, radius=6)
    c.ellipse(body[0], body[1], 140, 160, fill=color, width=10)
    # face
    if mood == "happy":
        for sx in (-1, 1):
            c.circle(256 + sx * 45, 290, 16, fill=INK, outline=None)
        c.arc(256, 335, 55, 40, 15, 165, width=10)
    elif mood == "sad":
        for sx in (-1, 1):
            c.circle(256 + sx * 45, 295, 15, fill=INK, outline=None)
        c.arc(256, 385, 45, 25, 200, 340, width=10)
    elif mood == "meh":
        for sx in (-1, 1):
            c.line([(256 + sx * 65, 295), (256 + sx * 25, 295)], width=10)
        c.line([(220, 360), (292, 360)], width=10)
    elif mood == "wow":
        for sx in (-1, 1):
            c.circle(256 + sx * 45, 285, 22, fill=WHITE, width=6)
            c.circle(256 + sx * 45, 285, 9, fill=INK, outline=None)
        c.ellipse(256, 360, 22, 30, fill=(120, 20, 30, 255), width=8)
    if pose == "facepalm":
        c.ellipse(310, 255, 38, 30, fill=color, width=8)
    return c.result()


# ------------------------------------------------------------------ stickers

def bubble(kind):
    c = Canvas(600, 480)
    if kind == "speech":
        c.ellipse(300, 210, 260, 170, fill=WHITE, width=10)
        c.poly([(170, 330), (120, 450), (250, 360)], fill=WHITE, outline=None)
        c.line([(175, 340), (120, 450), (245, 368)], width=10)
    elif kind == "thought":
        for x, y, rx, ry in ((300, 200, 250, 160),):
            c.ellipse(x, y, rx, ry, fill=WHITE, width=10)
        for i, r in enumerate((32, 22, 14)):
            c.circle(150 - i * 40, 360 + i * 40, r, fill=WHITE, width=8)
    elif kind == "shout":
        pts = []
        for i in range(28):
            a = math.radians(i * 360 / 28)
            r = 230 if i % 2 == 0 else 175
            pts.append((300 + r * 1.15 * math.cos(a), 220 + r * 0.8 * math.sin(a)))
        c.poly(pts, fill=WHITE, width=9)
    return c.result()


def burst(word, fill, text_fill=WHITE):
    c = Canvas(600, 520)
    pts = []
    for i in range(24):
        a = math.radians(i * 15)
        r = 250 if i % 2 == 0 else 165
        pts.append((300 + r * math.cos(a), 260 + r * 0.85 * math.sin(a)))
    c.poly(pts, fill=fill, width=10)
    c.text(300, 262, word, 130, fill=text_fill, stroke_w=9, angle=8)
    return c.result()


def arrow(curved=False):
    c = Canvas(600, 400)
    if curved:
        pts = [(80 + t * 380, 300 - math.sin(t * math.pi) * 180) for t in [i / 30 for i in range(31)]]
        c.line(pts, width=34, fill=INK)
        c.line(pts, width=20, fill=RED)
        c.poly([(470, 300), (540, 230), (420, 200)], fill=RED, width=8)
    else:
        c.poly([(60, 160), (380, 160), (380, 80), (550, 200), (380, 320), (380, 240), (60, 240)], fill=RED, width=10)
    return c.result()


def label(word, fill):
    c = Canvas(640, 260)
    c.rect(40, 50, 600, 210, fill=fill, width=10, radius=28)
    c.text(320, 132, word, 110, fill=WHITE, stroke_w=7)
    return c.result()


def symbol(kind):
    c = Canvas(400, 400)
    if kind == "heart":
        pts = []
        for i in range(120):
            t = i / 120 * 2 * math.pi
            x = 16 * math.sin(t) ** 3
            y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
            pts.append((200 + x * 10.5, 190 - y * 10.5))
        c.poly(pts, fill=RED, width=10)
    elif kind == "exclaim":
        c.text(200, 205, "!", 330, fill=RED, stroke_w=12)
    elif kind == "question":
        c.text(200, 205, "?", 330, fill=CYAN, stroke_w=12)
    elif kind == "sparkle":
        for cx, cy, r in ((180, 210, 140), (320, 100, 55)):
            pts = []
            for i in range(8):
                a = math.radians(i * 45 - 90)
                rr = r if i % 2 == 0 else r * 0.28
                pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
            c.poly(pts, fill=YELLOW, width=8)
    return c.result()


# ------------------------------------------------------------------- objects

def obj(kind):
    c = Canvas(560, 520)
    if kind == "computer":
        c.rect(60, 40, 500, 340, fill=(60, 70, 90, 255), width=10, radius=18)
        c.rect(90, 70, 470, 310, fill=CYAN, width=6, radius=6)
        for i, w in enumerate((260, 200, 300, 160)):
            c.line([(120, 110 + i * 45), (120 + w, 110 + i * 45)], width=12, fill=WHITE)
        c.poly([(240, 340), (320, 340), (340, 420), (220, 420)], fill=(150, 160, 175, 255), width=8)
        c.rect(150, 420, 410, 450, fill=(150, 160, 175, 255), width=8, radius=8)
    elif kind == "phone":
        c.rect(170, 20, 390, 500, fill=INK, width=10, radius=40)
        c.rect(190, 70, 370, 440, fill=CYAN, outline=None, radius=8)
        c.circle(280, 470, 14, fill=(80, 80, 80, 255), width=4)
        for i in range(3):
            c.rect(210, 100 + i * 105, 350, 175 + i * 105, fill=WHITE, outline=None, radius=10)
    elif kind == "mug":
        c.arc(380, 260, 70, 80, 270, 450, width=26)
        c.rect(120, 140, 400, 450, fill=RED, width=10, radius=30)
        c.ellipse(260, 145, 140, 30, fill=(110, 60, 30, 255), width=8)
        for i in range(3):
            x = 190 + i * 70
            c.line([(x, 110), (x - 15, 80), (x + 10, 50), (x - 5, 20)], width=8)
    elif kind == "money":
        c.rect(30, 120, 530, 400, fill=(130, 200, 120, 255), width=10, radius=14)
        c.rect(60, 150, 500, 370, fill=None, width=5, radius=10)
        c.circle(280, 260, 80, fill=(170, 225, 160, 255), width=6)
        c.text(280, 262, "$", 120, fill=(40, 120, 50, 255), stroke_w=0)
    elif kind == "pizza":
        c.poly([(280, 480), (60, 80), (500, 80)], fill=(255, 205, 90, 255), width=10)
        c.d.chord(c.s(50, 30, 510, 130), 180, 360, fill=(200, 130, 60, 255), outline=INK, width=10 * SS)
        for x, y in ((200, 160), (320, 170), (270, 270), (220, 230)):
            c.circle(x, y, 26, fill=(200, 50, 50, 255), width=6)
    return c.result()


# --------------------------------------------------------------- backgrounds

def gradient(top, bottom, size=800):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        d.line([(0, y), (size, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return img


def halftone(bg, dot, size=800):
    img = Image.new("RGB", (size, size), bg)
    d = ImageDraw.Draw(img)
    for y in range(0, size + 24, 24):
        for x in range(0, size + 24, 24):
            r = 3 + 7 * (1 - y / size)
            ox = 12 if (y // 24) % 2 else 0
            d.ellipse((x + ox - r, y - r, x + ox + r, y + r), fill=dot)
    return img


def sunburst(a, b, size=800):
    img = Image.new("RGB", (size, size), a)
    d = ImageDraw.Draw(img)
    cx = cy = size / 2
    for i in range(0, 24, 2):
        a0 = math.radians(i * 15)
        a1 = math.radians((i + 1) * 15)
        R = size * 1.5
        d.polygon([(cx, cy), (cx + R * math.cos(a0), cy + R * math.sin(a0)), (cx + R * math.cos(a1), cy + R * math.sin(a1))], fill=b)
    return img


def stripes(a, b, size=800, w=60):
    img = Image.new("RGB", (size, size), a)
    d = ImageDraw.Draw(img)
    for x in range(-size, size * 2, w * 2):
        d.polygon([(x, 0), (x + w, 0), (x + w + size, size), (x + size, size)], fill=b)
    return img


def grid_paper(size=800):
    img = Image.new("RGB", (size, size), (250, 250, 245))
    d = ImageDraw.Draw(img)
    for i in range(0, size, 36):
        col = (170, 200, 230) if i % 180 else (120, 160, 210)
        d.line([(i, 0), (i, size)], fill=col, width=2)
        d.line([(0, i), (size, i)], fill=col, width=2)
    return img


def room(size=800):
    img = Image.new("RGB", (size, size), (240, 225, 200))
    d = ImageDraw.Draw(img)
    d.rectangle((0, int(size * 0.68), size, size), fill=(170, 120, 80))
    for x in range(0, size, 67):
        d.line([(x, int(size * 0.68)), (x, size)], fill=(150, 100, 65), width=4)
    d.rectangle((474, 118, 696, 340), fill=(150, 210, 245), outline=(255, 255, 255), width=18)
    d.line([(585, 118), (585, 340)], fill=(255, 255, 255), width=12)
    d.line([(474, 229), (696, 229)], fill=(255, 255, 255), width=12)
    d.rectangle((89, 185, 267, 311), fill=(255, 255, 255), outline=(80, 60, 40), width=12)
    d.ellipse((133, 215, 222, 281), fill=(255, 214, 64))
    return img


# ------------------------------------------------------------ anime & manga

HAIR = {"pink": (255, 150, 190, 255), "blue": (90, 130, 230, 255), "dark": (60, 50, 70, 255), "orange": (255, 150, 60, 255)}


def anime_eye(c, cx, cy, iris, mood):
    if mood in ("happy", "blush"):
        c.arc(cx, cy + 12, 34, 28, 200, 340, width=10)
        return
    if mood == "smug":
        c.d.chord(c.s(cx - 38, cy - 30, cx + 38, cy + 40), 0, 180, fill=WHITE, outline=INK, width=8 * SS)
        c.d.chord(c.s(cx - 20, cy - 10, cx + 20, cy + 38), 0, 180, fill=iris)
        c.line([(cx - 44, cy + 4), (cx + 44, cy - 2)], width=10)
        return
    c.ellipse(cx, cy, 36, 48, fill=WHITE, width=8)
    if mood == "shocked":
        c.circle(cx, cy, 8, fill=INK, outline=None)
        return
    c.ellipse(cx, cy + 6, 26, 38, fill=iris, outline=None)
    c.ellipse(cx, cy + 10, 13, 20, fill=INK, outline=None)
    c.circle(cx - 10, cy - 8, 9, fill=WHITE, outline=None)
    c.circle(cx + 9, cy + 20, 4, fill=WHITE, outline=None)
    c.line([(cx - 40, cy - 46), (cx + 40, cy - 52)], width=9)


def anime_head(c, cx, cy, r, hair, back=True):
    """Draws a face with a spiky fringe; returns nothing, face centre is (cx, cy)."""
    if back:
        c.ellipse(cx, cy - r * 0.05, r * 1.12, r * 1.08, fill=hair, width=8)
    c.ellipse(cx, cy + r * 0.08, r * 0.92, r * 0.95, fill=SKIN, width=8)
    fringe = [(cx - r * 1.05, cy + r * 0.15)]
    for i in range(7):
        t = i / 6
        x = cx - r * 0.95 + t * r * 1.9
        fringe.append((x, cy - r * 0.35 + (0.1 if i % 2 else 0.32) * r * (1 - abs(t - 0.5))))
    fringe += [(cx + r * 1.05, cy + r * 0.15), (cx + r * 1.0, cy - r * 0.7), (cx, cy - r * 1.12), (cx - r * 1.0, cy - r * 0.7)]
    c.poly(fringe, fill=hair, width=8)


def anime_face(mood, hair="pink"):
    c = Canvas(560, 560)
    cx, cy, r = 280, 290, 220
    anime_head(c, cx, cy, r, HAIR[hair])
    iris = {"pink": (200, 60, 120, 255), "blue": (40, 90, 200, 255), "dark": (120, 70, 160, 255), "orange": (200, 100, 30, 255)}[hair]
    for sx in (-1, 1):
        anime_eye(c, cx + sx * 80, cy + 50, iris, mood)
    if mood in ("blush", "crying", "smug"):
        for sx in (-1, 1):
            c.ellipse(cx + sx * 120, cy + 125, 42, 20, fill=BLUSH, outline=None)
            if mood == "blush":
                for k in range(3):
                    x = cx + sx * 120 - 22 + k * 20
                    c.line([(x + 6, cy + 112), (x - 4, cy + 136)], width=4, fill=(220, 60, 90, 255))
    if mood == "happy":
        c.d.chord(c.s(cx - 45, cy + 120, cx + 45, cy + 190), 0, 180, fill=(170, 40, 60, 255), outline=INK, width=7 * SS)
    elif mood == "blush":
        c.line([(cx - 25, cy + 155), (cx - 10, cy + 148), (cx + 5, cy + 156), (cx + 22, cy + 148)], width=7)
    elif mood == "crying":
        for sx in (-1, 1):
            c.poly([(cx + sx * 80 - 16, cy + 92), (cx + sx * 80 + 16, cy + 92), (cx + sx * 86 + 20, cy + 300), (cx + sx * 86 - 20, cy + 300)], fill=BLUE_TEAR, width=5)
        c.d.chord(c.s(cx - 50, cy + 140, cx + 50, cy + 210), 180, 360, fill=(170, 40, 60, 255), outline=INK, width=7 * SS)
    elif mood == "angry":
        c.d.chord(c.s(cx - 50, cy + 135, cx + 50, cy + 215), 180, 360, fill=WHITE, outline=INK, width=7 * SS)
        c.poly([(cx + 18, cy + 152), (cx + 30, cy + 152), (cx + 24, cy + 170)], fill=WHITE, width=4)
        for sx in (-1, 1):
            c.line([(cx + sx * 130, cy - 20), (cx + sx * 40, cy + 15)], width=14)
        anger_vein(c, cx + 150, cy - 140, 45)
    elif mood == "shocked":
        c.ellipse(cx, cy + 165, 30, 38, fill=(170, 40, 60, 255), width=7)
        for i in range(4):
            x = cx - 120 + i * 30
            c.line([(x, cy - 90), (x - 10, cy - 30)], width=5, fill=(80, 90, 160, 255))
    elif mood == "smug":
        c.line([(cx - 30, cy + 155), (cx - 12, cy + 168), (cx, cy + 155), (cx + 12, cy + 168), (cx + 30, cy + 155)], width=7)
    return c.result()


def anger_vein(c, cx, cy, r, fill=RED):
    """Four bulging arcs with their corners meeting near the centre."""
    for ang in (45, 135, 225, 315):
        a = math.radians(ang)
        x, y = cx + r * 1.25 * math.cos(a), cy + r * 1.25 * math.sin(a)
        c.arc(x, y, r * 0.8, r * 0.8, ang + 157, ang + 203, width=r * 0.2, fill=fill)


def chibi(mood, hair, pose):
    c = Canvas(520, 680)
    # body first, head overlaps
    body = (200, 230, 255, 255) if hair == "blue" else (255, 240, 200, 255)
    if pose == "cheer":
        c.line([(205, 470), (130, 380)], width=26, fill=INK)
        c.line([(205, 470), (130, 380)], width=14, fill=SKIN)
        c.line([(315, 470), (390, 380)], width=26, fill=INK)
        c.line([(315, 470), (390, 380)], width=14, fill=SKIN)
    else:
        c.line([(205, 480), (170, 560)], width=26, fill=INK)
        c.line([(205, 480), (170, 560)], width=14, fill=SKIN)
        c.line([(315, 480), (350, 560)], width=26, fill=INK)
        c.line([(315, 480), (350, 560)], width=14, fill=SKIN)
    for sx in (-1, 1):
        c.rect(260 + sx * 40 - 20, 560, 260 + sx * 40 + 20, 640, fill=SKIN, width=7, radius=10)
    c.poly([(195, 450), (325, 450), (355, 600), (165, 600)], fill=body, width=8)
    head = Canvas(560, 560)
    anime_head(head, 280, 290, 220, HAIR[hair])
    iris = (200, 60, 120, 255) if hair == "pink" else (40, 90, 200, 255)
    for sx in (-1, 1):
        anime_eye(head, 280 + sx * 80, 340, iris, mood)
        if mood in ("happy", "blush"):
            head.ellipse(280 + sx * 125, 410, 38, 18, fill=BLUSH, outline=None)
    head.d.chord(head.s(240, 410, 320, 470), 0, 180, fill=(170, 40, 60, 255), outline=INK, width=7 * SS)
    h = head.img.resize((330 * SS, 330 * SS), Image.LANCZOS)
    c.img.alpha_composite(h, (95 * SS, 125 * SS))
    if pose == "cheer":
        star(c, 75, 340, 40, YELLOW)
        star(c, 450, 330, 34, YELLOW)
    return c.result()


def sweat_drop():
    c = Canvas(300, 400)
    pts = [(150 + 90 * math.sin(math.radians(a)), 260 + 90 * math.cos(math.radians(a))) for a in range(-150, 151, 6)]
    c.poly([(150, 40)] + pts, fill=(170, 220, 255, 255), width=9)
    c.ellipse(120, 270, 18, 34, fill=WHITE, outline=None)
    return c.result()


def vein_sticker():
    c = Canvas(360, 360)
    anger_vein(c, 180, 180, 130)
    return c.result()


def blush_marks():
    c = Canvas(600, 220)
    for cx in (140, 460):
        c.ellipse(cx, 110, 110, 55, fill=BLUSH, outline=None)
        for k in range(4):
            x = cx - 60 + k * 40
            c.line([(x + 12, 75), (x - 8, 145)], width=8, fill=(220, 60, 90, 255))
    return c.result()


def speed_lines(bg=(255, 255, 255), ink=(18, 18, 18), size=800, focus=False):
    img = Image.new("RGB", (size * 2, size * 2), bg)
    d = ImageDraw.Draw(img)
    cx = cy = size
    import random
    rnd = random.Random(7 if focus else 3)
    for i in range(170):
        a = rnd.uniform(0, 2 * math.pi)
        w = rnd.uniform(0.004, 0.018)
        r0 = size * (rnd.uniform(0.45, 0.75) if focus else rnd.uniform(0.15, 0.4))
        R = size * 2
        d.polygon([
            (cx + r0 * math.cos(a), cy + r0 * math.sin(a)),
            (cx + R * math.cos(a - w), cy + R * math.sin(a - w)),
            (cx + R * math.cos(a + w), cy + R * math.sin(a + w)),
        ], fill=ink)
    return img.resize((size, size), Image.LANCZOS)


def screentone(size=800):
    img = Image.new("RGB", (size, size), (250, 250, 250))
    d = ImageDraw.Draw(img)
    for y in range(0, size + 16, 16):
        for x in range(0, size + 16, 16):
            r = 1.5 + 4.5 * (x + y) / (2 * size)
            ox = 8 if (y // 16) % 2 else 0
            d.ellipse((x + ox - r, y - r, x + ox + r, y + r), fill=(150, 150, 160))
    return img


# -------------------------------------------------------- animals & frogs

FROG = (130, 210, 100, 255)
FROG_BELLY = (215, 240, 170, 255)


def frog(mood):
    """Ribbit, MemeFactory's own round frog."""
    c = Canvas(560, 520)
    if mood == "angry":
        tint = (170, 200, 90, 255)
    else:
        tint = FROG
    c.ellipse(280, 320, 230, 170, fill=tint, width=10)
    c.ellipse(280, 380, 140, 95, fill=FROG_BELLY, outline=None)
    for sx in (-1, 1):
        ex = 280 + sx * 120
        c.circle(ex, 170, 78, fill=tint, width=10)
        if mood in ("happy", "feelsgood"):
            c.arc(ex, 185, 34, 30, 200, 340, width=11)
        elif mood == "smug":
            c.d.chord(c.s(ex - 46, 140, ex + 46, 220), 0, 180, fill=WHITE, outline=INK, width=8 * SS)
            c.circle(ex + 14, 186, 14, fill=INK, outline=None)
            c.line([(ex - 50, 170), (ex + 50, 170)], width=10)
        else:
            c.circle(ex, 175, 50, fill=WHITE, width=8)
            pr = 14 if mood == "shocked" else 24
            c.circle(ex + (0 if mood == "shocked" else sx * -6), 182, pr, fill=INK, outline=None)
            c.circle(ex - 8, 166, 8, fill=WHITE, outline=None)
            if mood in ("sad", "crying"):
                c.line([(ex - sx * 55, 120), (ex + sx * 30, 105)], width=10)
            if mood == "angry":
                c.line([(ex + sx * 55, 105), (ex - sx * 40, 135)], width=13)
    for sx in (-1, 1):
        c.ellipse(280 + sx * 150, 300, 34, 18, fill=BLUSH, outline=None)
    if mood == "happy":
        c.arc(280, 290, 80, 50, 15, 165, width=11)
    elif mood == "feelsgood":
        c.d.chord(c.s(195, 255, 365, 355), 0, 180, fill=(200, 70, 90, 255), outline=INK, width=9 * SS)
        for x, y in ((90, 120), (470, 110)):
            star(c, x, y, 26, YELLOW)
    elif mood == "sad":
        c.arc(280, 335, 60, 30, 200, 340, width=11)
    elif mood == "crying":
        c.line([(215, 320), (245, 305), (280, 320), (315, 305), (345, 320)], width=10)
        for sx in (-1, 1):
            c.poly([(280 + sx * 120 - 14, 220), (280 + sx * 120 + 14, 220), (280 + sx * 128 + 22, 420), (280 + sx * 128 - 22, 420)], fill=BLUE_TEAR, width=5)
    elif mood == "smug":
        c.line([(220, 300), (290, 310), (345, 285)], width=11)
    elif mood == "angry":
        c.rect(215, 290, 345, 330, fill=WHITE, width=8, radius=10)
        for x in (258, 302):
            c.line([(x, 292), (x, 328)], width=5)
    elif mood == "shocked":
        c.ellipse(280, 310, 32, 40, fill=(200, 70, 90, 255), width=8)
    return c.result()


def cat(mood, fur=(255, 170, 80, 255)):
    c = Canvas(560, 520)
    for sx in (-1, 1):
        c.poly([(280 + sx * 70, 140), (280 + sx * 200, 60), (280 + sx * 190, 220)], fill=fur, width=10)
        c.poly([(280 + sx * 100, 150), (280 + sx * 180, 100), (280 + sx * 175, 190)], fill=(255, 200, 200, 255), outline=None)
    c.ellipse(280, 300, 220, 190, fill=fur, width=10)
    for i in range(3):
        c.line([(240 + i * 40, 120), (240 + i * 40, 160)], width=8, fill=(200, 110, 40, 255))
    for sx in (-1, 1):
        ex = 280 + sx * 90
        if mood == "happy":
            c.arc(ex, 270, 34, 28, 200, 340, width=11)
        elif mood == "annoyed":
            c.d.chord(c.s(ex - 40, 235, ex + 40, 305), 0, 180, fill=(250, 240, 150, 255), outline=INK, width=8 * SS)
            c.ellipse(ex + 4, 280, 7, 18, fill=INK, outline=None)
            c.line([(ex - 44, 260), (ex + 44, 260)], width=10)
        else:  # shocked
            c.circle(ex, 260, 52, fill=(250, 240, 150, 255), width=8)
            c.ellipse(ex, 260, 10, 30, fill=INK, outline=None)
    c.poly([(262, 320), (298, 320), (280, 340)], fill=(255, 130, 150, 255), width=5)
    if mood == "happy":
        c.arc(258, 350, 22, 18, 10, 170, width=8)
        c.arc(302, 350, 22, 18, 10, 170, width=8)
    elif mood == "annoyed":
        c.line([(250, 375), (310, 368)], width=8)
    else:
        c.ellipse(280, 385, 26, 34, fill=(120, 20, 30, 255), width=8)
    for sy in (-1, 1):
        for sx in (-1, 1):
            c.line([(280 + sx * 120, 345 + sy * 12), (280 + sx * 240, 335 + sy * 40)], width=5)
    return c.result()


def dog(mood, fur=(205, 160, 110, 255)):
    c = Canvas(560, 540)
    ear = (130, 90, 60, 255)
    tilt = -12 if mood == "confused" else 0
    c.ellipse(280, 290, 200, 190, fill=fur, width=10)
    for sx in (-1, 1):
        c.ellipse(280 + sx * 190, 250 + sx * tilt, 55, 120, fill=ear, width=10)
    c.ellipse(280, 370, 110, 85, fill=(250, 235, 210, 255), width=8)
    for sx in (-1, 1):
        ex = 280 + sx * 80
        c.circle(ex, 250 + sx * tilt, 26, fill=INK, outline=None)
        c.circle(ex - 8, 242 + sx * tilt, 8, fill=WHITE, outline=None)
    c.ellipse(280, 330, 40, 28, fill=INK, outline=None)
    if mood == "happy":
        c.arc(250, 370, 30, 26, 10, 170, width=8)
        c.arc(310, 370, 30, 26, 10, 170, width=8)
        c.ellipse(280, 420, 26, 36, fill=(255, 110, 130, 255), width=7)
    else:
        c.line([(240, 395), (320, 385)], width=8)
        c.text(450, 110, "?", 120, fill=CYAN, stroke_w=8)
    return c.result()


def bird(mood):
    c = Canvas(520, 520)
    body = (90, 170, 255, 255)
    c.ellipse(250, 290, 190, 175, fill=body, width=10)
    c.ellipse(250, 350, 120, 100, fill=(220, 240, 255, 255), outline=None)
    c.poly([(90, 300), (20, 240), (60, 340)], fill=body, width=9)
    for sx in (-1, 1):
        ex = 250 + sx * 65
        if mood == "shocked":
            c.circle(ex, 230, 40, fill=WHITE, width=8)
            c.circle(ex, 230, 10, fill=INK, outline=None)
        else:
            c.circle(ex, 235, 22, fill=INK, outline=None)
            c.circle(ex - 7, 228, 7, fill=WHITE, outline=None)
    if mood == "shocked":
        c.poly([(215, 280), (285, 280), (250, 360)], fill=YELLOW_DEEP, width=8)
        c.line([(215, 300), (285, 300)], width=6)
    else:
        c.poly([(220, 275), (280, 275), (250, 315)], fill=YELLOW_DEEP, width=8)
    for sx in (-1, 1):
        c.line([(250 + sx * 50, 455), (250 + sx * 55, 500)], width=9, fill=YELLOW_DEEP)
    return c.result()


# --------------------------------------------------- internet characters

def folk(kind):
    """Line-art archetype characters in MemeFactory's own style."""
    c = Canvas(520, 600)
    skin = {"npc": (190, 190, 195, 255)}.get(kind, (255, 255, 255, 255))
    shirt = {"gloomy": (40, 40, 50, 255), "sunny": (255, 214, 64, 255), "jaw": (230, 230, 235, 255), "npc": (150, 150, 160, 255), "boomer": (90, 140, 200, 255), "zoomer": (255, 120, 170, 255)}[kind]
    # shoulders
    c.d.chord(c.s(60, 430, 460, 760), 180, 360, fill=shirt, outline=INK, width=8 * SS)
    head_w = 160 if kind == "jaw" else 140
    if kind == "jaw":
        c.poly([(110, 150), (410, 150), (400, 330), (330, 420), (190, 420), (120, 330)], fill=skin, width=8)
    else:
        c.ellipse(260, 260, head_w, 165, fill=skin, width=8)
    if kind == "gloomy":
        c.d.chord(c.s(110, 70, 410, 270), 180, 360, fill=(40, 40, 50, 255), outline=INK, width=8 * SS)
        c.rect(105, 160, 415, 200, fill=(60, 60, 75, 255), width=8, radius=10)
        for sx in (-1, 1):
            c.line([(260 + sx * 85, 255), (260 + sx * 35, 255)], width=9)
            c.arc(260 + sx * 60, 285, 26, 12, 20, 160, width=4, fill=(120, 120, 140, 255))
        c.line([(225, 350), (295, 345)], width=7)
    elif kind == "sunny":
        for sx in (-1, 1):
            c.arc(260 + sx * 58, 255, 28, 24, 200, 340, width=9)
            c.ellipse(260 + sx * 95, 300, 26, 14, fill=BLUSH, outline=None)
        c.arc(260, 310, 70, 55, 15, 165, width=9)
        for i in range(8):
            a = math.radians(i * 45)
            c.line([(430 + 50 * math.cos(a), 90 + 50 * math.sin(a)), (430 + 75 * math.cos(a), 90 + 75 * math.sin(a))], width=8, fill=YELLOW_DEEP)
        c.circle(430, 90, 34, fill=YELLOW, width=6)
    elif kind == "jaw":
        c.poly([(110, 150), (160, 70), (260, 55), (360, 70), (410, 150)], fill=(250, 220, 120, 255), width=8)
        for sx in (-1, 1):
            c.line([(260 + sx * 90, 230), (260 + sx * 35, 236)], width=12)
            c.circle(260 + sx * 62, 255, 9, fill=INK, outline=None)
        c.line([(260, 260), (250, 320), (272, 322)], width=6)
        c.line([(215, 365), (305, 365)], width=8)
        c.line([(190, 420), (205, 385)], width=5)
        c.line([(330, 420), (315, 385)], width=5)
    elif kind == "npc":
        for sx in (-1, 1):
            c.circle(260 + sx * 55, 255, 10, fill=INK, outline=None)
        c.line([(260, 270), (260, 310)], width=6)
        c.line([(225, 350), (295, 350)], width=7)
    elif kind == "boomer":
        c.rect(118, 225, 402, 275, fill=INK, outline=None, radius=10)
        c.poly([(120, 220), (250, 220), (240, 285), (130, 285)], fill=INK, width=6)
        c.poly([(270, 220), (400, 220), (390, 285), (280, 285)], fill=INK, width=6)
        c.d.chord(c.s(195, 300, 325, 360), 180, 360, fill=(150, 120, 90, 255), outline=INK, width=6 * SS)
        c.arc(260, 360, 40, 18, 20, 160, width=7)
        c.d.chord(c.s(110, 80, 410, 240), 180, 360, fill=(200, 60, 60, 255), outline=INK, width=8 * SS)
        c.rect(260, 150, 450, 175, fill=(200, 60, 60, 255), width=7, radius=10)
    elif kind == "zoomer":
        c.d.chord(c.s(115, 90, 405, 280), 180, 360, fill=(255, 150, 60, 255), outline=INK, width=8 * SS)
        c.arc(260, 240, 170, 160, 180, 360, width=16, fill=INK)
        for sx in (-1, 1):
            c.rect(260 + sx * 165 - 30, 210, 260 + sx * 165 + 30, 300, fill=(255, 120, 170, 255), width=8, radius=16)
            c.circle(260 + sx * 55, 255, 18, fill=INK, outline=None)
            c.circle(260 + sx * 55 - 5, 249, 6, fill=WHITE, outline=None)
        c.d.chord(c.s(225, 315, 295, 375), 0, 180, fill=(170, 40, 60, 255), outline=INK, width=6 * SS)
    return c.result()


# ------------------------------------------------------- gaming & fandom

def pixel_art(rows, palette, px=28, outline=True):
    """Draws a sprite; with `outline`, empty cells touching it become ink."""
    h, w = len(rows), max(len(r) for r in rows)
    pad = 1 if outline else 0
    grid = [[None] * (w + 2 * pad) for _ in range(h + 2 * pad)]
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch in palette:
                grid[y + pad][x + pad] = palette[ch]
    if outline:
        edges = [
            (y, x)
            for y in range(len(grid))
            for x in range(len(grid[0]))
            if grid[y][x] is None and any(
                0 <= y + dy < len(grid) and 0 <= x + dx < len(grid[0]) and grid[y + dy][x + dx] not in (None, INK)
                for dy, dx in ((0, 1), (1, 0), (0, -1), (-1, 0))
            )
        ]
        for y, x in edges:
            grid[y][x] = INK
    img = Image.new("RGBA", (len(grid[0]) * px, len(grid) * px), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y, row in enumerate(grid):
        for x, col in enumerate(row):
            if col is not None:
                d.rectangle((x * px, y * px, (x + 1) * px - 1, (y + 1) * px - 1), fill=col)
    return img


STEEL = (210, 220, 235, 255)
PIX = {
    "heart": ([".rr.rr.", "rwrrrrr", "rrrrrrr", ".rrrrr.", "..rrr..", "...r..."], {"r": RED, "w": WHITE}),
    "coin": ([".yyyy.", "yywyyy", "yywyyy", "yywyyy", "yyyyyy", ".yyyy."], {"y": YELLOW_DEEP, "w": WHITE}),
    "sword": ([
        ".........ss", "........sws", ".......sws.", "......sws..", ".....sws...", "..g.sws....",
        "...gws.....", "...bg......", "..b..g.....", ".b.........", "p.........."], {"s": STEEL, "w": WHITE, "g": YELLOW_DEEP, "b": (140, 90, 50, 255), "p": RED}),
    "potion": (["..bb..", "..pp..", ".pppp.", "pwpppp", "pppppp", ".pppp."], {"b": (150, 100, 60, 255), "p": (200, 80, 255, 255), "w": WHITE}),
    "crown": (["y..y..y", "yy.y.yy", "yyyyyyy", "yryyyry", "yyyyyyy"], {"y": YELLOW_DEEP, "r": RED}),
    "slime": (["..ggg..", ".ggggg.", "gwkgwkg", "ggggggg", "ggggggg"], {"g": (110, 220, 120, 255), "w": WHITE, "k": INK}),
    "shades": (["kkkkkkkkkkkkkkkk", "kwwkkkkk..kwwkkk", ".kkkkkk....kkkkk.", "..kkkk......kkk.."], {"k": INK, "w": WHITE}),
}


def controller():
    c = Canvas(600, 380)
    c.rect(60, 90, 540, 300, fill=(70, 75, 95, 255), width=10, radius=100)
    c.rect(130, 170, 230, 210, fill=INK, outline=None, radius=4)
    c.rect(160, 140, 200, 240, fill=INK, outline=None, radius=4)
    for (x, y), col in zip(((420, 150), (470, 195), (420, 240), (370, 195)), (RED, CYAN, GREEN, YELLOW)):
        c.circle(x, y, 22, fill=col, width=6)
    return c.result()


def rocket():
    c = Canvas(400, 600)
    c.poly([(140, 430), (80, 520), (150, 500)], fill=RED, width=8)
    c.poly([(260, 430), (320, 520), (250, 500)], fill=RED, width=8)
    c.poly([(200, 470), (170, 560), (230, 560)], fill=YELLOW_DEEP, width=6)
    c.poly([(200, 40), (270, 160), (260, 480), (140, 480), (130, 160)], fill=(235, 235, 245, 255), width=9)
    c.circle(200, 250, 45, fill=CYAN, width=8)
    return c.result()


def ufo():
    c = Canvas(600, 420)
    c.poly([(250, 230), (350, 230), (450, 410), (150, 410)], fill=(200, 255, 170, 120), outline=None)
    c.ellipse(300, 150, 110, 90, fill=(170, 230, 255, 220), width=8)
    c.ellipse(300, 200, 260, 60, fill=(160, 165, 185, 255), width=9)
    for i in range(5):
        c.circle(140 + i * 80, 205, 12, fill=YELLOW, width=4)
    return c.result()


def colour_wheel(colors, size=800, n=6):
    """The classic multi-coloured radial backdrop of advice-style memes."""
    img = Image.new("RGB", (size, size), colors[0])
    d = ImageDraw.Draw(img)
    cx = cy = size / 2
    R = size
    for i in range(n):
        a0 = math.radians(i * 360 / n - 90)
        a1 = math.radians((i + 1) * 360 / n - 90)
        pts = [(cx, cy)] + [(cx + R * math.cos(a0 + (a1 - a0) * t / 10), cy + R * math.sin(a0 + (a1 - a0) * t / 10)) for t in range(11)]
        d.polygon(pts, fill=colors[i % len(colors)])
    return img


def stamp(word, fill, angle=-8):
    c = Canvas(640, 300)
    c.rect(40, 50, 600, 250, fill=None, outline=fill, width=18, radius=20)
    c.text(320, 152, word, 140, fill=fill, stroke=fill, stroke_w=0)
    c.img = c.img.rotate(angle, resample=Image.BICUBIC)
    return c.result()


# --------------------------------------------------------------------- build

def save(img, path, fmt):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if fmt == "jpg":
        img.convert("RGB").save(path, "JPEG", quality=80, optimize=True, progressive=True)
    else:
        img.save(path, "PNG", optimize=True)
    with open(path, "rb") as f:
        data = f.read()
    return len(data), "sha256-" + hashlib.sha256(data).hexdigest()


def record(aid, name, category, sub, tags, emotions, style, img, fmt, desc, transparent=True):
    return {
        "id": aid,
        "name": name,
        "description": desc,
        "category": category,
        "subcategory": sub,
        "tags": tags,
        "emotions": emotions,
        "style": style,
        "format": "jpg" if fmt == "jpg" else "png",
        "dimensions": {"width": img.width, "height": img.height},
        "transparent": transparent,
        "version": 1,
        "source": SOURCE,
        "licensing": LICENSE,
    }


def starter_items():
    items = []
    for e in EMOTIONS:
        items.append((f"face-{e}", f"{e.title()} face", "reactions", "faces", [e, "face", "reaction", "emoji"], [e], "cartoon", draw_face(e), "png", f"A {e} reaction face."))
    blobs = [
        ("wave", "happy", (255, 140, 90, 255), "Waving blob"),
        ("cheer", "happy", (120, 210, 120, 255), "Cheering blob"),
        ("shrug", "meh", (160, 150, 255, 255), "Shrugging blob"),
        ("point", "wow", (255, 214, 64, 255), "Pointing blob"),
        ("facepalm", "sad", (90, 190, 255, 255), "Facepalm blob"),
        ("sit", "meh", (255, 120, 170, 255), "Sitting blob"),
    ]
    for pose, mood, color, name in blobs:
        emo = {"happy": ["happy"], "meh": ["neutral"], "wow": ["shocked"], "sad": ["sad"]}[mood]
        items.append((f"blob-{pose}", name, "characters", "blobs", ["blob", "character", pose, "person"], emo, "cartoon", draw_blob(color, pose, mood), "png", f"An original MemeFactory blob character ({pose})."))
    stickers = [
        ("bubble-speech", "Speech bubble", bubble("speech"), ["speech", "bubble", "talk", "say"]),
        ("bubble-thought", "Thought bubble", bubble("thought"), ["thought", "bubble", "think"]),
        ("bubble-shout", "Shout bubble", bubble("shout"), ["shout", "bubble", "yell"]),
        ("burst-pow", "POW!", burst("POW!", YELLOW), ["pow", "comic", "effect", "hit"]),
        ("burst-boom", "BOOM!", burst("BOOM!", RED), ["boom", "comic", "effect", "explosion"]),
        ("burst-wow", "WOW", burst("WOW", CYAN), ["wow", "comic", "effect"]),
        ("label-lol", "LOL label", label("LOL", RED), ["lol", "label", "laugh"]),
        ("label-nope", "NOPE label", label("NOPE", (60, 60, 60, 255)), ["nope", "label", "no"]),
        ("arrow-straight", "Big arrow", arrow(False), ["arrow", "point", "this"]),
        ("arrow-curved", "Curved arrow", arrow(True), ["arrow", "curved", "point"]),
        ("symbol-heart", "Heart", symbol("heart"), ["heart", "love"]),
        ("symbol-exclaim", "Exclamation", symbol("exclaim"), ["exclamation", "alert", "symbol"]),
        ("symbol-question", "Question mark", symbol("question"), ["question", "confused", "symbol"]),
        ("symbol-sparkle", "Sparkles", symbol("sparkle"), ["sparkle", "shiny", "star"]),
    ]
    for aid, name, img, tags in stickers:
        items.append((f"sticker-{aid}", name, "stickers", tags[1] if "bubble" in aid else "effects", tags, [], "cartoon", img, "png", f"{name} sticker."))
    for kind, name, tags in (
        ("computer", "Computer", ["computer", "pc", "monitor", "work"]),
        ("phone", "Smartphone", ["phone", "mobile", "smartphone"]),
        ("mug", "Coffee mug", ["coffee", "mug", "drink"]),
        ("money", "Money bill", ["money", "cash", "dollar"]),
        ("pizza", "Pizza slice", ["pizza", "food"]),
    ):
        items.append((f"object-{kind}", name, "objects", "everyday", tags, [], "cartoon", obj(kind), "png", f"A cartoon {name.lower()}."))
    backgrounds = [
        ("bg-sunset", "Sunset gradient", gradient((255, 120, 90), (255, 214, 64)), ["gradient", "sunset", "orange"]),
        ("bg-ocean", "Ocean gradient", gradient((46, 196, 255), (30, 60, 140)), ["gradient", "blue", "ocean"]),
        ("bg-void", "Dark void", gradient((40, 40, 60), (5, 5, 10)), ["dark", "black", "void"]),
        ("bg-halftone", "Comic halftone", halftone((255, 247, 232), (255, 59, 59)), ["comic", "halftone", "dots", "pattern"]),
        ("bg-sunburst", "Sunburst", sunburst((255, 214, 64), (255, 180, 40)), ["sunburst", "rays", "comic"]),
        ("bg-stripes", "Candy stripes", stripes((255, 247, 232), (46, 196, 255)), ["stripes", "pattern"]),
        ("bg-grid", "Grid paper", grid_paper(), ["grid", "paper", "notebook"]),
        ("bg-room", "Simple room", room(), ["room", "indoor", "house"]),
    ]
    for aid, name, img, tags in backgrounds:
        items.append((aid, name, "backgrounds", tags[0], tags, [], "vector", img, "jpg", f"{name} background.", False))
    items += [
        ("anime-happy", "Anime happy face", "anime", "faces", ["anime", "manga", "girl", "smile", "kawaii"], ["happy"], "cartoon", anime_face("happy", "pink"), "png", "An original anime-style face, smiling."),
        ("anime-shocked", "Anime shocked face", "anime", "faces", ["anime", "manga", "boy", "surprised", "omg"], ["shocked"], "cartoon", anime_face("shocked", "blue"), "png", "An original anime-style face in shock."),
        ("anime-sweat", "Sweat drop", "anime", "effects", ["anime", "manga", "sweat", "nervous", "awkward"], ["embarrassed"], "cartoon", sweat_drop(), "png", "The classic manga sweat drop."),
        ("anime-speedlines", "Speed lines", "anime", "backgrounds", ["anime", "manga", "speed", "lines", "action"], [], "sketch", speed_lines(), "jpg", "Manga speed lines background.", False),
        ("frog-happy", "Ribbit (happy)", "animals", "frogs", ["frog", "ribbit", "green", "feels"], ["happy"], "cartoon", frog("happy"), "png", "Ribbit, MemeFactory's own frog, happy."),
        ("frog-sad", "Ribbit (sad)", "animals", "frogs", ["frog", "ribbit", "green", "feels", "bad"], ["sad"], "cartoon", frog("sad"), "png", "Ribbit, MemeFactory's own frog, feeling bad."),
        ("cat-happy", "Happy cat", "animals", "cats", ["cat", "kitty", "pet"], ["happy"], "cartoon", cat("happy"), "png", "A happy cartoon cat."),
        ("dog-happy", "Happy dog", "animals", "dogs", ["dog", "puppy", "doggo", "pet"], ["happy"], "cartoon", dog("happy"), "png", "A happy cartoon dog."),
        ("folk-sunny", "Sunny guy", "internet", "archetypes", ["optimist", "bloomer", "wholesome", "guy"], ["happy"], "hand-drawn", folk("sunny"), "png", "An optimistic line-art character (original archetype)."),
        ("folk-gloomy", "Gloomy guy", "internet", "archetypes", ["gloomy", "doomer", "beanie", "guy"], ["sad"], "hand-drawn", folk("gloomy"), "png", "A gloomy line-art character (original archetype)."),
        ("pixel-heart", "Pixel heart", "gaming", "pixel", ["pixel", "8bit", "heart", "life", "hp"], ["love"], "pixel art", pixel_art(*PIX["heart"]), "png", "An 8-bit heart."),
        ("gaming-controller", "Game controller", "gaming", "gear", ["controller", "gamepad", "gamer", "console"], [], "cartoon", controller(), "png", "A cartoon game controller."),
        ("classic-wheel", "Advice colour wheel", "classic", "backgrounds", ["advice", "animal", "colour", "wheel", "classic"], [], "vector", colour_wheel([(255, 90, 90), (255, 190, 60), (255, 240, 90), (110, 210, 110), (80, 160, 255), (170, 110, 230)]), "jpg", "The multi-coloured backdrop of classic advice-style memes.", False),
        ("classic-shades", "Pixel shades", "classic", "props", ["pixel", "sunglasses", "shades", "deal", "cool"], ["cool"], "pixel art", pixel_art(*PIX["shades"], px=24, outline=False), "png", "Pixel sunglasses, for dropping onto a face."),
    ]
    return items


def blob_crew():
    moods = [
        ("wave", "sad", (200, 200, 200, 255), "Gloomy blob"),
        ("cheer", "wow", (255, 90, 90, 255), "Hyped blob"),
        ("point", "happy", (120, 210, 200, 255), "Look-at-this blob"),
        ("shrug", "sad", (255, 190, 120, 255), "Defeated blob"),
        ("sit", "happy", (180, 140, 255, 255), "Chill blob"),
        ("facepalm", "meh", (255, 214, 64, 255), "Done blob"),
    ]
    items = []
    for pose, mood, color, name in moods:
        emo = {"happy": ["happy"], "meh": ["neutral"], "wow": ["shocked"], "sad": ["sad"]}[mood]
        aid = "blobcrew-" + name.lower().replace(" ", "-").replace("-blob", "")
        items.append((aid, name, "characters", "blobs", ["blob", "character", pose, mood], emo, "cartoon", draw_blob(color, pose, mood), "png", f"{name} from the Blob Crew pack."))
    for word, fill in (("ZAP!", CYAN), ("BAM!", (255, 140, 40, 255)), ("OOF", (160, 150, 255, 255)), ("BRUH", (90, 90, 90, 255))):
        aid = "blobcrew-fx-" + word.strip("!").lower()
        items.append((aid, word, "stickers", "effects", [word.strip("!").lower(), "comic", "effect"], [], "cartoon", burst(word, fill), "png", f"{word} comic effect."))
    return items


def anime_feels():
    a = ["anime", "manga"]
    return [
        ("anime-blush", "Anime blushing face", "anime", "faces", a + ["blush", "shy", "kawaii", "girl"], ["embarrassed", "love"], "cartoon", anime_face("blush", "pink"), "png", "Blushing anime-style face."),
        ("anime-crying", "Anime crying face", "anime", "faces", a + ["tears", "cry", "sob"], ["crying", "sad"], "cartoon", anime_face("crying", "dark"), "png", "Anime-style face in floods of tears."),
        ("anime-angry", "Anime angry face", "anime", "faces", a + ["mad", "rage", "fang", "vein"], ["angry"], "cartoon", anime_face("angry", "orange"), "png", "Anime-style face, furious, anger vein included."),
        ("anime-smug", "Anime smug face", "anime", "faces", a + ["smug", "tease", "girl"], ["smug"], "cartoon", anime_face("smug", "pink"), "png", "Smug anime-style face."),
        ("anime-joy", "Anime joyful face", "anime", "faces", a + ["smile", "boy", "joy"], ["happy", "excited"], "cartoon", anime_face("happy", "blue"), "png", "Joyful anime-style face."),
        ("chibi-cheer", "Chibi cheer", "anime", "chibi", a + ["chibi", "cute", "yay", "cheer"], ["excited", "happy"], "cartoon", chibi("happy", "pink", "cheer"), "png", "A tiny chibi cheering."),
        ("chibi-stand", "Chibi standing", "anime", "chibi", a + ["chibi", "cute", "shy"], ["embarrassed"], "cartoon", chibi("blush", "blue", "stand"), "png", "A shy chibi."),
        ("anime-vein", "Anger vein", "anime", "effects", a + ["anger", "vein", "mad", "symbol"], ["angry"], "cartoon", vein_sticker(), "png", "The manga anger vein symbol."),
        ("anime-blushmarks", "Blush marks", "anime", "effects", a + ["blush", "cheeks", "shy"], ["embarrassed", "love"], "cartoon", blush_marks(), "png", "Blush marks to put on any face."),
        ("anime-focus", "Focus lines", "anime", "backgrounds", a + ["focus", "lines", "dramatic", "reveal"], ["shocked"], "sketch", speed_lines(focus=True), "jpg", "Manga focus lines framing the centre.", False),
        ("anime-screentone", "Screentone", "anime", "backgrounds", a + ["screentone", "halftone", "dots", "panel"], [], "sketch", screentone(), "jpg", "Manga screentone gradient.", False),
    ]


def critters():
    f = ["frog", "ribbit", "green"]
    return [
        ("frog-smug", "Ribbit (smug)", "animals", "frogs", f + ["smug"], ["smug"], "cartoon", frog("smug"), "png", "Ribbit, looking far too pleased."),
        ("frog-angry", "Ribbit (angry)", "animals", "frogs", f + ["mad", "rage"], ["angry"], "cartoon", frog("angry"), "png", "Ribbit, furious."),
        ("frog-crying", "Ribbit (crying)", "animals", "frogs", f + ["tears", "cry"], ["crying", "sad"], "cartoon", frog("crying"), "png", "Ribbit in tears."),
        ("frog-feelsgood", "Ribbit (feels good)", "animals", "frogs", f + ["feels", "good", "content", "bliss"], ["happy", "excited"], "cartoon", frog("feelsgood"), "png", "Ribbit, feeling good."),
        ("frog-shocked", "Ribbit (shocked)", "animals", "frogs", f + ["surprised", "omg"], ["shocked"], "cartoon", frog("shocked"), "png", "Ribbit, shocked."),
        ("cat-shocked", "Surprised cat", "animals", "cats", ["cat", "kitty", "surprised", "omg"], ["shocked"], "cartoon", cat("shocked", (180, 180, 190, 255)), "png", "A cat that just saw something."),
        ("cat-annoyed", "Annoyed cat", "animals", "cats", ["cat", "kitty", "annoyed", "unimpressed", "side-eye"], ["disgusted", "neutral"], "cartoon", cat("annoyed", (90, 90, 100, 255)), "png", "An unimpressed cat."),
        ("dog-confused", "Confused dog", "animals", "dogs", ["dog", "doggo", "head tilt", "huh"], ["confused"], "cartoon", dog("confused", (240, 200, 120, 255)), "png", "A head-tilting, confused dog."),
        ("bird-happy", "Little bird", "animals", "birds", ["bird", "birb", "cute"], ["happy"], "cartoon", bird("happy"), "png", "A round little bird."),
        ("bird-shocked", "Screaming bird", "animals", "birds", ["bird", "birb", "scream", "yell"], ["shocked", "scared"], "cartoon", bird("shocked"), "png", "A bird screaming into the void."),
    ]


def internet_folk():
    return [
        ("folk-jaw", "Square-jaw guy", "internet", "archetypes", ["chad", "jaw", "confident", "yes", "guy"], ["smug", "cool"], "hand-drawn", folk("jaw"), "png", "Supremely confident line-art guy (original archetype)."),
        ("folk-npc", "Gray NPC", "internet", "archetypes", ["npc", "gray", "blank", "guy"], ["neutral"], "hand-drawn", folk("npc"), "png", "Blank gray NPC-style character (original archetype)."),
        ("folk-boomer", "Boomer guy", "internet", "archetypes", ["boomer", "dad", "sunglasses", "cap", "guy"], ["cool"], "hand-drawn", folk("boomer"), "png", "Cap, shades and moustache (original archetype)."),
        ("folk-zoomer", "Zoomer guy", "internet", "archetypes", ["zoomer", "headphones", "gen z", "guy"], ["happy"], "hand-drawn", folk("zoomer"), "png", "Headphones on, always online (original archetype)."),
        ("classic-wheel-cool", "Cool colour wheel", "classic", "backgrounds", ["advice", "animal", "colour", "wheel", "classic"], [], "vector", colour_wheel([(46, 120, 255), (90, 210, 220), (150, 110, 230), (60, 180, 140)], n=8), "jpg", "Cool-toned advice-style backdrop.", False),
        ("classic-win", "EPIC WIN stamp", "classic", "stamps", ["epic", "win", "stamp", "success"], ["happy", "excited"], "cartoon", stamp("EPIC WIN", (40, 170, 70, 255)), "png", "Stamp it a win."),
        ("classic-fail", "FAIL stamp", "classic", "stamps", ["fail", "stamp", "epic"], ["sad"], "cartoon", stamp("FAIL", (220, 40, 40, 255)), "png", "Stamp it a fail."),
    ]


def pixel_quest():
    return [
        ("pixel-coin", "Pixel coin", "gaming", "pixel", ["pixel", "8bit", "coin", "gold"], [], "pixel art", pixel_art(*PIX["coin"], px=40), "png", "An 8-bit coin."),
        ("pixel-sword", "Pixel sword", "gaming", "fantasy", ["pixel", "8bit", "sword", "rpg"], [], "pixel art", pixel_art(*PIX["sword"]), "png", "An 8-bit sword."),
        ("pixel-potion", "Pixel potion", "gaming", "fantasy", ["pixel", "8bit", "potion", "rpg", "magic"], [], "pixel art", pixel_art(*PIX["potion"], px=36), "png", "An 8-bit potion."),
        ("pixel-crown", "Pixel crown", "gaming", "fantasy", ["pixel", "8bit", "crown", "king", "winner"], ["proud"], "pixel art", pixel_art(*PIX["crown"], px=40), "png", "An 8-bit crown."),
        ("pixel-slime", "Pixel slime", "gaming", "fantasy", ["pixel", "8bit", "slime", "monster", "rpg"], ["happy"], "pixel art", pixel_art(*PIX["slime"], px=36), "png", "A friendly 8-bit slime."),
        ("scifi-rocket", "Rocket", "gaming", "sci-fi", ["rocket", "space", "launch", "to the moon"], ["excited"], "cartoon", rocket(), "png", "A cartoon rocket."),
        ("scifi-ufo", "UFO", "gaming", "sci-fi", ["ufo", "alien", "space", "abduction"], [], "cartoon", ufo(), "png", "A UFO with tractor beam."),
        ("label-gameover", "GAME OVER", "gaming", "labels", ["game over", "lose", "dead", "label"], ["sad"], "cartoon", label("GAME OVER", (60, 60, 60, 255)), "png", "GAME OVER label."),
        ("label-levelup", "LEVEL UP!", "gaming", "labels", ["level up", "win", "xp", "label"], ["excited"], "cartoon", label("LEVEL UP!", (40, 170, 70, 255)), "png", "LEVEL UP! label."),
    ]


PACKS = [
    ("blob-crew", "Blob Crew", "Six moody blob characters plus four comic effects.", blob_crew),
    ("anime-feels", "Anime Feels", "Anime-style faces, chibis, manga effects and backgrounds.", anime_feels),
    ("ribbit-and-friends", "Ribbit & Friends", "Ribbit the frog in every mood, plus cats, dogs and birds.", critters),
    ("internet-folk", "Internet Folk", "Line-art internet archetypes, advice-style backdrops and stamps.", internet_folk),
    ("pixel-quest", "Pixel Quest", "8-bit gaming sprites, sci-fi props and game labels.", pixel_quest),
]


def build_starter():
    shutil.rmtree(STARTER_DIR, ignore_errors=True)
    records = []
    for aid, name, cat, sub, tags, emo, style, img, fmt, desc, *rest in starter_items():
        ext = "jpg" if fmt == "jpg" else "png"
        size, checksum = save(img, os.path.join(STARTER_DIR, f"{aid}.{ext}"), fmt)
        rec = record(aid, name, cat, sub, tags, emo, style, img, fmt, desc, *rest)
        rec["id"] = f"starter-{aid}"
        rec["file"] = {"url": f"/starter/{aid}.{ext}", "thumbnail": f"/starter/{aid}.{ext}", "sizeBytes": size, "checksum": checksum}
        rec["packId"] = "starter"
        rec["packName"] = "Starter kit"
        records.append(rec)
    out = os.path.join(ROOT, "src", "studio", "assets", "starter.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(records, f, indent=1)
    total = sum(r["file"]["sizeBytes"] for r in records)
    print(f"starter: {len(records)} assets, {total / 1024:.0f} KB")


def build_pack(pack_id, pack_name, description, items):
    assets, zipped = [], []
    for aid, name, cat, sub, tags, emo, style, img, fmt, desc, *rest in items:
        ext = "jpg" if fmt == "jpg" else "png"
        size, checksum = save(img, os.path.join(CATALOG_DIR, "assets", f"{aid}.{ext}"), fmt)
        thumb = img.copy()
        thumb.thumbnail((200, 200), Image.LANCZOS)
        save(thumb, os.path.join(CATALOG_DIR, "thumbs", f"{aid}.png"), "png")
        rec = record(aid, name, cat, sub, tags, emo, style, img, fmt, desc, *rest)
        rec["packId"] = pack_id
        rec["packName"] = pack_name
        assets.append({**rec, "file": {"url": f"assets/{aid}.{ext}", "thumbnail": f"thumbs/{aid}.png", "sizeBytes": size, "checksum": checksum}})
        zipped.append((aid, ext, rec))

    # Pack ZIP in the documented layout: manifest.json, preview, assets/, metadata/
    preview = Image.new("RGBA", (600, 300), PAPER)
    for i, (aid, ext, _) in enumerate(zipped[:4]):
        im = Image.open(os.path.join(CATALOG_DIR, "thumbs", f"{aid}.png")).convert("RGBA")
        im.thumbnail((140, 260))
        preview.alpha_composite(im, (10 + i * 148, (300 - im.height) // 2))
    buf = io.BytesIO()
    preview.save(buf, "PNG", optimize=True)
    save(preview, os.path.join(CATALOG_DIR, "packs", f"{pack_id}-preview.png"), "png")
    manifest = {
        "id": pack_id,
        "name": pack_name,
        "description": description + " Original MemeFactory artwork.",
        "author": "MemeFactory",
        "version": "1.0.0",
        "preview": "preview.png",
        "assets": [aid for aid, _, _ in zipped],
        "license": "See individual asset records",
    }
    zpath = os.path.join(CATALOG_DIR, "packs", f"{pack_id}.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, indent=2))
        z.writestr("preview.png", buf.getvalue())
        for aid, ext, rec in zipped:
            z.write(os.path.join(CATALOG_DIR, "assets", f"{aid}.{ext}"), f"assets/{aid}.{ext}")
            z.writestr(f"metadata/{aid}.json", json.dumps({**rec, "file": {"path": f"assets/{aid}.{ext}"}}, indent=2))
    with open(zpath, "rb") as f:
        zbytes = f.read()
    entry = {
        **{k: manifest[k] for k in ("id", "name", "description", "author", "version", "license")},
        "preview": f"packs/{pack_id}-preview.png",
        "downloadUrl": f"packs/{pack_id}.zip",
        "sizeBytes": len(zbytes),
        "checksum": "sha256-" + hashlib.sha256(zbytes).hexdigest(),
        "assetCount": len(zipped),
    }
    return assets, entry


def build_catalog():
    shutil.rmtree(CATALOG_DIR, ignore_errors=True)
    assets, packs = [], []
    for pack_id, name, description, items in PACKS:
        a, entry = build_pack(pack_id, name, description, items())
        assets += a
        packs.append(entry)
        print(f"  pack {pack_id}: {len(a)} assets, {entry['sizeBytes'] / 1024:.0f} KB")
    catalog = {"version": 1, "name": "MemeFactory catalog", "updatedAt": "2026-11-03", "assets": assets, "packs": packs}
    with open(os.path.join(CATALOG_DIR, "catalog.json"), "w") as f:
        json.dump(catalog, f, indent=1)
    with open(os.path.join(CATALOG_DIR, "README.md"), "w") as f:
        f.write(
            "# MemeFactory remote catalog\n\n"
            "Served from GitHub (raw) and read by the Studio's Asset Library. URLs inside\n"
            "`catalog.json` are relative to this folder. Regenerate with\n"
            "`python3 scripts/generate-assets.py` — never hand-edit checksums.\n\n"
            "Only add assets whose licence allows redistribution, and record it in\n"
            "each asset's `licensing` block. Characters owned by someone else (Pepe the\n"
            "Frog, Trollface, Nyan Cat, Doge and other photo memes...) do not belong here;\n"
            "the Studio finds those through online search with their licence shown.\n"
        )
    print(f"catalog: {len(assets)} assets in {len(packs)} packs")


if __name__ == "__main__":
    build_starter()
    build_catalog()
