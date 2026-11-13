import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import CutoutEditor from "./CutoutEditor";
import LibraryPicker from "./LibraryPicker";
import AssetLibrary from "./assets/AssetLibrary";
import { fetchImage, hasExternalPayload, readTransfer } from "../quickAdd";
import { videoFrames } from "../videoToGif";
import { isBackground, toProjectAsset, type LibraryAsset } from "./assets/library";
import {
  CANVAS_PRESETS,
  FONTS,
  STICKERS,
  fitText,
  handlePoints,
  hitLayer,
  imageLayer,
  maskBounds,
  projectText,
  resizeFromCorner,
  shapeLayer,
  stickerLayer,
  textLayer,
  uid,
  type Asset,
  type Handle,
  type ImageLayer,
  type Layer,
  type Mask,
  type Point,
  type Project,
  type ShapeKind,
  type TextPreset,
} from "./model";
import { assetFromBlob, blobToDataUrl, drawProject, exportProject, pruneImages, thumbnailDataUrl, type ExportFormat } from "./render";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

export async function assetFromPath(path: string): Promise<Asset> {
  const name = path.split(/[\\/]/).pop() ?? "Image";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (!MIME[ext]) throw new Error(`${name}: unsupported file type`);
  const bytes = await readFile(path);
  if (bytes.byteLength > 50 * 1024 * 1024) throw new Error(`${name} is larger than 50 MB`);
  return assetFromBlob(new Blob([bytes], { type: MIME[ext] }), name);
}

const MARGIN = 48;
const HANDLE = 7;
const ROTATE_GAP = 28;
const SNAP = 8;
const HISTORY_LIMIT = 100;

type History = { past: Project[]; present: Project; future: Project[]; key: string | null };

type Gesture =
  | { type: "move"; start: Layer; from: Point }
  | { type: "resize"; start: Layer; handle: Exclude<Handle, "rotate"> }
  | { type: "rotate"; start: Layer };

type Props = {
  initial: Project;
  active: boolean;
  setStatus: (s: string) => void;
  onClose: () => void;
  onSaved: () => void;
  onLibraryChanged: () => void;
};

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export default function StudioEditor({ initial, active, setStatus, onClose, onSaved, onLibraryChanged }: Props) {
  const [hist, setHist] = useState<History>({ past: [], present: initial, future: [], key: null });
  const project = hist.present;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [fit, setFit] = useState(0.5);
  const [cutout, setCutout] = useState<{ assetId: string; layerId: string | null } | null>(null);
  const [picker, setPicker] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const [format, setFormat] = useState<ExportFormat>("png");
  const [tick, setTick] = useState(0);
  const [savedVersion, setSavedVersion] = useState<Project>(initial);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const gestureBase = useRef<Project | null>(null);
  const clipboard = useRef<Layer | null>(null);
  const pasteHandled = useRef(false);

  const scale = zoom ?? fit;
  const selected = project.layers.find((l) => l.id === selectedId) ?? null;
  const dirty = project !== savedVersion;

  // ------------------------------------------------------------- history

  const commit = useCallback((fn: (p: Project) => Project, key?: string) => {
    setHist((h) => {
      const next = fn(h.present);
      if (next === h.present) return h;
      const merge = key != null && key === h.key;
      return {
        past: merge ? h.past : [...h.past, h.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
        key: key ?? null,
      };
    });
  }, []);

  const setLive = useCallback((fn: (p: Project) => Project) => {
    setHist((h) => ({ ...h, present: fn(h.present) }));
  }, []);

  const endGesture = useCallback(() => {
    const base = gestureBase.current;
    gestureBase.current = null;
    setHist((h) =>
      base && h.present !== base
        ? { past: [...h.past, base].slice(-HISTORY_LIMIT), present: h.present, future: [], key: null }
        : h,
    );
  }, []);

  const undo = useCallback(() => {
    setHist((h) =>
      h.past.length
        ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], key: null }
        : h,
    );
  }, []);

  const redo = useCallback(() => {
    setHist((h) =>
      h.future.length
        ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), key: null }
        : h,
    );
  }, []);

  const updateLayer = useCallback(
    (id: string, patch: Partial<Layer>, key?: string) => {
      commit(
        (p) => ({
          ...p,
          layers: p.layers.map((l) => (l.id === id ? fitText({ ...l, ...patch } as Layer) : l)),
        }),
        key,
      );
    },
    [commit],
  );

  const addLayer = useCallback(
    (layer: Layer, assets?: Asset[]) => {
      commit((p) => ({
        ...p,
        assets: assets ? { ...p.assets, ...Object.fromEntries(assets.map((a) => [a.id, a])) } : p.assets,
        layers: [...p.layers, layer],
      }));
      setSelectedId(layer.id);
    },
    [commit],
  );

  const deleteLayer = useCallback(
    (id: string) => {
      commit((p) => ({ ...p, layers: p.layers.filter((l) => l.id !== id) }));
      setSelectedId((s) => (s === id ? null : s));
    },
    [commit],
  );

  const duplicateLayer = useCallback(
    (layer: Layer, offset = 24) => {
      const copy = { ...layer, id: uid(), name: `${layer.name} copy`, x: layer.x + offset, y: layer.y + offset, locked: false };
      commit((p) => {
        const i = p.layers.findIndex((l) => l.id === layer.id);
        const layers = [...p.layers];
        layers.splice(i < 0 ? layers.length : i + 1, 0, copy);
        return { ...p, layers };
      });
      setSelectedId(copy.id);
    },
    [commit],
  );

  const moveLayer = useCallback(
    (id: string, to: number | "up" | "down" | "top" | "bottom") => {
      commit((p) => {
        const from = p.layers.findIndex((l) => l.id === id);
        if (from < 0) return p;
        const last = p.layers.length - 1;
        const target =
          to === "up" ? from + 1 : to === "down" ? from - 1 : to === "top" ? last : to === "bottom" ? 0 : to;
        const dest = Math.max(0, Math.min(last, target));
        if (dest === from) return p;
        const layers = [...p.layers];
        const [item] = layers.splice(from, 1);
        layers.splice(dest, 0, item);
        return { ...p, layers };
      });
    },
    [commit],
  );

  // --------------------------------------------------------------- assets

  const addAssets = useCallback(
    (assets: Asset[], at?: Point) => {
      if (!assets.length) return;
      const layers = assets.map((a, i) => {
        const l = imageLayer(project, a);
        return at ? { ...l, x: at[0] + i * 24, y: at[1] + i * 24 } : { ...l, x: l.x + i * 24, y: l.y + i * 24 };
      });
      commit((p) => ({
        ...p,
        assets: { ...p.assets, ...Object.fromEntries(assets.map((a) => [a.id, a])) },
        layers: [...p.layers, ...layers],
      }));
      setSelectedId(layers[layers.length - 1].id);
      setStatus(assets.length === 1 ? `Added ${assets[0].name}` : `Added ${assets.length} images`);
    },
    [commit, project, setStatus],
  );

  const addFromPaths = useCallback(
    async (paths: string[], at?: Point) => {
      const assets: Asset[] = [];
      for (const path of paths) {
        try {
          assets.push(await assetFromPath(path));
        } catch (e) {
          setStatus(errText(e));
        }
      }
      addAssets(assets, at);
    },
    [addAssets, setStatus],
  );

  /**
   * Single insertion path for every Asset Library source. Assets are ~30% of
   * the canvas width (backgrounds cover the canvas and go to the bottom).
   * `at` is a screen point from a drag; drops outside the canvas are ignored.
   */
  const insertLibraryAsset = useCallback(
    async (lib: LibraryAsset, at?: { x: number; y: number }) => {
      let point: Point | undefined;
      if (at) {
        const r = canvasRef.current?.getBoundingClientRect();
        const stage = stageRef.current?.getBoundingClientRect();
        const inside = (b?: DOMRect) => !!b && at.x >= b.left && at.x <= b.right && at.y >= b.top && at.y <= b.bottom;
        if (!r || !inside(stage)) return;
        point = [(at.x - r.left - MARGIN) / scale, (at.y - r.top - MARGIN) / scale];
      }
      setStatus(`Adding ${lib.name}…`);
      const asset = await toProjectAsset(lib);
      const background = isBackground(lib);
      let layer = imageLayer(project, asset);
      if (background) {
        const k = Math.max(project.width / asset.width, project.height / asset.height);
        layer = { ...layer, width: asset.width * k, height: asset.height * k, name: lib.name };
      } else {
        const w = project.width * 0.3;
        layer = { ...layer, width: w, height: (w * asset.height) / asset.width, name: lib.name };
        if (point) layer = { ...layer, x: point[0], y: point[1] };
      }
      commit((p) => ({
        ...p,
        assets: { ...p.assets, [asset.id]: asset },
        layers: background ? [layer, ...p.layers] : [...p.layers, layer],
      }));
      setSelectedId(layer.id);
      setStatus(`Added ${lib.name}`);
    },
    [commit, project, scale, setStatus],
  );

  /** Swaps the selected image for a library asset, keeping its transform. */
  const replaceWithLibraryAsset = useCallback(
    async (lib: LibraryAsset) => {
      const target = project.layers.find((l) => l.id === selectedId);
      if (target?.kind !== "image") return;
      const asset = await toProjectAsset(lib);
      commit((p) => ({
        ...p,
        assets: { ...p.assets, [asset.id]: asset },
        layers: p.layers.map((l) =>
          l.id === target.id && l.kind === "image"
            ? {
                ...l,
                assetId: asset.id,
                name: lib.name,
                mask: null,
                crop: { x: 0, y: 0, w: asset.width, h: asset.height },
                height: (l.width * asset.height) / asset.width,
              }
            : l,
        ),
      }));
      setStatus(`Replaced with ${lib.name}`);
    },
    [commit, project.layers, selectedId, setStatus],
  );

  async function onPickImages() {
    const picked = await open({ multiple: true, filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] });
    if (!picked) return;
    await addFromPaths(Array.isArray(picked) ? picked : [picked]);
  }

  // Free decoded images from closed projects / deleted assets.
  useEffect(() => () => pruneImages([]), []);

  // ----------------------------------------------------------- canvas fit

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth - MARGIN * 2 - 16;
      const h = el.clientHeight - MARGIN * 2 - 16;
      setFit(Math.max(0.05, Math.min(w / project.width, h / project.height, 1)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height]);

  // --------------------------------------------------------------- render

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(project.width * scale) + MARGIN * 2;
    const h = Math.round(project.height * scale) + MARGIN * 2;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const pw = project.width * scale;
    const ph = project.height * scale;
    ctx.save();
    ctx.fillStyle = "rgba(18,18,18,0.9)";
    ctx.fillRect(MARGIN + 6, MARGIN + 6, pw, ph);
    ctx.beginPath();
    ctx.rect(MARGIN, MARGIN, pw, ph);
    ctx.clip();
    if (!project.background) {
      const cell = 12;
      for (let y = 0; y < ph; y += cell) {
        for (let x = 0; x < pw; x += cell) {
          ctx.fillStyle = (x / cell + y / cell) % 2 ? "#e6e6e6" : "#ffffff";
          ctx.fillRect(MARGIN + x, MARGIN + y, cell, cell);
        }
      }
    }
    ctx.translate(MARGIN, MARGIN);
    ctx.scale(scale, scale);
    ctx.imageSmoothingQuality = "high";
    drawProject(ctx, project, () => setTick((t) => t + 1));
    ctx.restore();

    ctx.strokeStyle = "#121212";
    ctx.lineWidth = 3;
    ctx.strokeRect(MARGIN - 1.5, MARGIN - 1.5, pw + 3, ph + 3);

    ctx.strokeStyle = "#ff3b3b";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    if (guides.v) {
      ctx.beginPath();
      ctx.moveTo(MARGIN + pw / 2, MARGIN);
      ctx.lineTo(MARGIN + pw / 2, MARGIN + ph);
      ctx.stroke();
    }
    if (guides.h) {
      ctx.beginPath();
      ctx.moveTo(MARGIN, MARGIN + ph / 2);
      ctx.lineTo(MARGIN + pw, MARGIN + ph / 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    if (selected && !selected.hidden) {
      const pts = handlePoints(selected, ROTATE_GAP / scale);
      const s = (p: Point): Point => [MARGIN + p[0] * scale, MARGIN + p[1] * scale];
      const [nw, ne, se, sw] = [s(pts.nw), s(pts.ne), s(pts.se), s(pts.sw)];
      ctx.beginPath();
      ctx.moveTo(...nw);
      ctx.lineTo(...ne);
      ctx.lineTo(...se);
      ctx.lineTo(...sw);
      ctx.closePath();
      ctx.strokeStyle = selected.locked ? "#ff3b3b" : "#2ec4ff";
      ctx.lineWidth = 2;
      ctx.stroke();
      if (!selected.locked) {
        const top = s(toMid(pts.nw, pts.ne));
        const rot = s(pts.rotate);
        ctx.beginPath();
        ctx.moveTo(...top);
        ctx.lineTo(...rot);
        ctx.stroke();
        for (const p of [nw, ne, se, sw]) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(p[0] - HANDLE / 2 - 1, p[1] - HANDLE / 2 - 1, HANDLE + 2, HANDLE + 2);
          ctx.strokeStyle = "#121212";
          ctx.strokeRect(p[0] - HANDLE / 2 - 1, p[1] - HANDLE / 2 - 1, HANDLE + 2, HANDLE + 2);
        }
        ctx.beginPath();
        ctx.arc(rot[0], rot[1], HANDLE, 0, Math.PI * 2);
        ctx.fillStyle = "#ffe566";
        ctx.fill();
        ctx.strokeStyle = "#121212";
        ctx.stroke();
      }
    }
  }, [project, scale, selected, guides, tick]);

  // -------------------------------------------------------------- pointer

  function toCanvas(e: { clientX: number; clientY: number }): Point {
    const r = canvasRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left - MARGIN) / scale, (e.clientY - r.top - MARGIN) / scale];
  }

  function handleAt(l: Layer, p: Point): Handle | null {
    if (l.locked || l.hidden) return null;
    const pts = handlePoints(l, ROTATE_GAP / scale);
    const radius = (HANDLE + 4) / scale;
    for (const h of ["rotate", "nw", "ne", "sw", "se"] as Handle[]) {
      if (Math.hypot(pts[h][0] - p[0], pts[h][1] - p[1]) <= radius) return h;
    }
    return null;
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
    const p = toCanvas(e);
    const handle = selected ? handleAt(selected, p) : null;
    let target: Layer | null = null;
    if (selected && handle) {
      target = selected;
      gesture.current =
        handle === "rotate" ? { type: "rotate", start: selected } : { type: "resize", start: selected, handle };
    } else {
      const slop = 4 / scale;
      target = [...project.layers].reverse().find((l) => !l.hidden && !l.locked && hitLayer(l, p[0], p[1], slop)) ?? null;
      setSelectedId(target?.id ?? null);
      if (target) gesture.current = { type: "move", start: target, from: p };
    }
    if (target) {
      gestureBase.current = project;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const g = gesture.current;
    const c = canvasRef.current!;
    const p = toCanvas(e);
    if (!g) {
      const h = selected ? handleAt(selected, p) : null;
      c.style.cursor = h === "rotate" ? "grab" : h ? (h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize") : "default";
      return;
    }
    const id = g.start.id;
    let next: Layer;
    if (g.type === "move") {
      let x = g.start.x + p[0] - g.from[0];
      let y = g.start.y + p[1] - g.from[1];
      const snap = SNAP / scale;
      const v = !e.altKey && Math.abs(x - project.width / 2) < snap;
      const h = !e.altKey && Math.abs(y - project.height / 2) < snap;
      if (v) x = project.width / 2;
      if (h) y = project.height / 2;
      if (v !== guides.v || h !== guides.h) setGuides({ v, h });
      next = { ...g.start, x, y };
    } else if (g.type === "rotate") {
      let deg = (Math.atan2(p[1] - g.start.y, p[0] - g.start.x) * 180) / Math.PI + 90;
      if (e.shiftKey) deg = Math.round(deg / 15) * 15;
      deg = ((deg % 360) + 360) % 360;
      next = { ...g.start, rotation: Math.round(deg * 10) / 10 };
    } else {
      const keep = g.start.kind !== "shape" ? !e.shiftKey : e.shiftKey;
      next = resizeFromCorner(g.start, g.handle, p[0], p[1], keep);
    }
    setLive((pr) => ({ ...pr, layers: pr.layers.map((l) => (l.id === id ? next : l)) }));
  }

  function onPointerUp() {
    if (!gesture.current) return;
    gesture.current = null;
    setGuides({ v: false, h: false });
    endGesture();
  }

  function onDoubleClick(e: React.MouseEvent<HTMLCanvasElement>) {
    const p = toCanvas(e);
    const hit = [...project.layers].reverse().find((l) => !l.hidden && hitLayer(l, p[0], p[1]));
    if (hit?.kind === "text") {
      setSelectedId(hit.id);
      requestAnimationFrame(() => textRef.current?.select());
    } else if (hit?.kind === "image" && !hit.locked) {
      setSelectedId(hit.id);
      setCutout({ assetId: hit.assetId, layerId: hit.mask ? hit.id : null });
    }
  }

  // ---------------------------------------------------------------- save

  const saveProject = useCallback(
    async (quiet = false) => {
      // Undo history may still point at removed images, so prune only the saved copy.
      const used = new Set(project.layers.flatMap((l) => (l.kind === "image" ? [l.assetId] : [])));
      const assets = Object.fromEntries(Object.entries(project.assets).filter(([id]) => used.has(id)));
      const stamped = { ...project, assets, updatedAt: new Date().toISOString() };
      const thumbnail = await thumbnailDataUrl(stamped);
      await invoke("save_project", { id: stamped.id, data: JSON.stringify(stamped), thumbnail });
      setSavedVersion(project);
      onSaved();
      if (!quiet) setStatus(`Saved “${project.name}”`);
    },
    [project, onSaved, setStatus],
  );

  async function onSaveProject() {
    setBusy(true);
    try {
      await saveProject();
    } catch (e) {
      setStatus(`Couldn’t save project: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onSaveToLibrary() {
    if (!project.layers.some((l) => !l.hidden)) {
      setStatus("Add something to the canvas first");
      return;
    }
    setBusy(true);
    try {
      const png = await exportProject(project, "png");
      await invoke("save_creation", {
        data: await blobToDataUrl(png),
        title: project.name,
        ocrText: projectText(project),
      });
      await saveProject(true);
      onLibraryChanged();
      setStatus(`“${project.name}” added to your library · project saved for later edits`);
    } catch (e) {
      setStatus(`Couldn’t save to library: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function onExport() {
    const ext = format === "jpeg" ? "jpg" : format;
    const path = await save({
      defaultPath: `${project.name.replace(/[\\/:*?"<>|]+/g, "").trim() || "meme"}.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (!path) return;
    setBusy(true);
    try {
      const blob = await exportProject(project, format);
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      setStatus(`Exported ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      setStatus(`Export failed: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function onBack() {
    if (dirty && !window.confirm("Leave without saving? Unsaved changes will be lost.")) return;
    onClose();
  }

  // ---------------------------------------------------------- shortcuts

  useEffect(() => {
    if (!active || cutout || picker) return;
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "s") {
        e.preventDefault();
        void onSaveProject();
        return;
      }
      if (isTyping(e.target)) return;
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        redo();
      } else if (mod && (key === "=" || key === "+")) {
        e.preventDefault();
        setZoom(Math.min(8, scale * 1.25));
      } else if (mod && key === "-") {
        e.preventDefault();
        setZoom(Math.max(0.05, scale / 1.25));
      } else if (mod && key === "0") {
        e.preventDefault();
        setZoom(null);
      } else if (mod && key === "c" && selected) {
        clipboard.current = selected;
      } else if (mod && key === "v") {
        // Images on the system clipboard win; see the paste listener below.
        pasteHandled.current = false;
        window.setTimeout(() => {
          if (!pasteHandled.current && clipboard.current) duplicateLayer(clipboard.current, 24);
        }, 60);
      } else if (mod && key === "d" && selected) {
        e.preventDefault();
        duplicateLayer(selected);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected && !selected.locked) {
        e.preventDefault();
        deleteLayer(selected.id);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      } else if (e.key.startsWith("Arrow") && selected && !selected.locked) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        updateLayer(selected.id, { x: selected.x + dx, y: selected.y + dy }, `nudge:${selected.id}`);
      }
    }
    async function onPaste(e: ClipboardEvent) {
      if (isTyping(e.target)) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      pasteHandled.current = true;
      e.preventDefault();
      try {
        addAssets(await Promise.all(files.map((f) => assetFromBlob(f, f.name || "Pasted image"))));
      } catch (err) {
        setStatus(errText(err));
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  });

  // Images dropped from the OS or straight from a web page.
  const addAssetsRef = useRef(addAssets);
  addAssetsRef.current = addAssets;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    if (!active) return;
    function onOver(e: DragEvent) {
      if (!hasExternalPayload(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
    async function onDrop(e: DragEvent) {
      const items = readTransfer(e.dataTransfer);
      if (!items.length) return;
      e.preventDefault();
      const c = canvasRef.current;
      let at: Point | undefined;
      if (c) {
        const r = c.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          at = [(e.clientX - r.left - MARGIN) / scaleRef.current, (e.clientY - r.top - MARGIN) / scaleRef.current];
        }
      }
      const assets: Asset[] = [];
      for (const item of items) {
        try {
          if (item.kind === "url" && item.fallback) {
            // The canvas draws a single frame, so the browser's still copy is enough.
            assets.push(await assetFromBlob(item.fallback.blob, item.fallback.title ?? "Image"));
          } else if (item.kind === "url") {
            setStatus("Downloading image…");
            const { blob, title } = await fetchImage(item.url, undefined, "image");
            assets.push(await assetFromBlob(blob, title ?? "Web image"));
          } else if (item.blob.type.startsWith("video/")) {
            // The canvas holds pictures: use the video's middle frame.
            const [still] = await videoFrames(item.blob, [0.5]);
            if (still) assets.push(await assetFromBlob(still, item.title ?? "Video still"));
          } else {
            assets.push(await assetFromBlob(item.blob, item.title ?? "Image"));
          }
        } catch (err) {
          setStatus(errText(err));
        }
      }
      addAssetsRef.current(assets, at);
    }
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [active, setStatus]);

  // -------------------------------------------------------------- cutouts

  function onExtract(mask: Mask) {
    if (!cutout) return;
    const asset = project.assets[cutout.assetId];
    const crop = maskBounds(mask, asset);
    const existing = cutout.layerId ? (project.layers.find((l) => l.id === cutout.layerId) as ImageLayer | undefined) : undefined;
    if (existing) {
      // Keep the on-canvas scale of the cutout while its bounds change.
      const k = existing.width / existing.crop.w;
      updateLayer(existing.id, { mask, crop, width: crop.w * k, height: crop.h * k });
      setStatus("Cutout updated");
    } else {
      const source = selected?.kind === "image" && selected.assetId === asset.id ? selected : null;
      let layer = imageLayer(project, asset, { mask, crop, fill: 0.6 });
      if (source) {
        // Place the cutout over the spot it came from in the source image.
        const k = source.width / source.crop.w;
        const cx = (crop.x + crop.w / 2 - (source.crop.x + source.crop.w / 2)) * k * (source.flipX ? -1 : 1);
        const cy = (crop.y + crop.h / 2 - (source.crop.y + source.crop.h / 2)) * k * (source.flipY ? -1 : 1);
        const rad = (source.rotation * Math.PI) / 180;
        layer = {
          ...layer,
          width: crop.w * k,
          height: crop.h * k,
          rotation: source.rotation,
          flipX: source.flipX,
          flipY: source.flipY,
          x: source.x + cx * Math.cos(rad) - cy * Math.sin(rad) + 24,
          y: source.y + cx * Math.sin(rad) + cy * Math.cos(rad) + 24,
        };
      }
      addLayer(layer);
      setStatus("Cutout added as a new layer — drag it anywhere");
    }
    setCutout(null);
  }

  function restoreOriginal(l: ImageLayer) {
    const asset = project.assets[l.assetId];
    const k = l.width / l.crop.w;
    updateLayer(l.id, {
      mask: null,
      crop: { x: 0, y: 0, w: asset.width, h: asset.height },
      width: asset.width * k,
      height: asset.height * k,
      name: asset.name,
    });
  }

  // ------------------------------------------------------------- render UI

  const layersTopFirst = useMemo(() => [...project.layers].reverse(), [project.layers]);
  const [dragLayer, setDragLayer] = useState<string | null>(null);

  const num = (v: number) => Math.round(v * 10) / 10;

  return (
    <div className="studio">
      <div className="studio-bar">
        <button type="button" className="ghost sm" onClick={onBack} title="Back to projects">
          ← Projects
        </button>
        <input
          className="name-input"
          value={project.name}
          onChange={(e) => commit((p) => ({ ...p, name: e.target.value }), "name")}
          aria-label="Project name"
        />
        {dirty ? <span className="dirty" title="Unsaved changes">●</span> : null}
        <div className="bar-group">
          <button type="button" className="ghost sm" onClick={undo} disabled={!hist.past.length} title="Undo (⌘Z)">
            ↶
          </button>
          <button type="button" className="ghost sm" onClick={redo} disabled={!hist.future.length} title="Redo (⇧⌘Z)">
            ↷
          </button>
        </div>
        <div className="bar-group">
          <button type="button" className="ghost sm" onClick={() => setZoom(Math.max(0.05, scale / 1.25))} title="Zoom out (⌘−)">
            −
          </button>
          <button type="button" className="ghost sm zoom-label" onClick={() => setZoom(null)} title="Fit to screen (⌘0)">
            {Math.round(scale * 100)}%
          </button>
          <button type="button" className="ghost sm" onClick={() => setZoom(Math.min(8, scale * 1.25))} title="Zoom in (⌘+)">
            +
          </button>
        </div>
        <div className="bar-group push">
          <button type="button" className="ghost sm" onClick={onSaveProject} disabled={busy} title="Save project (⌘S)">
            Save project
          </button>
          <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)} aria-label="Export format">
            <option value="png">PNG</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
          </select>
          <button type="button" className="ghost sm" onClick={onExport} disabled={busy}>
            Export
          </button>
          <button type="button" className="import sm" onClick={onSaveToLibrary} disabled={busy}>
            {busy ? "Working…" : "★ Save to library"}
          </button>
        </div>
      </div>

      <div className="studio-body">
        <aside className="studio-tools">
          <section>
            <h3>Images</h3>
            <button type="button" className={`tool accent${libraryOpen ? " on" : ""}`} onClick={() => setLibraryOpen((o) => !o)}>
              📚 Asset library
            </button>
            <button type="button" className="tool" onClick={onPickImages}>
              ⬆ Upload image
            </button>
            <button type="button" className="tool" onClick={() => setPicker(true)}>
              ▦ From library
            </button>
            <p className="tip">Tip: drop or paste images onto the canvas.</p>
          </section>
          <section>
            <h3>Text</h3>
            {(
              [
                ["top", "Top text"],
                ["bottom", "Bottom text"],
                ["caption", "Caption box"],
                ["plain", "Plain text"],
              ] as [TextPreset, string][]
            ).map(([preset, label]) => (
              <button key={preset} type="button" className="tool" onClick={() => addLayer(textLayer(project, preset))}>
                {label}
              </button>
            ))}
          </section>
          <section>
            <h3>Shapes</h3>
            <div className="tool-grid">
              {(
                [
                  ["rect", "▭"],
                  ["ellipse", "◯"],
                  ["triangle", "△"],
                  ["line", "╱"],
                  ["arrow", "➜"],
                  ["speech", "💬"],
                  ["cloud", "💭"],
                ] as [ShapeKind, string][]
              ).map(([shape, icon]) => (
                <button
                  key={shape}
                  type="button"
                  className="tool icon"
                  title={shape === "speech" ? "Speech bubble" : shape === "cloud" ? "Thought cloud" : shape}
                  onClick={() => addLayer(shapeLayer(project, shape))}
                >
                  {icon}
                </button>
              ))}
            </div>
          </section>
          <section>
            <h3>Stickers</h3>
            <div className="tool-grid">
              {STICKERS.map((s) => (
                <button key={s} type="button" className="tool icon" onClick={() => addLayer(stickerLayer(project, s))}>
                  {s}
                </button>
              ))}
            </div>
          </section>
        </aside>

        {libraryOpen ? (
          <AssetLibrary
            onClose={() => setLibraryOpen(false)}
            onInsert={insertLibraryAsset}
            onReplace={selected?.kind === "image" && !selected.locked ? replaceWithLibraryAsset : null}
            setStatus={setStatus}
          />
        ) : null}

        <div className="studio-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
          />
          {project.layers.length === 0 ? (
            <div className="stage-hint">Upload an image, grab one from your library, or add some text to start.</div>
          ) : null}
        </div>

        <aside className="studio-side">
          <section className="props">
            {selected ? (
              <>
                <h3>{selected.kind === "image" ? (selected.mask ? "Cutout" : "Image") : selected.kind === "text" ? "Text" : "Shape"}</h3>
                <label className="field">
                  <span>Name</span>
                  <input value={selected.name} onChange={(e) => updateLayer(selected.id, { name: e.target.value }, `name:${selected.id}`)} />
                </label>

                {selected.kind === "image" ? (
                  <div className="stack">
                    <button type="button" className="import sm" onClick={() => setCutout({ assetId: selected.assetId, layerId: null })} disabled={selected.locked}>
                      ✂ Cut out new piece
                    </button>
                    {selected.mask ? (
                      <div className="row">
                        <button type="button" className="ghost sm" onClick={() => setCutout({ assetId: selected.assetId, layerId: selected.id })} disabled={selected.locked}>
                          Edit cutout
                        </button>
                        <button type="button" className="ghost sm" onClick={() => restoreOriginal(selected)} disabled={selected.locked}>
                          Restore original
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {selected.kind === "text" ? (
                  <>
                    <label className="field">
                      <span>Text</span>
                      <textarea
                        ref={textRef}
                        rows={3}
                        value={selected.text}
                        onChange={(e) => updateLayer(selected.id, { text: e.target.value }, `text:${selected.id}`)}
                      />
                    </label>
                    <label className="field">
                      <span>Font</span>
                      <select value={selected.fontFamily} onChange={(e) => updateLayer(selected.id, { fontFamily: e.target.value })}>
                        {(FONTS.includes(selected.fontFamily) ? FONTS : [selected.fontFamily, ...FONTS]).map((f) => (
                          <option key={f} value={f}>
                            {f.split(",")[0]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="row">
                      <label className="field">
                        <span>Size</span>
                        <input type="number" min={4} value={selected.fontSize} onChange={(e) => updateLayer(selected.id, { fontSize: Math.max(4, Number(e.target.value) || 4) }, `fs:${selected.id}`)} />
                      </label>
                      <label className="field">
                        <span>Line</span>
                        <input type="number" min={0.6} max={3} step={0.05} value={selected.lineHeight} onChange={(e) => updateLayer(selected.id, { lineHeight: Number(e.target.value) || 1 }, `lh:${selected.id}`)} />
                      </label>
                    </div>
                    <div className="row toggles">
                      <button type="button" className={`ghost sm${selected.bold ? " on" : ""}`} onClick={() => updateLayer(selected.id, { bold: !selected.bold })}>
                        <b>B</b>
                      </button>
                      <button type="button" className={`ghost sm${selected.italic ? " on" : ""}`} onClick={() => updateLayer(selected.id, { italic: !selected.italic })}>
                        <i>I</i>
                      </button>
                      <button type="button" className={`ghost sm${selected.uppercase ? " on" : ""}`} onClick={() => updateLayer(selected.id, { uppercase: !selected.uppercase })}>
                        AA
                      </button>
                      {(["left", "center", "right"] as const).map((a) => (
                        <button key={a} type="button" className={`ghost sm${selected.align === a ? " on" : ""}`} onClick={() => updateLayer(selected.id, { align: a })} title={`Align ${a}`}>
                          {a === "left" ? "⇤" : a === "center" ? "↔" : "⇥"}
                        </button>
                      ))}
                    </div>
                    <div className="row">
                      <label className="field color">
                        <span>Fill</span>
                        <input type="color" value={selected.color} onChange={(e) => updateLayer(selected.id, { color: e.target.value }, `color:${selected.id}`)} />
                      </label>
                      <label className="field color">
                        <span>Outline</span>
                        <input type="color" value={selected.stroke} onChange={(e) => updateLayer(selected.id, { stroke: e.target.value }, `stroke:${selected.id}`)} />
                      </label>
                      <label className="field">
                        <span>Width</span>
                        <input type="number" min={0} value={selected.strokeWidth} onChange={(e) => updateLayer(selected.id, { strokeWidth: Math.max(0, Number(e.target.value) || 0) }, `sw:${selected.id}`)} />
                      </label>
                    </div>
                    <div className="row">
                      <label className="check">
                        <input type="checkbox" checked={!!selected.background} onChange={(e) => updateLayer(selected.id, { background: e.target.checked ? "#ffffff" : null })} />
                        Background
                      </label>
                      {selected.background ? (
                        <input type="color" value={selected.background} onChange={(e) => updateLayer(selected.id, { background: e.target.value }, `bg:${selected.id}`)} aria-label="Text background color" />
                      ) : null}
                    </div>
                  </>
                ) : null}

                {selected.kind === "shape" ? (
                  <>
                    {selected.shape !== "line" && selected.shape !== "arrow" ? (
                      <div className="row">
                        <label className="check">
                          <input type="checkbox" checked={!!selected.fill} onChange={(e) => updateLayer(selected.id, { fill: e.target.checked ? "#ffe566" : null })} />
                          Fill
                        </label>
                        {selected.fill ? (
                          <input type="color" value={selected.fill} onChange={(e) => updateLayer(selected.id, { fill: e.target.value }, `fill:${selected.id}`)} aria-label="Fill color" />
                        ) : null}
                      </div>
                    ) : null}
                    <div className="row">
                      <label className="field color">
                        <span>{selected.shape === "line" || selected.shape === "arrow" ? "Color" : "Border"}</span>
                        <input type="color" value={selected.stroke} onChange={(e) => updateLayer(selected.id, { stroke: e.target.value }, `stroke:${selected.id}`)} />
                      </label>
                      <label className="field">
                        <span>Thickness</span>
                        <input type="number" min={0} value={selected.strokeWidth} onChange={(e) => updateLayer(selected.id, { strokeWidth: Math.max(0, Number(e.target.value) || 0) }, `sw:${selected.id}`)} />
                      </label>
                      {selected.shape === "rect" ? (
                        <label className="field">
                          <span>Corners</span>
                          <input type="number" min={0} value={selected.radius} onChange={(e) => updateLayer(selected.id, { radius: Math.max(0, Number(e.target.value) || 0) }, `r:${selected.id}`)} />
                        </label>
                      ) : null}
                    </div>
                    {selected.shape === "speech" || selected.shape === "cloud" ? (
                      <p className="tip">Use ⇋ / ⇵ Flip to move the tail. Add text on top with the Text tools.</p>
                    ) : null}
                  </>
                ) : null}

                <div className="row">
                  <label className="field">
                    <span>X</span>
                    <input type="number" value={num(selected.x)} onChange={(e) => updateLayer(selected.id, { x: Number(e.target.value) }, `x:${selected.id}`)} />
                  </label>
                  <label className="field">
                    <span>Y</span>
                    <input type="number" value={num(selected.y)} onChange={(e) => updateLayer(selected.id, { y: Number(e.target.value) }, `y:${selected.id}`)} />
                  </label>
                  <label className="field">
                    <span>W</span>
                    <input
                      type="number"
                      min={1}
                      value={num(selected.width)}
                      onChange={(e) => {
                        const width = Math.max(1, Number(e.target.value) || 1);
                        const patch: Partial<Layer> =
                          selected.kind === "image" ? { width, height: (selected.height * width) / selected.width } : { width };
                        updateLayer(selected.id, patch, `w:${selected.id}`);
                      }}
                    />
                  </label>
                  <label className="field">
                    <span>H</span>
                    <input
                      type="number"
                      min={1}
                      value={num(selected.height)}
                      disabled={selected.kind === "text"}
                      onChange={(e) => {
                        const height = Math.max(1, Number(e.target.value) || 1);
                        const patch: Partial<Layer> =
                          selected.kind === "image" ? { height, width: (selected.width * height) / selected.height } : { height };
                        updateLayer(selected.id, patch, `h:${selected.id}`);
                      }}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>Rotation · {Math.round(selected.rotation)}°</span>
                  <input type="range" min={0} max={359} value={selected.rotation} onChange={(e) => updateLayer(selected.id, { rotation: Number(e.target.value) }, `rot:${selected.id}`)} />
                </label>
                <label className="field">
                  <span>Opacity · {Math.round(selected.opacity * 100)}%</span>
                  <input type="range" min={0} max={100} value={Math.round(selected.opacity * 100)} onChange={(e) => updateLayer(selected.id, { opacity: Number(e.target.value) / 100 }, `op:${selected.id}`)} />
                </label>
                <div className="row wrap">
                  <button type="button" className="ghost sm" onClick={() => updateLayer(selected.id, { flipX: !selected.flipX })}>
                    ⇋ Flip
                  </button>
                  <button type="button" className="ghost sm" onClick={() => updateLayer(selected.id, { flipY: !selected.flipY })}>
                    ⇵ Flip
                  </button>
                  <button type="button" className="ghost sm" onClick={() => updateLayer(selected.id, { x: project.width / 2, y: project.height / 2 })}>
                    Center
                  </button>
                  <button type="button" className="ghost sm" onClick={() => moveLayer(selected.id, "top")} title="Bring to front">
                    ⤒ Front
                  </button>
                  <button type="button" className="ghost sm" onClick={() => moveLayer(selected.id, "bottom")} title="Send to back">
                    ⤓ Back
                  </button>
                  <button type="button" className="ghost sm" onClick={() => duplicateLayer(selected)} title="Duplicate (⌘D)">
                    Duplicate
                  </button>
                  <button type="button" className="ghost sm danger" onClick={() => deleteLayer(selected.id)} title="Delete (⌫)">
                    Delete
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>Canvas</h3>
                <div className="row">
                  <label className="field">
                    <span>Width</span>
                    <SizeInput value={project.width} onCommit={(width) => commit((p) => ({ ...p, width }))} />
                  </label>
                  <label className="field">
                    <span>Height</span>
                    <SizeInput value={project.height} onCommit={(height) => commit((p) => ({ ...p, height }))} />
                  </label>
                </div>
                <div className="row wrap">
                  {CANVAS_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className={`ghost sm${project.width === preset.width && project.height === preset.height ? " on" : ""}`}
                      onClick={() => commit((p) => ({ ...p, width: preset.width, height: preset.height }))}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <div className="row">
                  <label className="check">
                    <input type="checkbox" checked={!project.background} onChange={(e) => commit((p) => ({ ...p, background: e.target.checked ? null : "#ffffff" }))} />
                    Transparent
                  </label>
                  {project.background ? (
                    <input type="color" value={project.background} onChange={(e) => commit((p) => ({ ...p, background: e.target.value }), "bg")} aria-label="Background color" />
                  ) : null}
                </div>
                <p className="tip">
                  Select a layer to edit it. Double-click an image to cut something out of it. Shift-drag a corner to free-resize, Alt-drag to skip snapping.
                </p>
              </>
            )}
          </section>

          <section className="layers">
            <h3>Layers</h3>
            {layersTopFirst.length === 0 ? <p className="tip">Nothing here yet.</p> : null}
            <ul>
              {layersTopFirst.map((l) => (
                <li
                  key={l.id}
                  className={`${l.id === selectedId ? "sel" : ""}${dragLayer === l.id ? " dragging" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    setDragLayer(l.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragEnd={() => setDragLayer(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragLayer && dragLayer !== l.id) moveLayer(dragLayer, project.layers.findIndex((x) => x.id === l.id));
                    setDragLayer(null);
                  }}
                  onClick={() => setSelectedId(l.id)}
                >
                  <button
                    type="button"
                    className="icon-btn"
                    title={l.hidden ? "Show" : "Hide"}
                    onClick={(e) => {
                      e.stopPropagation();
                      updateLayer(l.id, { hidden: !l.hidden });
                    }}
                  >
                    {l.hidden ? "◌" : "●"}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={l.locked ? "Unlock" : "Lock"}
                    onClick={(e) => {
                      e.stopPropagation();
                      updateLayer(l.id, { locked: !l.locked });
                    }}
                  >
                    {l.locked ? "🔒" : "🔓"}
                  </button>
                  <span className={`layer-name${l.hidden ? " muted" : ""}`}>
                    <span className="kind">{l.kind === "image" ? (l.mask ? "✂" : "▣") : l.kind === "text" ? "T" : "◆"}</span>
                    {l.name || "Layer"}
                  </span>
                  <span className="layer-move">
                    <button type="button" className="icon-btn" title="Move up" onClick={(e) => { e.stopPropagation(); moveLayer(l.id, "up"); }}>
                      ▲
                    </button>
                    <button type="button" className="icon-btn" title="Move down" onClick={(e) => { e.stopPropagation(); moveLayer(l.id, "down"); }}>
                      ▼
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

      {cutout && project.assets[cutout.assetId] ? (
        <CutoutEditor
          asset={project.assets[cutout.assetId]}
          initial={cutout.layerId ? ((project.layers.find((l) => l.id === cutout.layerId) as ImageLayer | undefined)?.mask ?? null) : null}
          replacing={!!cutout.layerId}
          onCancel={() => setCutout(null)}
          onExtract={onExtract}
        />
      ) : null}

      {picker ? (
        <LibraryPicker
          onClose={() => setPicker(false)}
          onPick={async (path) => {
            setPicker(false);
            await addFromPaths([path]);
          }}
        />
      ) : null}
    </div>
  );
}

function toMid(a: Point, b: Point): Point {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Commits on blur/Enter so typing "1920" doesn't resize the canvas four times. */
function SizeInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const apply = () => {
    const v = Math.max(16, Math.min(8000, Math.round(Number(draft) || value)));
    setDraft(String(v));
    if (v !== value) onCommit(v);
  };
  return (
    <input
      type="number"
      min={16}
      max={8000}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={apply}
      onKeyDown={(e) => e.key === "Enter" && apply()}
    />
  );
}
