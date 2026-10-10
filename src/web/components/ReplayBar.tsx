import { closeReplay, openLogFile, pause, seek, setSpeed, SPEEDS, step, togglePlay } from "../replay.ts";
import { useStore } from "../store.ts";

/** Lets the user pick a .btlog from their computer and starts playing it. */
export function pickLogFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".btlog";
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) void openLogFile(file);
  };
  input.click();
}

function fmt(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(3)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

/** Transport controls for a log being replayed; sits under the canvas. */
export function ReplayBar() {
  const r = useStore((s) => s.replay);
  const mapping = useStore((s) => s.live.mapping);
  const mismatches = mapping?.mismatches ?? [];
  const unmatched = mapping?.unmatched ?? 0;
  if (!r) return null;
  const pct = (t: number) => (r.duration ? (t / r.duration) * 100 : 0);

  return (
    <div className="replay-bar" role="toolbar" aria-label="Log playback">
      <span className="replay-title" title={`${r.name}: ${r.count} status changes, recorded ${new Date(r.startMs).toLocaleString()}`}>
        Replay: <strong>{r.name}</strong>
      </span>
      <div className="replay-buttons">
        <button onClick={() => (pause(), seek(0))} title="Go to the start (Home)">
          ⇤
        </button>
        <button onClick={() => step(-1)} title="Back one change (←)">
          ◂
        </button>
        <button className="primary replay-play" onClick={togglePlay} title="Play / pause (Space)">
          {r.playing ? "❚❚" : "▶"}
        </button>
        <button onClick={() => step(1)} title="Forward one change (→)">
          ▸
        </button>
        <button onClick={() => (pause(), seek(r.duration))} title="Go to the end (End)">
          ⇥
        </button>
      </div>
      <div className="replay-track">
        {/* Where the whole tree finished: green for success, red for failure. */}
        {r.marks.map((m, i) => (
          <span key={i} className={`replay-mark is-${m.status.toLowerCase()}`} style={{ left: `${pct(m.t)}%` }} title={`${m.status} at ${fmt(m.t)}`} />
        ))}
        <input
          type="range"
          min={0}
          max={r.duration || 1}
          step="any"
          value={r.t}
          onChange={(e) => seek(Number(e.target.value))}
          onMouseDown={pause}
          aria-label="Playback position"
        />
      </div>
      <span className="replay-time mono" title={new Date(r.startMs + r.t).toLocaleTimeString()}>
        {fmt(r.t)} / {fmt(r.duration)}
      </span>
      <select value={r.speed} onChange={(e) => setSpeed(Number(e.target.value))} title="Playback speed" aria-label="Playback speed">
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}×
          </option>
        ))}
      </select>
      {mismatches.length > 0 && (
        <span className="badge badge-warning" title={mismatches.join("\n")}>
          {unmatched} node{unmatched === 1 ? "" : "s"} not in project
        </span>
      )}
      <button className="icon-button" onClick={closeReplay} title="Close the log">
        ×
      </button>
    </div>
  );
}
