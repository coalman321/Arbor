import type { BrowseResult, GitInfo, NodeModel, ProjectSnapshot, RevSnapshot, SaveFileRequest, WorkspaceInfo } from "../shared/model.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Root of the project this window is editing; sent with writes (see "x-bt-project" in main.ts). */
let projectRoot: string | null = null;
export function setProjectRoot(root: string | null) {
  projectRoot = root;
}

async function call<T>(method: string, path: string, body?: unknown, scoped = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (body) headers["content-type"] = "application/json";
  if (scoped && projectRoot) headers["x-bt-project"] = projectRoot;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error ?? res.statusText, res.status);
  return json as T;
}

export const api = {
  project: () => call<ProjectSnapshot>("GET", "/api/project"),
  saveFile: (req: SaveFileRequest) => call<{ version: string }>("PUT", "/api/files", req, true),
  deleteFile: (path: string) => call<object>("DELETE", `/api/files?path=${encodeURIComponent(path)}`, undefined, true),
  saveSpec: (models: NodeModel[]) => call<{ version: string }>("PUT", "/api/spec", { models }, true),
  importTree: (source: string) => call<{ path: string; treeIds: string[] }>("POST", "/api/trees/import", { source }, true),
  workspace: () => call<WorkspaceInfo>("GET", "/api/workspace"),
  browse: (path?: string) => call<BrowseResult>("GET", `/api/fs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  openProject: (path: string) => call<ProjectSnapshot>("POST", "/api/project/open", { path }),
  createProject: (path: string) => call<ProjectSnapshot>("POST", "/api/project/create", { path }),
  forgetRecent: (path: string) => call<WorkspaceInfo>("POST", "/api/recent/forget", { path }),
  gitInfo: (limit?: number) => call<GitInfo>("GET", `/api/git/revs${limit ? `?limit=${limit}` : ""}`),
  gitSnapshot: (rev: string) => call<RevSnapshot>("GET", `/api/git/snapshot?rev=${encodeURIComponent(rev)}`),
};

export function wsUrl(path: string): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
}
