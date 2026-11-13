import { useCallback, useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import StudioEditor, { IMAGE_EXTENSIONS, assetFromPath } from "./StudioEditor";
import { CANVAS_PRESETS, imageLayer, migrateProject, newProject, uid, type Project } from "./model";
import "./Studio.css";

type ProjectSummary = {
  id: string;
  name: string;
  updatedAt: string;
  thumbnailPath: string | null;
};

type Props = {
  active: boolean;
  /** Image path handed over from the library ("Remix in Studio"). */
  remixPath: string | null;
  onRemixConsumed: () => void;
  setStatus: (s: string) => void;
  onLibraryChanged: () => void;
};

function errText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

/** A canvas sized to the image, with the image filling it as the first layer. */
async function projectFromImage(path: string): Promise<Project> {
  const asset = await assetFromPath(path);
  const project = newProject(asset.width, asset.height, asset.name);
  const layer = { ...imageLayer(project, asset, { fill: 1 }), name: "Background image" };
  return { ...project, assets: { [asset.id]: asset }, layers: [layer] };
}

export default function Studio({ active, remixPath, onRemixConsumed, setStatus, onLibraryChanged }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [customW, setCustomW] = useState(1080);
  const [customH, setCustomH] = useState(1080);

  const refresh = useCallback(async () => {
    try {
      setProjects(await invoke<ProjectSummary[]>("list_projects"));
    } catch (e) {
      setStatus(errText(e));
    }
  }, [setStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!remixPath) return;
    onRemixConsumed();
    if (project && !window.confirm("Close the current canvas and remix this meme? Unsaved changes will be lost.")) return;
    projectFromImage(remixPath).then(setProject, (e) => setStatus(errText(e)));
  }, [remixPath]);

  async function onOpenImage() {
    const picked = await open({ multiple: false, filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }] });
    if (!picked || Array.isArray(picked)) return;
    try {
      setProject(await projectFromImage(picked));
    } catch (e) {
      setStatus(errText(e));
    }
  }

  async function onOpenProject(id: string, copy = false) {
    try {
      const loaded = migrateProject(JSON.parse(await invoke<string>("load_project", { id })));
      setProject(copy ? { ...loaded, id: uid(), name: `${loaded.name} copy` } : loaded);
    } catch (e) {
      setStatus(`Couldn’t open project: ${errText(e)}`);
    }
  }

  async function onDeleteProject(p: ProjectSummary) {
    if (!window.confirm(`Delete “${p.name}”? Memes you saved to the library stay there.`)) return;
    try {
      await invoke("delete_project", { id: p.id });
      await refresh();
      setStatus("Project deleted");
    } catch (e) {
      setStatus(errText(e));
    }
  }

  if (project) {
    return (
      <StudioEditor
        key={project.id}
        initial={project}
        active={active}
        setStatus={setStatus}
        onClose={() => {
          setProject(null);
          void refresh();
        }}
        onSaved={refresh}
        onLibraryChanged={onLibraryChanged}
      />
    );
  }

  return (
    <div className="studio-home">
      <section className="settings-card">
        <h2>New canvas</h2>
        <p className="settings-copy">Start from a blank canvas or build on top of an image.</p>
        <div className="preset-grid">
          {CANVAS_PRESETS.map((p) => (
            <button key={p.label} type="button" className="preset" onClick={() => setProject(newProject(p.width, p.height))}>
              <span className="preset-shape" style={{ aspectRatio: `${p.width} / ${p.height}` }} />
              <strong>{p.label}</strong>
              <span>
                {p.width} × {p.height}
              </span>
            </button>
          ))}
          <button type="button" className="preset" onClick={onOpenImage}>
            <span className="preset-shape image">🖼</span>
            <strong>From image</strong>
            <span>canvas fits the image</span>
          </button>
        </div>
        <div className="settings-actions custom-size">
          <label className="field">
            <span>Width</span>
            <input type="number" min={16} max={8000} value={customW} onChange={(e) => setCustomW(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Height</span>
            <input type="number" min={16} max={8000} value={customH} onChange={(e) => setCustomH(Number(e.target.value))} />
          </label>
          <button
            type="button"
            className="import"
            onClick={() => {
              const clamp = (v: number) => Math.max(16, Math.min(8000, Math.round(v) || 1080));
              setProject(newProject(clamp(customW), clamp(customH)));
            }}
          >
            Custom size
          </button>
        </div>
      </section>

      <section className="settings-card">
        <h2>Your projects</h2>
        {projects.length === 0 ? (
          <p className="settings-copy">
            Nothing saved yet. Projects keep every layer editable, so you can come back and tweak a meme later.
          </p>
        ) : (
          <div className="project-grid">
            {projects.map((p) => (
              <div key={p.id} className="project">
                <button type="button" className="card" onClick={() => onOpenProject(p.id)} title={`Open ${p.name}`}>
                  {p.thumbnailPath ? (
                    <img src={`${convertFileSrc(p.thumbnailPath)}?v=${encodeURIComponent(p.updatedAt)}`} alt={p.name} loading="lazy" />
                  ) : null}
                </button>
                <strong>{p.name}</strong>
                <span className="hint">{p.updatedAt ? new Date(p.updatedAt).toLocaleString() : ""}</span>
                <div className="row">
                  <button type="button" className="ghost sm" onClick={() => onOpenProject(p.id, true)}>
                    Duplicate
                  </button>
                  <button type="button" className="ghost sm danger" onClick={() => onDeleteProject(p)}>
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
