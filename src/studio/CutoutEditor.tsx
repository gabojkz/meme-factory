import { useCallback, useEffect, useRef, useState } from "react";
import { hasSelection, type Asset, type Mask, type MaskPath, type Point } from "./model";
import { loadImage, paintMask } from "./render";

type Tool = "lasso" | "polygon";
type Op = "add" | "subtract";

type Props = {
  asset: Asset;
  initial: Mask | null;
  /** Replacing edits an existing cutout layer; otherwise a new layer is added. */
  replacing: boolean;
  onCancel: () => void;
  onExtract: (mask: Mask) => void;
};

const CLOSE_RADIUS = 12;

export default function CutoutEditor({ asset, initial, replacing, onCancel, onExtract }: Props) {
  const [tool, setTool] = useState<Tool>("lasso");
  const [op, setOp] = useState<Op>("add");
  const [paths, setPaths] = useState<MaskPath[]>(initial?.paths ?? []);
  const [redo, setRedo] = useState<MaskPath[][]>([]);
  const [draft, setDraft] = useState<Point[]>([]);
  const [hover, setHover] = useState<Point | null>(null);
  const [feather, setFeather] = useState(initial?.feather ?? 2);
  const [inverted, setInverted] = useState(initial?.inverted ?? false);
  const [preview, setPreview] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [fit, setFit] = useState(1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);

  const mask: Mask = { paths, feather, inverted };
  const scale = fit * zoom;
  const ready = hasSelection(mask);

  useEffect(() => {
    loadImage(asset.src).then(setImg, () => {});
  }, [asset.src]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      const pad = 32;
      setFit(Math.min((el.clientWidth - pad) / asset.width, (el.clientHeight - pad) / asset.height, 1));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [asset.width, asset.height]);

  // Redraw: dimmed original, full-strength selection, outlines, draft path.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !img) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(asset.width * scale);
    const h = Math.round(asset.height * scale);
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const full = { x: 0, y: 0, w: asset.width, h: asset.height };
    if (!preview) {
      ctx.globalAlpha = hasSelection(mask) ? 0.35 : 1;
      ctx.drawImage(img, 0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    if (hasSelection(mask)) {
      const sel = document.createElement("canvas");
      sel.width = c.width;
      sel.height = c.height;
      const sctx = sel.getContext("2d")!;
      paintMask(sctx, mask, full, scale * dpr);
      sctx.globalCompositeOperation = "source-in";
      sctx.drawImage(img, 0, 0, sel.width, sel.height);
      ctx.drawImage(sel, 0, 0, w, h);
    }

    if (preview) return;
    ctx.lineWidth = 1.5;
    for (const path of paths) {
      ctx.beginPath();
      for (const [x, y] of path.points) ctx.lineTo(x * scale, y * scale);
      ctx.closePath();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = path.mode === "add" ? "#2ec4ff" : "#ff3b3b";
      ctx.stroke();
    }
    ctx.setLineDash([]);
    if (draft.length) {
      ctx.beginPath();
      for (const [x, y] of draft) ctx.lineTo(x * scale, y * scale);
      if (tool === "polygon" && hover) ctx.lineTo(hover[0] * scale, hover[1] * scale);
      ctx.strokeStyle = "#121212";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = op === "add" ? "#ffe566" : "#ff3b3b";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (tool === "polygon") {
        draft.forEach(([x, y], i) => {
          ctx.beginPath();
          ctx.arc(x * scale, y * scale, i === 0 ? 6 : 3.5, 0, Math.PI * 2);
          ctx.fillStyle = i === 0 ? "#ffe566" : "#fff";
          ctx.fill();
          ctx.strokeStyle = "#121212";
          ctx.stroke();
        });
      }
    }
  }, [img, asset, scale, paths, draft, hover, feather, inverted, preview, tool, op]);

  function toImage(e: React.PointerEvent | React.MouseEvent): Point {
    const r = canvasRef.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / scale;
    const y = (e.clientY - r.top) / scale;
    return [Math.max(0, Math.min(asset.width, x)), Math.max(0, Math.min(asset.height, y))];
  }

  const commitPath = useCallback(
    (points: Point[]) => {
      setDraft([]);
      if (points.length < 3) return;
      setPaths((prev) => [...prev, { points, mode: op }]);
      setRedo([]);
    },
    [op],
  );

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0 || preview) return;
    const p = toImage(e);
    if (tool === "lasso") {
      drawing.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDraft([p]);
      return;
    }
    if (draft.length >= 3) {
      const [fx, fy] = draft[0];
      if (Math.hypot((fx - p[0]) * scale, (fy - p[1]) * scale) <= CLOSE_RADIUS) {
        commitPath(draft);
        return;
      }
    }
    setDraft((d) => [...d, p]);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    const p = toImage(e);
    if (tool === "polygon") {
      setHover(p);
      return;
    }
    if (!drawing.current) return;
    setDraft((d) => {
      const last = d[d.length - 1];
      if (last && Math.hypot((last[0] - p[0]) * scale, (last[1] - p[1]) * scale) < 2) return d;
      return [...d, p];
    });
  }

  function onPointerUp() {
    if (tool !== "lasso" || !drawing.current) return;
    drawing.current = false;
    commitPath(draft);
  }

  const undo = useCallback(() => {
    if (draft.length) {
      setDraft((d) => (tool === "polygon" ? d.slice(0, -1) : []));
      return;
    }
    setPaths((prev) => {
      if (!prev.length) return prev;
      setRedo((r) => [...r, prev]);
      return prev.slice(0, -1);
    });
  }, [draft.length, tool]);

  const redoStep = useCallback(() => {
    setRedo((r) => {
      if (!r.length) return r;
      setPaths(r[r.length - 1]);
      return r.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        e.preventDefault();
        if (draft.length) setDraft([]);
        else onCancel();
      } else if (e.key === "Enter" && tool === "polygon" && draft.length >= 3) {
        e.preventDefault();
        commitPath(draft);
      } else if ((e.key === "Backspace" || e.key === "Delete") && draft.length) {
        e.preventDefault();
        setDraft((d) => d.slice(0, -1));
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) redoStep();
        else undo();
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [draft, tool, commitPath, onCancel, undo, redoStep]);

  return (
    <div className="modal cutout-modal" role="dialog" aria-modal="true" aria-label="Cut out">
      <div className="cutout">
        <aside className="cutout-tools">
          <h2>✂ Cut out</h2>
          <p className="cutout-help">
            {tool === "lasso"
              ? "Drag around the thing you want to keep."
              : "Click to place points. Click the first point or press Enter to close."}
          </p>
          <div className="seg" role="group" aria-label="Selection tool">
            <button type="button" className={tool === "lasso" ? "on" : ""} onClick={() => { setTool("lasso"); setDraft([]); }}>
              Lasso
            </button>
            <button type="button" className={tool === "polygon" ? "on" : ""} onClick={() => { setTool("polygon"); setDraft([]); }}>
              Polygon
            </button>
          </div>
          <div className="seg" role="group" aria-label="Selection mode">
            <button type="button" className={op === "add" ? "on" : ""} onClick={() => setOp("add")}>
              + Add
            </button>
            <button type="button" className={op === "subtract" ? "on" : ""} onClick={() => setOp("subtract")}>
              − Subtract
            </button>
          </div>
          <label className="field">
            <span>Feather · {feather}px</span>
            <input type="range" min={0} max={40} value={feather} onChange={(e) => setFeather(Number(e.target.value))} />
          </label>
          <label className="check">
            <input type="checkbox" checked={inverted} onChange={(e) => setInverted(e.target.checked)} />
            Invert selection
          </label>
          <label className="check">
            <input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} />
            Preview cutout
          </label>
          <div className="row">
            <button type="button" className="ghost sm" onClick={undo} disabled={!draft.length && !paths.length}>
              Undo
            </button>
            <button type="button" className="ghost sm" onClick={redoStep} disabled={!redo.length}>
              Redo
            </button>
            <button
              type="button"
              className="ghost sm"
              onClick={() => {
                setRedo((r) => [...r, paths]);
                setPaths([]);
                setDraft([]);
              }}
              disabled={!paths.length}
            >
              Clear
            </button>
          </div>
          <div className="row">
            <span className="hint-sm">Zoom</span>
            {[1, 2, 4].map((z) => (
              <button key={z} type="button" className={`ghost sm${zoom === z ? " on" : ""}`} onClick={() => setZoom(z)}>
                {z === 1 ? "Fit" : `${z}×`}
              </button>
            ))}
          </div>
          <div className="spacer" />
          <button type="button" className="import" disabled={!ready} onClick={() => onExtract(mask)}>
            {replacing ? "Update cutout" : "Extract to canvas"}
          </button>
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </aside>
        <div className="cutout-stage checker" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            className={preview ? "" : "crosshair"}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={() => setHover(null)}
            onDoubleClick={() => tool === "polygon" && draft.length >= 3 && commitPath(draft)}
          />
        </div>
      </div>
    </div>
  );
}
