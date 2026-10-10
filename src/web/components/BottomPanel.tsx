import { useEffect, useMemo, useRef, useState } from "react";
import { serializeTreeFile } from "../../shared/xml_write.ts";
import { requestBlackboard, setBlackboardPolling } from "../live.ts";
import { openTree, togglePanel, useDiagnostics, useStore } from "../store.ts";

export function reveal(treeId: string, path: string) {
  openTree(treeId, path);
  // Let the canvas lay out the newly opened tree before centering on the node.
  setTimeout(() => window.dispatchEvent(new CustomEvent("bt-reveal", { detail: path })), 80);
}

export function BottomPanel() {
  const tab = useStore((s) => s.bottomTab);
  const open = useStore((s) => s.bottomOpen);
  const diagnostics = useDiagnostics();
  const liveOn = useStore((s) => s.live.state !== "idle");
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  const warnings = diagnostics.filter((d) => d.severity === "warning").length;

  const tabs: { id: typeof tab; label: React.ReactNode }[] = [
    {
      id: "problems",
      label: (
        <>
          Problems {errors > 0 && <span className="badge badge-error">{errors}</span>}
          {warnings > 0 && <span className="badge badge-warning">{warnings}</span>}
        </>
      ),
    },
    { id: "xml", label: "XML" },
    { id: "log", label: <>Live log{liveOn && <span className="live-dot state-connected small" />}</> },
    { id: "blackboard", label: "Blackboard" },
  ];

  return (
    <section className={`bottom-panel ${open ? "open" : "closed"}`}>
      <div className="bottom-tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`bottom-tab ${t.id === tab && open ? "active" : ""}`}
            onClick={() => useStore.setState({ bottomTab: t.id, bottomOpen: !(open && t.id === tab) })}
          >
            {t.label}
          </button>
        ))}
        <div className="spacer" />
        <button className="icon-button" onClick={() => useStore.setState({ bottomOpen: !open })} title={open ? "Shrink to its tabs" : "Expand"}>
          {open ? "▾" : "▴"}
        </button>
        <button className="icon-button" onClick={() => togglePanel("bottom")} title="Hide this panel (Ctrl+J)">
          ×
        </button>
      </div>
      {open && (
        <div className="bottom-body">
          {tab === "problems" && <Problems />}
          {tab === "xml" && <XmlPreview />}
          {tab === "log" && <LiveLog />}
          {tab === "blackboard" && <Blackboard />}
        </div>
      )}
    </section>
  );
}

function Problems() {
  const diagnostics = useDiagnostics();
  if (!diagnostics.length) return <p className="muted pad">No problems found.</p>;
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...diagnostics].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <ul className="problem-list">
      {sorted.map((d, i) => (
        <li
          key={i}
          className={`sev-${d.severity} ${d.treeId ? "clickable" : ""}`}
          onClick={() => d.treeId && (d.nodeUid ? reveal(d.treeId, d.nodeUid) : openTree(d.treeId))}
        >
          <span className="sev-icon">{d.severity === "error" ? "⨯" : d.severity === "warning" ? "⚠" : "ℹ"}</span>
          <span className="problem-msg">{d.message}</span>
          <span className="muted">{d.treeId ?? d.file ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

function XmlPreview() {
  const active = useStore((s) => s.active);
  const trees = useStore((s) => s.trees);
  const files = useStore((s) => s.files);
  const robotXml = useStore((s) => s.live.robotXml);
  const [which, setWhich] = useState<"file" | "robot">("file");
  const xml = useMemo(() => {
    if (which === "robot") return robotXml ?? "";
    if (!active) return "";
    const f = files[trees[active].file];
    return serializeTreeFile({ mainTree: f.mainTree, includes: f.includes, trees: f.treeIds.map((id) => trees[id]) });
  }, [which, active, trees, files, robotXml]);
  return (
    <div className="xml-preview">
      <div className="row">
        <span className="muted">{which === "file" ? (active ? `${trees[active].file} as it will be saved` : "") : "Tree as loaded on the robot"}</span>
        <div className="spacer" />
        {robotXml && (
          <select value={which} onChange={(e) => setWhich(e.target.value as "file" | "robot")}>
            <option value="file">This file</option>
            <option value="robot">Robot</option>
          </select>
        )}
        <button className="small" onClick={() => void navigator.clipboard.writeText(xml)}>
          Copy
        </button>
      </div>
      <pre className="mono">{xml}</pre>
    </div>
  );
}

function LiveLog() {
  const log = useStore((s) => s.live.log);
  const runtime = useStore((s) => s.live.runtime);
  const mapping = useStore((s) => s.live.mapping);
  const treeId = useStore((s) => s.live.treeId);
  const state = useStore((s) => s.live.state);
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const byUid = useMemo(() => new Map((runtime ?? []).map((n) => [n.uid, n])), [runtime]);
  const rows = useMemo(() => {
    const f = filter.toLowerCase();
    const all = log.slice(-500);
    return f ? all.filter((e) => (byUid.get(e.uid)?.name ?? "").toLowerCase().includes(f) || e.status.toLowerCase().includes(f)) : all;
  }, [log, filter, byUid]);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [rows, follow]);

  if (state === "idle") return <p className="muted pad">Connect to a robot (top right), or open a log file to replay, to see status transitions.</p>;
  return (
    <div className="live-log">
      {mapping && mapping.mismatches.length > 0 && (
        <details className="notice warning">
          <summary>
            The robot's tree differs from this project ({mapping.unmatched} unmatched node{mapping.unmatched === 1 ? "" : "s"}). Statuses of
            unmatched nodes are only shown here.
          </summary>
          <ul>
            {mapping.mismatches.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="row">
        <input placeholder="Filter by node or status…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          <span>Follow</span>
        </label>
      </div>
      <div className="log-rows mono" ref={ref}>
        {rows.map((e, i) => {
          const n = byUid.get(e.uid);
          const m = mapping?.byRuntimeUid.get(e.uid);
          return (
            <div
              key={i}
              className={`log-row ${m ? "clickable" : ""}`}
              onClick={() => m && treeId && reveal(treeId, m.path)}
              title={n?.path}
            >
              <span className="muted">{new Date(e.t).toISOString().slice(11, 23)}</span>
              <span className="log-node">{n?.name ?? `#${e.uid}`}</span>
              <span className={`st is-${e.prev.toLowerCase()}`}>{e.prev}</span>→<span className={`st is-${e.status.toLowerCase()}`}>{e.status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Blackboard() {
  const bb = useStore((s) => s.live.blackboard);
  const state = useStore((s) => s.live.state);
  const [poll, setPoll] = useState(false);
  useEffect(() => {
    setBlackboardPolling(poll && state === "connected");
    return () => setBlackboardPolling(false);
  }, [poll, state]);
  if (state === "replay") return <p className="muted pad">Log files (.btlog) don't record blackboard values, only node statuses.</p>;
  if (state !== "connected") return <p className="muted pad">Connect to a robot to inspect its blackboards.</p>;
  return (
    <div className="blackboard">
      <div className="row">
        <button className="small" onClick={requestBlackboard}>
          Refresh
        </button>
        <label className="check">
          <input type="checkbox" checked={poll} onChange={(e) => setPoll(e.target.checked)} />
          <span>Auto-refresh (1 Hz)</span>
        </label>
      </div>
      {!bb && <p className="muted">Press Refresh to fetch the blackboards.</p>}
      {bb?.blackboards.map((b) => (
        <div key={b.path} className="bb-group">
          <div className="bb-title">
            {b.path} <span className="muted">({b.tree_id})</span>
          </div>
          <table>
            <tbody>
              {Object.entries(b.entries).map(([k, v]) => (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  <td className="muted mono">{v.type}</td>
                  <td className="mono">{typeof v.value === "string" ? v.value : JSON.stringify(v.value)}</td>
                </tr>
              ))}
              {Object.keys(b.entries).length === 0 && (
                <tr>
                  <td className="muted">empty</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
