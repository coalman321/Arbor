import { useMemo } from "react";
import { create } from "zustand";
import {
  projectModels,
  type BlackboardMsg,
  type BTNode,
  type Diagnostic,
  type Mapping,
  type NodeModel,
  type NodeStatus,
  type RuntimeNode,
  type Statuses,
  type TreeDef,
} from "@coalman321/arborist";
import type { ProjectManifest, ProjectSnapshot, TreeFile } from "../shared/model.ts";
import { validateProject } from "../shared/validate.ts";
import { api, ApiError, setProjectRoot } from "./api.ts";
import type { DropZone } from "./tree_ops.ts";

export interface FileState extends TreeFile {
  dirty: boolean;
  /** Created in the editor and not saved yet. */
  isNew?: boolean;
  /** All its trees were deleted; the file is removed on save. */
  deleted?: boolean;
}

interface History {
  past: TreeDef[];
  future: TreeDef[];
  lastKey?: string;
  lastTime?: number;
}

export interface LogEntry {
  t: number;
  uid: number;
  prev: NodeStatus;
  status: NodeStatus;
}

/** Statuses (see Statuses) plus the connection they come from. */
export interface LiveState extends Statuses {
  url: string;
  /** "replay": statuses come from a .btlog being played back (see replay.ts), not a robot. */
  state: "idle" | "connecting" | "connected" | "disconnected" | "error" | "replay";
  message?: string;
  robot?: string;
  session?: number;
  treeId?: string;
  runtime?: RuntimeNode[];
  robotXml?: string;
  mapping?: Mapping;
  log: LogEntry[];
  blackboard?: BlackboardMsg;
  paused: boolean;
}

export interface PickerState {
  x: number;
  y: number;
  mode: "child" | "after" | "wrap" | "replace" | "root";
  treeId: string;
  uid?: string;
}

export type BrowseMode = "openProject" | "newProject" | "importTree";

export type DialogState =
  | { kind: "browse"; mode: BrowseMode }
  | { kind: "newTree"; extractFrom?: { treeId: string; uid: string } }
  | { kind: "renameTree"; treeId: string }
  | { kind: "moveTree"; treeId: string }
  | { kind: "nodeType"; modelId?: string; category?: NodeModel["category"] }
  | { kind: "licenses" };

export interface ContextMenuState {
  x: number;
  y: number;
  path: string;
}

interface State {
  /** "none": the backend has no project open; the welcome screen is shown. */
  status: "loading" | "ready" | "error" | "none";
  /** Set when another window switched the backend to a different project than this one edits. */
  projectMoved: { to: string | null } | null;
  loadError: string | null;
  manifest: ProjectManifest | null;
  root: string;
  specModels: NodeModel[];
  specVersion: string;
  loadDiagnostics: Diagnostic[];
  trees: Record<string, TreeDef>;
  files: Record<string, FileState>;
  history: Record<string, History>;
  tabs: string[];
  active: string | null;
  /** Instance path of the selected node within the active tab. */
  selection: string | null;
  /** Expanded SubTree instances, keyed "<tab>|<instance path>". */
  expanded: Record<string, boolean>;
  layoutDir: "TB" | "LR";
  /** Draw decorators as frames around their child instead of as boxes above it. */
  decoratorFrames: boolean;
  /** Plain-language labels on edges ("step 1", "if not, try") and in decorator frames. */
  explainEdges: boolean;
  clipboard: BTNode | null;
  conflicts: string[];
  toast: { id: number; text: string; kind: "info" | "error" } | null;
  dropHint: { path: string; zone: DropZone } | null;
  picker: PickerState | null;
  menu: ContextMenuState | null;
  dialog: DialogState | null;
  bottomTab: "problems" | "xml" | "log" | "blackboard";
  bottomOpen: boolean;
  /** Which of the panels around the canvas are shown (hidden ones leave room for the tree). */
  panels: Panels;
  /** Panels to restore when leaving focus mode (which hides them all). */
  panelsBeforeFocus: Panels | null;
  live: LiveState;
  /** Set while a .btlog is open for playback (see replay.ts). */
  replay: import("./replay.ts").ReplayState | null;
  /** Set while comparing two revisions (see diff.ts); the compare view replaces the editor. */
  diff: import("./diff.ts").DiffState | null;
  fitRequest: number;
}

const initialLive = (url = ""): LiveState => ({
  url,
  state: "idle",
  statusByUid: {},
  statusByPath: {},
  statusByDef: {},
  log: [],
  paused: false,
});

// Above useStore: its initial state calls loadPanels().
export interface Panels {
  left: boolean;
  bottom: boolean;
  right: boolean;
}
const ALL_PANELS: Panels = { left: true, bottom: true, right: true };

function loadPanels(): Panels {
  try {
    return { ...ALL_PANELS, ...JSON.parse(localStorageGet("bt-editor.panels") ?? "{}") };
  } catch {
    return ALL_PANELS;
  }
}

export const useStore = create<State>()(() => ({
  status: "loading",
  projectMoved: null,
  loadError: null,
  manifest: null,
  root: "",
  specModels: [],
  specVersion: "",
  loadDiagnostics: [],
  trees: {},
  files: {},
  history: {},
  tabs: [],
  active: null,
  selection: null,
  expanded: {},
  layoutDir: (localStorageGet("bt-editor.layoutDir") as "TB" | "LR") ?? "TB",
  decoratorFrames: localStorageGet("bt-editor.decoratorFrames") !== "false",
  explainEdges: localStorageGet("bt-editor.explainEdges") !== "false",
  clipboard: null,
  conflicts: [],
  toast: null,
  dropHint: null,
  picker: null,
  menu: null,
  dialog: null,
  bottomTab: "problems",
  bottomOpen: true,
  panels: loadPanels(),
  panelsBeforeFocus: null,
  live: initialLive(),
  replay: null,
  diff: null,
  fitRequest: 0,
}));

export function setPanels(panels: Panels) {
  localStorageSet("bt-editor.panels", JSON.stringify(panels));
  // Refit the tree into the space the panels leave (after the layout has changed).
  set({ panels, panelsBeforeFocus: null });
  requestAnimationFrame(() => set({ fitRequest: get().fitRequest + 1 }));
}

export function togglePanel(which: keyof Panels) {
  const p = get().panels;
  setPanels({ ...p, [which]: !p[which] });
}

/** Hides every panel; called again, brings back the ones that were shown before. */
export function toggleFocus() {
  const { panels, panelsBeforeFocus } = get();
  const anyShown = panels.left || panels.bottom || panels.right;
  if (anyShown) {
    localStorageSet("bt-editor.panels", JSON.stringify({ left: false, bottom: false, right: false }));
    set({ panels: { left: false, bottom: false, right: false }, panelsBeforeFocus: panels });
    requestAnimationFrame(() => set({ fitRequest: get().fitRequest + 1 }));
  } else setPanels(panelsBeforeFocus ?? ALL_PANELS);
}

export function localStorageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function localStorageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode); preferences just won't persist
  }
}

const get = useStore.getState;
const set = useStore.setState;

let toastId = 0;
export function toast(text: string, kind: "info" | "error" = "info") {
  const id = ++toastId;
  set({ toast: { id, text, kind } });
  setTimeout(() => {
    if (get().toast?.id === id) set({ toast: null });
  }, kind === "error" ? 6000 : 3000);
}

// ---------------------------------------------------------------------------------------------
// Loading

function filesFromSnapshot(snap: ProjectSnapshot): Record<string, FileState> {
  return Object.fromEntries(snap.files.map((f) => [f.path, { ...f, dirty: false }]));
}

export async function loadProject() {
  try {
    applySnapshot(await api.project());
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      setProjectRoot(null);
      set({ status: "none", loadError: null, projectMoved: null });
      document.title = "Arbor";
    } else set({ status: "error", loadError: (e as Error).message });
  }
}

/** Replaces everything this window is editing with `snap` (a freshly opened project). */
function applySnapshot(snap: ProjectSnapshot) {
  setProjectRoot(snap.root);
  {
    const trees = Object.fromEntries(snap.trees.map((t) => [t.id, t]));
    const mainTree = snap.files.find((f) => f.mainTree && trees[f.mainTree])?.mainTree ?? snap.trees[0]?.id ?? null;
    const saved = localStorageGet(`bt-editor.tabs.${snap.root}`);
    let tabs: string[] = saved ? (JSON.parse(saved) as string[]).filter((id) => trees[id]) : [];
    if (!tabs.length && mainTree) tabs = [mainTree];
    set({
      status: "ready",
      loadError: null,
      projectMoved: null,
      selection: null,
      expanded: get().root === snap.root ? get().expanded : {},
      conflicts: [],
      manifest: snap.manifest,
      root: snap.root,
      specModels: snap.specModels,
      specVersion: snap.specVersion,
      loadDiagnostics: snap.diagnostics,
      trees,
      files: filesFromSnapshot(snap),
      history: {},
      tabs,
      active: tabs[0] ?? null,
      live: { ...get().live, url: get().live.url || (localStorageGet(`bt-editor.liveUrl.${snap.root}`) ?? snap.manifest.live.url) },
    });
    document.title = `${snap.manifest.name} · Arbor`;
  }
}

/**
 * Re-opens this window's project on the backend after another window switched away, keeping this
 * window's unsaved edits so they can still be saved.
 */
export async function reclaimProject() {
  try {
    await api.openProject(get().root);
    set({ projectMoved: null });
    toast(`Reopened ${get().manifest?.name}; you can save again`);
  } catch (e) {
    toast(`Couldn't reopen: ${(e as Error).message}`, "error");
  }
}

/** Asks before throwing away unsaved edits. Returns false if the user wants to keep them. */
export function confirmDiscard(action: string): boolean {
  const n = dirtyCount();
  return n === 0 || confirm(`You have unsaved changes in ${n} file${n === 1 ? "" : "s"}.\n\n${action} anyway and lose them?`);
}

/** Opens (or with `create`, creates) the project at `path`, replacing the current one. */
export async function switchProject(path: string, create = false): Promise<string | null> {
  try {
    const snap = create ? await api.createProject(path) : await api.openProject(path);
    set({
      selection: null,
      expanded: {},
      conflicts: [],
      dialog: null,
      menu: null,
      picker: null,
      projectMoved: null,
      bottomTab: "problems",
    });
    applySnapshot(snap);
    toast(create ? `Created ${snap.manifest.name}` : `Opened ${snap.manifest.name}`);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Copies a tree file from elsewhere into the project and opens its first tree. */
export async function importTreeFile(source: string): Promise<string | null> {
  try {
    const { path, treeIds } = await api.importTree(source);
    await reconcileWithDisk();
    if (treeIds[0]) openTree(treeIds[0]);
    toast(`Added ${path} (${treeIds.join(", ")})`);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Merges files changed on disk into the editor, unless they have unsaved edits. */
export async function reconcileWithDisk() {
  const snap = await api.project();
  const s = get();
  const trees = { ...s.trees };
  const files = { ...s.files };
  const conflicts = new Set(s.conflicts);
  const history = { ...s.history };
  const diskFiles = new Map(snap.files.map((f) => [f.path, f]));
  const diskTrees = new Map(snap.trees.map((t) => [t.id, t]));
  let reloaded = 0;

  const replaceFile = (path: string, disk: TreeFile | undefined) => {
    for (const id of files[path]?.treeIds ?? []) {
      delete trees[id];
      delete history[id];
    }
    if (disk) {
      files[path] = { ...disk, dirty: false };
      for (const id of disk.treeIds) {
        const t = diskTrees.get(id);
        if (t) trees[id] = t;
      }
    } else delete files[path];
    reloaded++;
  };

  for (const disk of snap.files) {
    const local = files[disk.path];
    if (!local) {
      if (!disk.treeIds.some((id) => trees[id])) replaceFile(disk.path, disk);
    } else if (local.version !== disk.version) {
      if (local.dirty || local.deleted) conflicts.add(disk.path);
      else replaceFile(disk.path, disk);
    }
  }
  for (const local of Object.values(s.files)) {
    if (local.isNew || diskFiles.has(local.path)) continue;
    if (local.dirty) conflicts.add(local.path);
    else replaceFile(local.path, undefined);
  }

  const specChanged = snap.specVersion !== s.specVersion;
  set({
    trees,
    files,
    history,
    conflicts: [...conflicts],
    loadDiagnostics: snap.diagnostics,
    tabs: s.tabs.filter((id) => trees[id]),
    active: s.active && trees[s.active] ? s.active : (s.tabs.find((id) => trees[id]) ?? null),
    ...(specChanged ? { specModels: snap.specModels, specVersion: snap.specVersion } : {}),
  });
  if (specChanged) toast("Node spec reloaded from disk");
  else if (reloaded) toast(`Reloaded ${reloaded} file(s) changed on disk`);
}

/** Resolves a conflict by taking the disk version (`reload`) or keeping ours for the next save. */
export async function resolveConflict(path: string, choice: "reload" | "keep") {
  const snap = await api.project();
  const disk = snap.files.find((f) => f.path === path);
  const s = get();
  if (choice === "keep") {
    // Our next save will overwrite whatever is on disk now.
    const local = s.files[path];
    set({
      files: { ...s.files, [path]: { ...local, version: disk?.version ?? local.version, isNew: !disk, dirty: true } },
      conflicts: s.conflicts.filter((p) => p !== path),
    });
    return;
  }
  const trees = { ...s.trees };
  const files = { ...s.files };
  for (const id of files[path]?.treeIds ?? []) delete trees[id];
  if (disk) {
    files[path] = { ...disk, dirty: false };
    for (const t of snap.trees.filter((t) => t.file === path)) trees[t.id] = t;
  } else delete files[path];
  set({
    trees,
    files,
    conflicts: s.conflicts.filter((p) => p !== path),
    tabs: s.tabs.filter((id) => trees[id]),
    active: s.active && trees[s.active] ? s.active : null,
  });
}

// ---------------------------------------------------------------------------------------------
// Tabs and selection

function persistTabs() {
  const s = get();
  localStorageSet(`bt-editor.tabs.${s.root}`, JSON.stringify(s.tabs));
}

export function openTree(id: string, select: string | null = null) {
  const s = get();
  if (!s.trees[id]) return;
  set({ tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id], active: id, selection: select, picker: null, menu: null });
  persistTabs();
}

export function closeTab(id: string) {
  const s = get();
  const i = s.tabs.indexOf(id);
  const tabs = s.tabs.filter((t) => t !== id);
  set({ tabs, active: s.active === id ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : s.active, selection: null });
  persistTabs();
}

export function select(path: string | null) {
  const diff = get().diff;
  if (diff) set({ diff: { ...diff, selection: path } });
  else set({ selection: path, menu: null });
}

export function toggleExpanded(path: string) {
  const s = get();
  const key = s.diff ? `diff:${s.diff.active}|${path}` : `${s.active}|${path}`;
  const expanded = { ...s.expanded };
  if (expanded[key]) delete expanded[key];
  else expanded[key] = true;
  set({ expanded });
}

// ---------------------------------------------------------------------------------------------
// Editing

const HISTORY_LIMIT = 200;
const COALESCE_MS = 1500;

function markDirty(files: Record<string, FileState>, path: string): Record<string, FileState> {
  const f = files[path];
  return f && !f.dirty ? { ...files, [path]: { ...f, dirty: true } } : files;
}

/**
 * Applies an edit to a tree and records undo history. Consecutive edits with the same
 * `coalesceKey` (e.g. typing in one field) collapse into one undo step.
 */
export function editTree(treeId: string, fn: (t: TreeDef) => TreeDef, coalesceKey?: string) {
  const s = get();
  const tree = s.trees[treeId];
  if (!tree) return;
  const file = s.files[tree.file];
  if (file?.readOnlyReason) {
    toast(`${tree.file} is read-only: ${file.readOnlyReason}`, "error");
    return;
  }
  const next = fn(tree);
  if (next === tree) return;
  const h = s.history[treeId] ?? { past: [], future: [] };
  const now = Date.now();
  const coalesce = coalesceKey && h.lastKey === coalesceKey && now - (h.lastTime ?? 0) < COALESCE_MS;
  const past = coalesce ? h.past : [...h.past, tree].slice(-HISTORY_LIMIT);
  set({
    trees: { ...s.trees, [treeId]: next },
    history: { ...s.history, [treeId]: { past, future: [], lastKey: coalesceKey, lastTime: now } },
    files: markDirty(s.files, tree.file),
  });
}

export function editRoot(treeId: string, fn: (root: BTNode | null) => BTNode | null, coalesceKey?: string) {
  editTree(
    treeId,
    (t) => {
      const root = fn(t.root);
      return root === t.root ? t : { ...t, root };
    },
    coalesceKey,
  );
}

export function undo(treeId = get().active) {
  const s = get();
  if (!treeId) return;
  const h = s.history[treeId];
  if (!h?.past.length) return;
  const prev = h.past[h.past.length - 1];
  set({
    trees: { ...s.trees, [treeId]: prev },
    history: { ...s.history, [treeId]: { past: h.past.slice(0, -1), future: [s.trees[treeId], ...h.future] } },
    files: markDirty(s.files, prev.file),
  });
}

export function redo(treeId = get().active) {
  const s = get();
  if (!treeId) return;
  const h = s.history[treeId];
  if (!h?.future.length) return;
  const next = h.future[0];
  set({
    trees: { ...s.trees, [treeId]: next },
    history: { ...s.history, [treeId]: { past: [...h.past, s.trees[treeId]], future: h.future.slice(1) } },
    files: markDirty(s.files, next.file),
  });
}

export const TREE_ID_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

export function fileNameFor(treeId: string): string {
  const snake = treeId
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .toLowerCase();
  const dir = get().manifest?.trees ?? "trees";
  return `${dir}/${snake}.xml`;
}

/** Creates a tree in `file` (a new file if it doesn't exist) and opens it. */
export function createTree(id: string, file: string, root: BTNode | null = null, ports: TreeDef["ports"] = []): string | null {
  const s = get();
  if (!TREE_ID_RE.test(id)) return "IDs must start with a letter or _, and contain only letters, digits, _ . : -";
  if (s.trees[id]) return `A tree named "${id}" already exists`;
  if (!file.endsWith(".xml")) return "File must end in .xml";
  const dir = s.manifest?.trees ?? "trees";
  if (!file.startsWith(`${dir}/`)) return `File must be under ${dir}/`;
  const existing = s.files[file];
  if (existing?.readOnlyReason) return `${file} is read-only`;
  const tree: TreeDef = { id, file, ports, attrs: {}, root };
  const f: FileState = existing
    ? { ...existing, treeIds: [...existing.treeIds, id], dirty: true, deleted: false }
    : { path: file, includes: [], treeIds: [id], version: "", dirty: true, isNew: true };
  set({ trees: { ...s.trees, [id]: tree }, files: { ...s.files, [file]: f } });
  openTree(id);
  return null;
}

/**
 * Moves tree `id` into another tree file (a new one if `dest` doesn't exist yet). Both files are
 * rewritten on save. A main tree stays main if its new file has none.
 */
export function moveTreeToFile(id: string, dest: string): string | null {
  const s = get();
  const tree = s.trees[id];
  if (!tree) return `No tree "${id}"`;
  if (dest === tree.file) return null;
  if (!dest.endsWith(".xml")) return "File must end in .xml";
  const dir = s.manifest?.trees ?? "trees";
  if (!dest.startsWith(`${dir}/`) || dest.includes("..")) return `File must be under ${dir}/`;
  const from = s.files[tree.file];
  const to = s.files[dest];
  if (from?.readOnlyReason) return `${tree.file} is read-only: ${from.readOnlyReason}`;
  if (to?.readOnlyReason) return `${dest} is read-only: ${to.readOnlyReason}`;

  const files = { ...s.files };
  const left = from.treeIds.filter((t) => t !== id);
  const wasMain = from.mainTree === id;
  if (!left.length && from.isNew) delete files[from.path];
  else files[from.path] = { ...from, treeIds: left, dirty: true, deleted: left.length === 0, mainTree: wasMain ? undefined : from.mainTree };
  const keepMain = wasMain && !(to && !to.deleted && to.mainTree);
  files[dest] =
    to && !(to.deleted && to.isNew)
      ? { ...to, treeIds: [...(to.deleted ? [] : to.treeIds), id], dirty: true, deleted: false, mainTree: keepMain ? id : to.deleted ? undefined : to.mainTree }
      : { path: dest, includes: [], treeIds: [id], version: "", dirty: true, isNew: true, mainTree: keepMain ? id : undefined };
  // Undo history holds whole trees, file included; keep it pointing at the new file.
  const h = s.history[id];
  const rehome = (t: TreeDef) => ({ ...t, file: dest });
  set({
    trees: { ...s.trees, [id]: rehome(tree) },
    files,
    history: h ? { ...s.history, [id]: { ...h, past: h.past.map(rehome), future: h.future.map(rehome) } } : s.history,
  });
  if (wasMain && !keepMain) toast(`${id} is no longer a main tree: ${dest} already has one`);
  return null;
}

export function deleteTree(id: string) {
  const s = get();
  const tree = s.trees[id];
  if (!tree) return;
  const f = s.files[tree.file];
  const treeIds = f.treeIds.filter((t) => t !== id);
  const trees = { ...s.trees };
  delete trees[id];
  const files = { ...s.files };
  if (!treeIds.length && f.isNew) delete files[tree.file];
  else files[tree.file] = { ...f, treeIds, dirty: true, deleted: treeIds.length === 0, mainTree: f.mainTree === id ? undefined : f.mainTree };
  set({ trees, files });
  closeTab(id);
}

/** Renames a tree and updates every <SubTree ID="..."> that references it. */
export function renameTree(oldId: string, newId: string): string | null {
  const s = get();
  if (oldId === newId) return null;
  if (!TREE_ID_RE.test(newId)) return "IDs must start with a letter or _, and contain only letters, digits, _ . : -";
  if (s.trees[newId]) return `A tree named "${newId}" already exists`;
  let files = { ...s.files };
  const trees: Record<string, TreeDef> = {};
  const history = { ...s.history };
  const rewrite = (n: BTNode): BTNode => {
    const children = n.children.map(rewrite);
    const hit = n.type === "SubTree" && n.attrs.ID === oldId;
    if (!hit && children.every((c, i) => c === n.children[i])) return n;
    return { ...n, attrs: hit ? { ...n.attrs, ID: newId } : n.attrs, children };
  };
  for (const [id, t] of Object.entries(s.trees)) {
    const root = t.root ? rewrite(t.root) : null;
    let next = root === t.root ? t : { ...t, root };
    if (id === oldId) next = { ...next, id: newId };
    if (next !== t) {
      files = markDirty(files, t.file);
      // Undoing half of a rename would leave dangling SubTree references; start fresh instead.
      delete history[id];
    }
    trees[next.id] = next;
  }
  const f = files[s.trees[oldId].file];
  files[f.path] = {
    ...f,
    dirty: true,
    treeIds: f.treeIds.map((t) => (t === oldId ? newId : t)),
    mainTree: f.mainTree === oldId ? newId : f.mainTree,
  };
  set({
    trees,
    files,
    history,
    tabs: s.tabs.map((t) => (t === oldId ? newId : t)),
    active: s.active === oldId ? newId : s.active,
  });
  persistTabs();
  return null;
}

export function setMainTree(treeId: string, isMain: boolean) {
  const s = get();
  const tree = s.trees[treeId];
  const f = s.files[tree.file];
  set({ files: { ...s.files, [f.path]: { ...f, mainTree: isMain ? treeId : undefined, dirty: true } } });
}

export function dirtyCount(): number {
  return Object.values(get().files).filter((f) => f.dirty).length;
}

export async function saveAll(): Promise<boolean> {
  const s = get();
  let ok = true;
  for (const f of Object.values(s.files)) {
    if (!f.dirty) continue;
    try {
      if (f.deleted) {
        if (!f.isNew) await api.deleteFile(f.path);
        const files = { ...get().files };
        delete files[f.path];
        set({ files });
        continue;
      }
      const req = {
        path: f.path,
        mainTree: f.mainTree,
        includes: f.includes,
        trees: f.treeIds.map((id) => get().trees[id]),
        baseVersion: f.isNew ? undefined : f.version,
      };
      let res;
      try {
        res = await api.saveFile(req);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 409) throw e;
        if (!confirm(`${f.path} was changed outside the editor since it was loaded.\n\nOverwrite it with your version?`)) {
          ok = false;
          continue;
        }
        res = await api.saveFile({ ...req, force: true });
      }
      const cur = get().files[f.path];
      // Edits made while the request was in flight keep the file dirty.
      const changedMeanwhile = f.treeIds.some((id) => get().trees[id] !== s.trees[id]) || cur.treeIds !== f.treeIds;
      set({
        files: { ...get().files, [f.path]: { ...cur, version: res.version, isNew: false, dirty: changedMeanwhile } },
        conflicts: get().conflicts.filter((p) => p !== f.path),
      });
    } catch (e) {
      ok = false;
      toast(`Saving ${f.path} failed: ${(e as Error).message}`, "error");
    }
  }
  if (ok) toast("Saved");
  return ok;
}

/** Adds, replaces (when `previousId` is set) or removes (model null) a node type in the spec file. */
export async function saveSpecModel(model: NodeModel | null, previousId?: string): Promise<boolean> {
  const s = get();
  let models = s.specModels.filter((m) => m.source === "spec");
  if (previousId !== undefined) {
    const i = models.findIndex((m) => m.id === previousId);
    if (model) models = i >= 0 ? models.map((m, j) => (j === i ? model : m)) : [...models, model];
    else models = models.filter((m) => m.id !== previousId);
  } else if (model) models = [...models, model];
  try {
    const { version } = await api.saveSpec(models);
    set({ specModels: [...models, ...s.specModels.filter((m) => m.source !== "spec")], specVersion: version });
    toast(`Saved ${s.manifest?.nodes ?? "node spec"}`);
    return true;
  } catch (e) {
    toast(`Saving the node spec failed: ${(e as Error).message}`, "error");
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Derived data

export function useModels(): Map<string, NodeModel> {
  const specModels = useStore((s) => s.specModels);
  const trees = useStore((s) => s.trees);
  return useMemo(() => projectModels(specModels, Object.values(trees)), [specModels, trees]);
}

export function useDiagnostics(): Diagnostic[] {
  const trees = useStore((s) => s.trees);
  const files = useStore((s) => s.files);
  const loadDiagnostics = useStore((s) => s.loadDiagnostics);
  const models = useModels();
  return useMemo(() => {
    const map = new Map(Object.entries(trees));
    const mains = Object.values(files).map((f) => f.mainTree);
    // Load errors about files are kept; tree-level problems are recomputed live.
    return [...loadDiagnostics.filter((d) => !d.nodeUid), ...validateProject(map, models, mains)];
  }, [trees, files, models, loadDiagnostics]);
}

/** Trees that contain a <SubTree ID="treeId"/>. */
export function treesUsing(trees: Record<string, TreeDef>, treeId: string): TreeDef[] {
  const uses = (n: BTNode | null): boolean => !!n && ((n.type === "SubTree" && n.attrs.ID === treeId) || n.children.some(uses));
  return Object.values(trees).filter((t) => uses(t.root));
}

/** Finds the tree and node an instance path refers to, starting from tab `tabTreeId`. */
export function resolvePath(
  trees: Record<string, TreeDef>,
  tabTreeId: string,
  path: string,
): { tree: TreeDef; node: BTNode; readOnly: boolean } | null {
  let tree = trees[tabTreeId];
  if (!tree) return null;
  const parts = path.split("/");
  let node: BTNode | null = null;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      if (node?.type !== "SubTree") return null;
      tree = trees[node.attrs.ID ?? ""];
      if (!tree) return null;
    }
    node = findUid(tree.root, parts[i]);
    if (!node) return null;
  }
  return node ? { tree, node, readOnly: parts.length > 1 } : null;
}

function findUid(root: BTNode | null, uid: string): BTNode | null {
  if (!root) return null;
  if (root.uid === uid) return root;
  for (const c of root.children) {
    const r = findUid(c, uid);
    if (r) return r;
  }
  return null;
}

export { initialLive };
