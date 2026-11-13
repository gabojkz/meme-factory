import { layoutText, textFont, type Asset, type Point, type ImageLayer, type Layer, type Mask, type Project, type Rect, type ShapeLayer, type TextLayer } from "./model";

// ------------------------------------------------------------- image loading

const images = new Map<string, HTMLImageElement>();
const pending = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = images.get(src);
  if (cached) return Promise.resolve(cached);
  let p = pending.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        images.set(src, img);
        pending.delete(src);
        resolve(img);
      };
      img.onerror = () => {
        pending.delete(src);
        reject(new Error("Couldn’t load image"));
      };
      img.src = src;
    });
    pending.set(src, p);
  }
  return p;
}

/** Returns the decoded image if ready, otherwise starts loading it. */
function readyImage(src: string, onLoad?: () => void): HTMLImageElement | null {
  const img = images.get(src);
  if (img) return img;
  loadImage(src).then(() => onLoad?.(), () => {});
  return null;
}

/** Frees decoded images that no open project references any more. */
export function pruneImages(keep: Iterable<string>) {
  const live = new Set(keep);
  for (const src of images.keys()) if (!live.has(src)) images.delete(src);
  cutouts.clear();
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const MAX_ASSET_SIDE = 4096;

/** Decodes bytes into an asset, downscaling huge images to keep projects light. */
export async function assetFromBlob(blob: Blob, name: string): Promise<Asset> {
  if (!blob.type.startsWith("image/") && blob.type !== "") {
    throw new Error(`${name} isn’t an image`);
  }
  let src = await blobToDataUrl(blob);
  let img = await loadImage(src).catch(() => {
    throw new Error(`Couldn’t read ${name} — unsupported or broken image`);
  });
  const side = Math.max(img.naturalWidth, img.naturalHeight);
  if (side > MAX_ASSET_SIDE) {
    const k = MAX_ASSET_SIDE / side;
    const c = document.createElement("canvas");
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    src = c.toDataURL("image/png");
    img = await loadImage(src);
  }
  return {
    id: crypto.randomUUID(),
    name: name.replace(/\.[^.]+$/, "").slice(0, 60) || "Image",
    src,
    width: img.naturalWidth,
    height: img.naturalHeight,
  };
}

// ------------------------------------------------------------------- masks

/**
 * Paints a mask (white = keep) for the given asset region. Feathering uses the
 * shadow-blur trick because `ctx.filter` isn't available in every webview.
 */
export function paintMask(ctx: CanvasRenderingContext2D, mask: Mask, crop: Rect, scale = 1) {
  const OFF = 100000;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-crop.x, -crop.y);
  if (mask.inverted) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(crop.x, crop.y, crop.w, crop.h);
  }
  const feather = mask.feather * scale;
  for (const path of mask.paths) {
    if (path.points.length < 3) continue;
    const add = path.mode === "add" !== mask.inverted;
    ctx.globalCompositeOperation = add ? "source-over" : "destination-out";
    ctx.beginPath();
    for (const [x, y] of path.points) ctx.lineTo(x - (feather ? OFF : 0), y);
    ctx.closePath();
    if (feather) {
      ctx.shadowColor = "#fff";
      ctx.shadowBlur = feather;
      ctx.shadowOffsetX = OFF * scale;
      ctx.fillStyle = "#fff";
    } else {
      ctx.fillStyle = "#fff";
    }
    ctx.fill();
  }
  ctx.restore();
}

const cutouts = new Map<string, HTMLCanvasElement>();

/** Renders the masked, cropped region of an asset into a transparent canvas. */
export function renderCutout(img: HTMLImageElement, assetId: string, mask: Mask | null, crop: Rect): HTMLCanvasElement {
  const key = `${assetId}|${JSON.stringify(crop)}|${JSON.stringify(mask)}`;
  const hit = cutouts.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(crop.w));
  c.height = Math.max(1, Math.round(crop.h));
  const ctx = c.getContext("2d")!;
  if (mask) {
    paintMask(ctx, mask, crop);
    ctx.globalCompositeOperation = "source-in";
  }
  ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);
  if (cutouts.size > 64) cutouts.delete(cutouts.keys().next().value!);
  cutouts.set(key, c);
  return c;
}

// --------------------------------------------------------------- drawing

function drawImageLayer(ctx: CanvasRenderingContext2D, l: ImageLayer, project: Project, onLoad?: () => void) {
  const asset = project.assets[l.assetId];
  if (!asset) return;
  const img = readyImage(asset.src, onLoad);
  if (!img) return;
  const w = l.width;
  const h = l.height;
  if (l.mask) {
    ctx.drawImage(renderCutout(img, asset.id, l.mask, l.crop), -w / 2, -h / 2, w, h);
  } else {
    const c = l.crop;
    ctx.drawImage(img, c.x, c.y, c.w, c.h, -w / 2, -h / 2, w, h);
  }
}

function drawTextLayer(ctx: CanvasRenderingContext2D, l: TextLayer) {
  const { lines, lineHeightPx, height } = layoutText(l);
  const w = l.width;
  if (l.background) {
    ctx.fillStyle = l.background;
    ctx.fillRect(-w / 2, -height / 2, w, height);
  }
  ctx.font = textFont(l);
  ctx.textAlign = l.align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  const x = l.align === "left" ? -w / 2 : l.align === "right" ? w / 2 : 0;
  const top = -(lines.length * lineHeightPx) / 2 + lineHeightPx / 2;
  lines.forEach((line, i) => {
    const y = top + i * lineHeightPx;
    if (l.strokeWidth > 0) {
      ctx.strokeStyle = l.stroke;
      ctx.lineWidth = l.strokeWidth * 2;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = l.color;
    ctx.fillText(line, x, y);
  });
}

function drawShapeLayer(ctx: CanvasRenderingContext2D, l: ShapeLayer) {
  const w = l.width;
  const h = l.height;
  const sw = l.strokeWidth;
  ctx.lineWidth = sw;
  ctx.strokeStyle = l.stroke;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  if (l.shape === "line" || l.shape === "arrow") {
    const head = Math.min(h / 2, w / 3, sw * 4 + 10);
    const end = l.shape === "arrow" ? w / 2 - head * 0.6 : w / 2;
    ctx.moveTo(-w / 2 + sw / 2, 0);
    ctx.lineTo(end, 0);
    ctx.stroke();
    if (l.shape === "arrow") {
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2 - head * 1.4, -head);
      ctx.lineTo(w / 2 - head * 1.4, head);
      ctx.closePath();
      ctx.fillStyle = l.stroke;
      ctx.fill();
    }
    return;
  }
  const iw = Math.max(0, w - sw);
  const ih = Math.max(0, h - sw);
  if (l.shape === "cloud") {
    drawCloud(ctx, l, iw, ih);
    return;
  }
  if (l.shape === "speech") {
    // Oval body in the top ~80%, tail pointing to the bottom-left corner
    // (flip the layer to move the tail). One path, so no seam at the joint.
    const cy = -ih * 0.1;
    const rx = iw / 2;
    const ry = ih * 0.4;
    const a1 = (100 * Math.PI) / 180;
    const a2 = (125 * Math.PI) / 180;
    ctx.ellipse(0, cy, rx, ry, 0, a2, a1 + Math.PI * 2);
    ctx.lineTo(-iw * 0.34, ih / 2);
    ctx.closePath();
  } else if (l.shape === "rect") {
    ctx.roundRect(-iw / 2, -ih / 2, iw, ih, Math.min(l.radius, iw / 2, ih / 2));
  } else if (l.shape === "ellipse") {
    ctx.ellipse(0, 0, iw / 2, ih / 2, 0, 0, Math.PI * 2);
  } else {
    ctx.moveTo(0, -ih / 2);
    ctx.lineTo(iw / 2, ih / 2);
    ctx.lineTo(-iw / 2, ih / 2);
    ctx.closePath();
  }
  if (l.fill) {
    ctx.fillStyle = l.fill;
    ctx.fill();
  }
  if (sw > 0) ctx.stroke();
}

/**
 * Outline of a cloud: bump circles spaced evenly along an ellipse, joined at
 * their outer intersection points so the result is one clean closed path.
 */
function cloudPath(ctx: CanvasRenderingContext2D, cy: number, rx: number, ry: number) {
  const br = Math.min(rx, ry) * 0.42;
  const ex = rx - br;
  const ey = ry - br;
  // Sample the ellipse to place bumps at equal arc length.
  const samples: Point[] = [];
  for (let i = 0; i <= 360; i++) {
    const a = (i / 360) * Math.PI * 2;
    samples.push([ex * Math.cos(a), cy + ey * Math.sin(a)]);
  }
  const lens = [0];
  for (let i = 1; i < samples.length; i++) {
    lens.push(lens[i - 1] + Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]));
  }
  const total = lens[lens.length - 1];
  const n = Math.max(7, Math.round(total / (br * 1.5)));
  const circles: [number, number, number][] = [];
  for (let i = 0, j = 0; i < n; i++) {
    const target = (i / n) * total;
    while (lens[j + 1] < target) j++;
    const r = br * (i % 2 ? 0.9 : 1.1);
    circles.push([samples[j][0], samples[j][1], r]);
  }
  // Outer intersection of each circle with the next one.
  const joints: Point[] = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1, r1] = circles[i];
    const [x2, y2, r2] = circles[(i + 1) % n];
    const d = Math.hypot(x2 - x1, y2 - y1);
    if (d >= r1 + r2 || d <= Math.abs(r1 - r2)) {
      ctx.ellipse(0, cy, rx, ry, 0, 0, Math.PI * 2); // degenerate: plain oval
      return;
    }
    const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
    const h = Math.sqrt(r1 * r1 - a * a);
    const mx = x1 + (a * (x2 - x1)) / d;
    const my = y1 + (a * (y2 - y1)) / d;
    const p1: Point = [mx + (h * (y2 - y1)) / d, my - (h * (x2 - x1)) / d];
    const p2: Point = [mx - (h * (y2 - y1)) / d, my + (h * (x2 - x1)) / d];
    const out = (p: Point) => (p[0] / rx) ** 2 + ((p[1] - cy) / ry) ** 2;
    joints.push(out(p1) > out(p2) ? p1 : p2);
  }
  // Each bump contributes the arc between its two joints, around the outside.
  for (let i = 0; i < n; i++) {
    const [x, y, r] = circles[i];
    const from = joints[(i - 1 + n) % n];
    const to = joints[i];
    ctx.arc(x, y, r, Math.atan2(from[1] - y, from[0] - x), Math.atan2(to[1] - y, to[0] - x), false);
  }
  ctx.closePath();
}

/** Thought cloud with a trail of bubbles towards the bottom-left. */
function drawCloud(ctx: CanvasRenderingContext2D, l: ShapeLayer, iw: number, ih: number) {
  ctx.beginPath();
  cloudPath(ctx, -ih * 0.12, iw / 2, ih * 0.38);
  const r = Math.min(iw, ih);
  ctx.moveTo(-iw * 0.24 + r * 0.07, ih * 0.33);
  ctx.arc(-iw * 0.24, ih * 0.33, r * 0.07, 0, Math.PI * 2);
  ctx.moveTo(-iw * 0.36 + r * 0.045, ih * 0.45);
  ctx.arc(-iw * 0.36, ih * 0.45, r * 0.045, 0, Math.PI * 2);
  if (l.fill) {
    ctx.fillStyle = l.fill;
    ctx.fill();
  }
  if (l.strokeWidth > 0) ctx.stroke();
}

export function drawLayer(ctx: CanvasRenderingContext2D, l: Layer, project: Project, onLoad?: () => void) {
  if (l.hidden) return;
  ctx.save();
  ctx.globalAlpha = l.opacity;
  ctx.translate(l.x, l.y);
  ctx.rotate((l.rotation * Math.PI) / 180);
  ctx.scale(l.flipX ? -1 : 1, l.flipY ? -1 : 1);
  if (l.kind === "image") drawImageLayer(ctx, l, project, onLoad);
  else if (l.kind === "text") drawTextLayer(ctx, l);
  else drawShapeLayer(ctx, l);
  ctx.restore();
}

/** Draws the project in canvas coordinates; the caller sets up any scaling. */
export function drawProject(ctx: CanvasRenderingContext2D, project: Project, onLoad?: () => void) {
  if (project.background) {
    ctx.fillStyle = project.background;
    ctx.fillRect(0, 0, project.width, project.height);
  }
  for (const layer of project.layers) drawLayer(ctx, layer, project, onLoad);
}

/** Makes sure every asset is decoded so a one-shot render (export) is complete. */
export async function preloadAssets(project: Project) {
  await Promise.all(Object.values(project.assets).map((a) => loadImage(a.src)));
  await document.fonts?.ready;
}

export type ExportFormat = "png" | "jpeg" | "webp";

export async function exportProject(project: Project, format: ExportFormat = "png", scale = 1, quality = 0.92): Promise<Blob> {
  await preloadAssets(project);
  const c = document.createElement("canvas");
  c.width = Math.round(project.width * scale);
  c.height = Math.round(project.height * scale);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  if (format === "jpeg" && !project.background) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.scale(scale, scale);
  drawProject(ctx, project);
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, `image/${format}`, quality));
  if (!blob) throw new Error("Export failed — the image may be too large");
  // Some webviews (Safari/WebKit) silently fall back to PNG for WebP.
  if (blob.type !== `image/${format}`) throw new Error(`${format.toUpperCase()} isn’t supported here — try PNG`);
  return blob;
}

export async function thumbnailDataUrl(project: Project, maxSide = 360): Promise<string> {
  const scale = Math.min(1, maxSide / Math.max(project.width, project.height));
  return blobToDataUrl(await exportProject(project, "png", scale));
}
