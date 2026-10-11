// Lays out a commit history as a graph of lanes, like VS Code's source control graph: each commit
// is a dot in a lane, and lines run down from each commit to its parents. Commits must be in
// topological order, newest first (git log --topo-order).
//
// Each row is drawn on its own: the top half holds the lines coming down into the row, the bottom
// half the lines leaving it, so rows can be rendered (and filtered) independently.

export interface GraphCommit {
  sha: string;
  parents: string[];
}

/** A line in one half of a row, from lane `from` to lane `to`. */
export interface Segment {
  from: number;
  to: number;
  /** Lane whose color the line takes. */
  color: number;
}

export interface GraphRow {
  /** Lane of the commit's dot. */
  lane: number;
  /** Lines from the top edge (at `from`) to the middle (at `to`). */
  top: Segment[];
  /** Lines from the middle (at `from`) to the bottom edge (at `to`). */
  bottom: Segment[];
}

export interface Graph {
  rows: GraphRow[];
  /** Lanes needed by the widest row. */
  width: number;
}

export function layoutGraph(commits: GraphCommit[]): Graph {
  /** For each lane, the commit the line in it is heading for (null: free). */
  let lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  let width = 0;

  const free = (from = 0) => {
    for (let i = from; i < lanes.length; i++) if (lanes[i] === null) return i;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const c of commits) {
    let lane = lanes.indexOf(c.sha);
    if (lane < 0) lane = free(); // nothing points here yet: a branch tip
    const before = [...lanes];

    // Lines into this commit merge into its lane; the others pass straight through.
    const top: Segment[] = [];
    before.forEach((sha, i) => {
      if (sha === null) return;
      top.push({ from: i, to: sha === c.sha ? lane : i, color: i });
    });

    lanes = lanes.map((sha) => (sha === c.sha ? null : sha));
    // The first parent continues in this lane. If another lane is already heading there, the two
    // lines join in the leftmost one, so the main line stays on the left after a merge. Other
    // parents join a lane already heading there, or get a new one.
    const [first, ...rest] = c.parents;
    if (first !== undefined) {
      const existing = lanes.indexOf(first);
      if (existing >= 0 && existing < lane) lanes[lane] = null;
      else {
        if (existing >= 0) lanes[existing] = null;
        lanes[lane] = first;
      }
    }
    for (const p of rest) if (!lanes.includes(p)) lanes[free(lane + 1)] = p;

    // Lines passing through carry on in their lane, or curve over to where their commit now is.
    const bottom: Segment[] = [];
    before.forEach((sha, i) => {
      if (sha === null || sha === c.sha) return;
      const to = lanes.indexOf(sha);
      if (to >= 0) bottom.push({ from: i, to, color: i });
    });
    for (const p of c.parents) {
      const to = lanes.indexOf(p);
      if (to >= 0) bottom.push({ from: lane, to, color: to === lane ? lane : Math.max(to, lane) });
    }

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, before.length, lanes.length, lane + 1);
    rows.push({ lane, top, bottom });
  }
  return { rows, width };
}
