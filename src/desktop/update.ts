// Update check for the desktop app: asks GitHub for the latest release, which the release workflow
// publishes for each vX.Y.Z tag. Arbor only points the user at it; installing is left to them.

const LATEST_RELEASE_URL = "https://api.github.com/repos/coalman321/Arbor/releases/latest";

export interface Release {
  version: string; // without the leading "v"
  url: string; // the release's page on GitHub
}

/** The latest published release, or null if GitHub can't be reached or has none. */
export async function latestRelease(): Promise<Release | null> {
  try {
    const res = await fetch(LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    if (typeof body.tag_name !== "string" || typeof body.html_url !== "string") return null;
    return { version: body.tag_name.replace(/^v/, ""), url: body.html_url };
  } catch {
    return null; // offline, rate-limited, ...: try again next launch
  }
}

/** Whether version `a` (X.Y.Z) is newer than `b`. Anything that isn't X.Y.Z is never newer. */
export function isNewer(a: string, b: string): boolean {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

function parse(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? m.slice(1).map(Number) : null;
}
