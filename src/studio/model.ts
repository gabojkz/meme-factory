// Studio project model. Everything stays a separate, editable layer until
// export: images keep their original asset, cutouts store a vector mask.

export const PROJECT_VERSION = 1;

export type Point = [number, number];

export type Asset = {
  id: string;
  name: string;
  /** Original image as a data URL — never modified by edits. */
  src: string;
  width: number;
  height: number;
};

export type MaskPath = {
  points: Point[];
  mode: "add" | "subtract";
};

/** Non-destructive selection in asset pixel coordinates. */
export type Mask = {
  paths: MaskPath[];
  feather: number;
  inverted: boolean;
};

export type Rect = { x: number; y: number; w: number; h: number };

type LayerBase = {
  id: string;
  name: string;
  /** Center of the layer in canvas pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise. */
  rotation: number;
  opacity: number;
  flipX: boolean;
  flipY: boolean;
  hidden: boolean;
  locked: boolean;
};

export type ImageLayer = LayerBase & {
  kind: "image";
  assetId: string;
  mask: Mask | null;
  /** Region of the asset shown by this layer (the cutout bounds). */
  crop: Rect;
};

export type TextAlign = "left" | "center" | "right";

export type TextLayer = LayerBase & {
  kind: "text";
  text: string;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
  color: string;
  stroke: string;
  strokeWidth: number;
  background: string | null;
  align: TextAlign;
  lineHeight: number;
};

export type ShapeKind = "rect" | "ellipse" | "triangle" | "line" | "arrow" | "speech" | "cloud";

export type ShapeLayer = LayerBase & {
  kind: "shape";
  shape: ShapeKind;
  fill: string | null;
  stroke: string;
  strokeWidth: number;
  radius: number;
};

export type Layer = ImageLayer | TextLayer | ShapeLayer;

export type Project = {
  version: number;
  id: string;
  name: string;
  width: number;
  height: number;
  /** `null` means transparent. */
  background: string | null;
  assets: Record<string, Asset>;
  /** Bottom-most layer first. */
  layers: Layer[];
  updatedAt: string;
};

export const CANVAS_PRESETS = [
  { label: "Square", width: 1080, height: 1080 },
  { label: "Classic", width: 1200, height: 1200 },
  { label: "Landscape", width: 1920, height: 1080 },
  { label: "Portrait", width: 1080, height: 1920 },
];

export const FONTS = [
  "Impact",
  "Arial Black",
  "Arial",
  "Helvetica",
  "Comic Neue",
  "Fredoka",
  "Georgia",
  "Courier New",
];

export const STICKERS = ["😂", "💀", "🔥", "👀", "😭", "🤡", "💯", "👍", "🙃", "😎", "❤️", "⭐"];

export function uid(): string {
  return crypto.randomUUID();
}

export function newProject(width: number, height: number, name = "Untitled meme"): Project {
  return {
    version: PROJECT_VERSION,
    id: uid(),
    name,
    width,
    height,
    background: "#ffffff",
    assets: {},
    layers: [],
    updatedAt: new Date().toISOString(),
  };
}

/** Upgrades older saved projects. Bump PROJECT_VERSION when the shape changes. */
export function migrateProject(raw: unknown): Project {
  const p = raw as Partial<Project>;
  if (!p || typeof p !== "object" || !p.id || !Array.isArray(p.layers)) {
    throw new Error("Not a MemeFactory project");
  }
  if ((p.version ?? 0) > PROJECT_VERSION) {
    throw new Error("Project was saved by a newer MemeFactory");
  }
  return {
    ...newProject(p.width ?? 1080, p.height ?? 1080),
    ...p,
    version: PROJECT_VERSION,
  } as Project;
}

function base(name: string, x: number, y: number, width: number, height: number) {
  return {
    id: uid(),
    name,
    x,
    y,
    width,
    height,
    rotation: 0,
    opacity: 1,
    flipX: false,
    flipY: false,
    hidden: false,
    locked: false,
  };
}

/** Fits an asset (or part of it) into the canvas, at most `fill` of its size. */
export function imageLayer(
  project: Project,
  asset: Asset,
  opts?: { mask?: Mask | null; crop?: Rect; fill?: number },
): ImageLayer {
  const crop = opts?.crop ?? { x: 0, y: 0, w: asset.width, h: asset.height };
  const fill = opts?.fill ?? 0.8;
  const scale = Math.min(1, (project.width * fill) / crop.w, (project.height * fill) / crop.h);
  return {
    ...base(opts?.mask ? `Cutout · ${asset.name}` : asset.name, project.width / 2, project.height / 2, crop.w * scale, crop.h * scale),
    kind: "image",
    assetId: asset.id,
    mask: opts?.mask ?? null,
    crop,
  };
}

export type TextPreset = "top" | "bottom" | "caption" | "plain";

export function textLayer(project: Project, preset: TextPreset = "plain", text?: string): TextLayer {
  const w = project.width * 0.9;
  const size = Math.round(Math.min(project.width, project.height) * 0.09);
  const meme: Omit<TextLayer, keyof LayerBase | "kind"> = {
    text: text ?? "YOUR TEXT HERE",
    fontFamily: "Impact",
    fontSize: size,
    bold: false,
    italic: false,
    uppercase: true,
    color: "#ffffff",
    stroke: "#000000",
    strokeWidth: Math.max(2, Math.round(size / 10)),
    background: null,
    align: "center",
    lineHeight: 1.1,
  };
  let y = project.height / 2;
  let props = meme;
  if (preset === "top") y = size;
  if (preset === "bottom") y = project.height - size;
  if (preset === "caption") {
    props = {
      ...meme,
      text: text ?? "When the meme hits different",
      fontFamily: "Arial",
      bold: true,
      uppercase: false,
      color: "#000000",
      strokeWidth: 0,
      background: "#ffffff",
      fontSize: Math.round(size * 0.6),
    };
  }
  if (preset === "plain") {
    props = { ...meme, text: text ?? "Text", fontFamily: "Arial", bold: true, uppercase: false, color: "#121212", strokeWidth: 0 };
  }
  const layer: TextLayer = { ...base("Text", project.width / 2, y, w, size), kind: "text", ...props };
  return fitText(layer);
}

export function stickerLayer(project: Project, emoji: string): TextLayer {
  const size = Math.round(Math.min(project.width, project.height) * 0.2);
  return fitText({
    ...textLayer(project, "plain", emoji),
    name: `Sticker ${emoji}`,
    fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, sans-serif",
    fontSize: size,
    bold: false,
    width: size * 1.4,
  });
}

const SHAPE_NAMES: Partial<Record<ShapeKind, string>> = { speech: "Speech bubble", cloud: "Thought cloud" };

export function shapeLayer(project: Project, shape: ShapeKind): ShapeLayer {
  const s = Math.min(project.width, project.height) * 0.3;
  const thin = shape === "line" || shape === "arrow";
  if (shape === "speech" || shape === "cloud") {
    return {
      ...base(SHAPE_NAMES[shape]!, project.width / 2, project.height / 2, s * 1.5, s),
      kind: "shape",
      shape,
      fill: "#ffffff",
      stroke: "#121212",
      strokeWidth: Math.max(4, Math.round(s / 40)),
      radius: 0,
    };
  }
  return {
    ...base(shape[0].toUpperCase() + shape.slice(1), project.width / 2, project.height / 2, s, thin ? s * 0.25 : s),
    kind: "shape",
    shape,
    fill: thin ? null : "#ffe566",
    stroke: thin ? "#ff3b3b" : "#121212",
    strokeWidth: Math.max(4, Math.round(s / 30)),
    radius: 0,
  };
}

// ---------------------------------------------------------------- text layout

const measureCtx = document.createElement("canvas").getContext("2d")!;

export function textFont(l: TextLayer, size = l.fontSize): string {
  const family = l.fontFamily.includes(",") ? l.fontFamily : `"${l.fontFamily}", Impact, sans-serif`;
  return `${l.italic ? "italic " : ""}${l.bold ? "700 " : ""}${size}px ${family}`;
}

/** Wraps text to the layer width. Returns lines and the resulting box height. */
export function layoutText(l: TextLayer): { lines: string[]; height: number; lineHeightPx: number } {
  measureCtx.font = textFont(l);
  const raw = l.uppercase ? l.text.toUpperCase() : l.text;
  const lines: string[] = [];
  for (const para of raw.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = words[0];
    for (const word of words.slice(1)) {
      const next = `${line} ${word}`;
      if (measureCtx.measureText(next).width > l.width) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  const lineHeightPx = l.fontSize * l.lineHeight;
  const pad = l.background ? l.fontSize * 0.3 : 0;
  return { lines, lineHeightPx, height: Math.max(lineHeightPx, lines.length * lineHeightPx) + pad * 2 };
}

/** Text height follows its content; call after changing text properties. */
export function fitText<T extends Layer>(layer: T): T {
  if (layer.kind !== "text") return layer;
  return { ...layer, height: layoutText(layer).height };
}

/** Plain text of all visible text layers, used as searchable OCR text. */
export function projectText(project: Project): string {
  return project.layers
    .filter((l): l is TextLayer => l.kind === "text" && !l.hidden)
    .map((l) => l.text.replace(/\s+/g, " ").trim())
    .filter((t) => t && !/^\p{Extended_Pictographic}+$/u.test(t))
    .join(" ");
}

// ------------------------------------------------------------------ geometry

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Converts a canvas point into the layer's local (unrotated, centered) space. */
export function toLocal(l: Layer, px: number, py: number): Point {
  const dx = px - l.x;
  const dy = py - l.y;
  const c = Math.cos(-rad(l.rotation));
  const s = Math.sin(-rad(l.rotation));
  return [dx * c - dy * s, dx * s + dy * c];
}

export function toWorld(l: Layer, lx: number, ly: number): Point {
  const c = Math.cos(rad(l.rotation));
  const s = Math.sin(rad(l.rotation));
  return [l.x + lx * c - ly * s, l.y + lx * s + ly * c];
}

export function hitLayer(l: Layer, px: number, py: number, slop = 0): boolean {
  const [lx, ly] = toLocal(l, px, py);
  return Math.abs(lx) <= l.width / 2 + slop && Math.abs(ly) <= l.height / 2 + slop;
}

export type Handle = "nw" | "ne" | "sw" | "se" | "rotate";

export const CORNERS: Record<Exclude<Handle, "rotate">, Point> = {
  nw: [-1, -1],
  ne: [1, -1],
  sw: [-1, 1],
  se: [1, 1],
};

/** Handle positions in canvas pixels. `rotateOffset` is in canvas pixels too. */
export function handlePoints(l: Layer, rotateOffset: number): Record<Handle, Point> {
  const hw = l.width / 2;
  const hh = l.height / 2;
  return {
    nw: toWorld(l, -hw, -hh),
    ne: toWorld(l, hw, -hh),
    sw: toWorld(l, -hw, hh),
    se: toWorld(l, hw, hh),
    rotate: toWorld(l, 0, -hh - rotateOffset),
  };
}

/** Resizes from a corner while the opposite corner stays put. */
export function resizeFromCorner<T extends Layer>(
  start: T,
  handle: Exclude<Handle, "rotate">,
  px: number,
  py: number,
  keepRatio: boolean,
): T {
  const [sx, sy] = CORNERS[handle];
  const [lx, ly] = toLocal(start, px, py);
  const ox = -sx * (start.width / 2);
  const oy = -sy * (start.height / 2);
  const min = 8;
  let w = Math.max(min, (lx - ox) * sx);
  let h = Math.max(min, (ly - oy) * sy);
  if (keepRatio) {
    const k = Math.max(w / start.width, h / start.height);
    w = Math.max(min, start.width * k);
    h = Math.max(min, start.height * k);
  }
  const [cx, cy] = toWorld(start, ox + (sx * w) / 2, oy + (sy * h) / 2);
  if (start.kind === "text") {
    const k = w / start.width;
    return fitText({
      ...start,
      x: cx,
      y: cy,
      width: w,
      fontSize: Math.max(4, Math.round(start.fontSize * k)),
      strokeWidth: Math.round(start.strokeWidth * k),
    });
  }
  return { ...start, x: cx, y: cy, width: w, height: h };
}

export function maskBounds(mask: Mask, asset: Asset): Rect {
  const full = { x: 0, y: 0, w: asset.width, h: asset.height };
  if (mask.inverted) return full;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of mask.paths) {
    if (path.mode !== "add") continue;
    for (const [x, y] of path.points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return full;
  const pad = mask.feather;
  const x = Math.max(0, Math.floor(minX - pad));
  const y = Math.max(0, Math.floor(minY - pad));
  return {
    x,
    y,
    w: Math.max(1, Math.min(asset.width, Math.ceil(maxX + pad)) - x),
    h: Math.max(1, Math.min(asset.height, Math.ceil(maxY + pad)) - y),
  };
}

export function hasSelection(mask: Mask): boolean {
  return mask.inverted || mask.paths.some((p) => p.mode === "add" && p.points.length >= 3);
}
