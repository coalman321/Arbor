// Embeds the viewer the way a host that doesn't use React would: the mount API only. Run from
// packages/arborist: npx vite examples/embed
//
// It shows Arbor's demo project, replays test/fixtures/demo_dry_run.btlog through the status
// overlay, and compares the trees with an edited copy.

import { createTreeViewer, type NodeStatus, type StatusChange, type XmlFile } from "../../src/mount.tsx";
// The .btlog reader lives in the Arbor app; good enough for a demo.
import { parseBtlog, STATUS_BY_CODE } from "../../../../src/shared/btlog.ts";
import logUrl from "../../../../test/fixtures/demo_dry_run.btlog?url";

const raw = import.meta.glob("../../../../examples/demo_project/**/*.xml", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const files: XmlFile[] = [];
let spec: XmlFile | undefined;
for (const [path, xml] of Object.entries(raw)) {
  const rel = path.replace(/^.*demo_project\//, "");
  if (rel === "nodes.xml") spec = { path: rel, xml };
  else files.push({ path: rel, xml });
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status");
const viewer = createTreeViewer($("viewer"), {
  treeId: "MainTree",
  onSelect: (path) => (status.textContent = path ? `Selected ${path}` : ""),
  onTreeChange: (id) => ($<HTMLSelectElement>("tree").value = id),
});
const loaded = viewer.load({ spec, files });

const treeSelect = $<HTMLSelectElement>("tree");
for (const t of loaded.trees) treeSelect.add(new Option(t.id, t.id));
treeSelect.value = "MainTree";
treeSelect.onchange = () => viewer.showTree(treeSelect.value);
$<HTMLSelectElement>("theme").onchange = (e) => viewer.setOptions({ theme: (e.target as HTMLSelectElement).value as "auto" });

// Plays the log back at its own pace, as a host would forward a robot's status messages.
let timer: number | undefined;
$("replay").onclick = async () => {
  window.clearTimeout(timer);
  viewer.clearComparison();
  const log = parseBtlog(await (await fetch(logUrl)).arrayBuffer());
  viewer.setRuntimeTree(log.treeId, log.nodes);
  const mismatches = viewer.mismatches;
  status.textContent = mismatches.length ? `Log doesn't match the trees: ${mismatches[0]}` : "Replaying…";
  const last = new Map<number, NodeStatus>();
  let i = 0;
  const step = () => {
    const batch: StatusChange[] = [];
    const t0 = log.times[i];
    for (; i < log.times.length && log.times[i] - t0 < 50; i++) {
      const uid = log.uids[i];
      const s = STATUS_BY_CODE[log.statuses[i]];
      batch.push([log.startMs + log.times[i], uid, last.get(uid) ?? "IDLE", s]);
      last.set(uid, s);
    }
    viewer.applyStatusChanges(batch);
    if (i < log.times.length) timer = window.setTimeout(step, Math.min(400, log.times[i] - log.times[i - 1]));
    else status.textContent = "Replay done";
  };
  step();
};

// The "after" side: the demo with a node removed, one added, and a port edited.
let comparing = false;
$("compare").onclick = () => {
  window.clearTimeout(timer);
  comparing = !comparing;
  $("compare").textContent = comparing ? "Back to the trees" : "Compare with an edited copy";
  if (!comparing) return viewer.clearComparison();
  const edited = files.map((f) =>
    f.path !== "trees/main.xml"
      ? f
      : {
          ...f,
          xml: f.xml
            .replace('<Script code="attempts := 0"/>', '<Script code="attempts := 0"/>\n        <Say message="Starting"/>')
            .replace('min_percent="25"', 'min_percent="30"')
            .replace('<Say message="Got it, eventually"/>', '<AlwaysSuccess/>'),
        },
  );
  const c = viewer.compare({ spec, files }, { spec, files: edited });
  status.textContent = c.trees.map((t) => `${t.new?.id ?? t.old?.id}: ${t.status}`).join(", ");
};
