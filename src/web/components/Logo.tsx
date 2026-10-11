// The Arbor mark: a root node with three children, built from wooden logs. The nodes are sawn log
// ends and the connectors are logs seen from the side. Matches src/web/arbor.svg, which is the favicon.
// Wordmark sets the mark beside "ARBOR" spelled in the same logs, log-cabin style.

import { useId } from "react";

type LogIds = { logV: string; logH: string; grain: string; end: string };

function useLogIds(): LogIds {
  // Gradient and symbol ids are per instance, so several logos on a page never resolve to a hidden one.
  // useId's punctuation is stripped because it can break url(#...) references.
  const id = useId().replace(/[^\w-]/g, "");
  return { logV: `${id}logV`, logH: `${id}logH`, grain: `${id}grain`, end: `${id}end` };
}

function LogDefs({ ids }: { ids: LogIds }) {
  return (
    <defs>
      <linearGradient id={ids.logV} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#4a2a12" />
        <stop offset="0.4" stopColor="#9a6434" />
        <stop offset="0.55" stopColor="#a8723f" />
        <stop offset="1" stopColor="#4a2a12" />
      </linearGradient>
      <linearGradient id={ids.logH} href={`#${ids.logV}`} x1="0" y1="0" x2="0" y2="1" />
      <radialGradient id={ids.grain} cx="0.47" cy="0.45" r="0.55">
        <stop offset="0" stopColor="#f3d7a2" />
        <stop offset="0.7" stopColor="#e0b274" />
        <stop offset="1" stopColor="#bf8a50" />
      </radialGradient>
      <g id={ids.end}>
        <circle r="3" fill={`url(#${ids.grain})`} stroke="#4a2a12" strokeWidth="0.7" />
        <g fill="none" stroke="#a8743f" strokeWidth="0.24">
          <circle cx="0.15" cy="-0.1" r="1.75" />
          <circle cx="0.25" cy="-0.15" r="0.85" />
        </g>
        <circle cx="0.3" cy="-0.2" r="0.3" fill="#8a5a2c" />
        <path d="M0.5 0.1 1.6 1.2" stroke="#8a5a2c" strokeWidth="0.2" strokeLinecap="round" />
      </g>
    </defs>
  );
}

/** The tree mark, in a 32-unit box. */
function LogMark({ ids }: { ids: LogIds }) {
  return (
    <g transform="translate(0 0.9)">
      <g fill={`url(#${ids.logV})`} stroke="#3a200c" strokeWidth="0.35">
        <rect x="14.6" y="9" width="2.8" height="5.5" />
        <rect x="7.6" y="14" width="2.8" height="5.5" />
        <rect x="14.6" y="14" width="2.8" height="5.5" />
        <rect x="21.6" y="14" width="2.8" height="5.5" />
      </g>
      <rect x="7" y="12.6" width="18" height="2.8" fill={`url(#${ids.logH})`} stroke="#3a200c" strokeWidth="0.35" />
      <path
        d="M8.6 13.4h4.6M14 14.5h5.2M19.6 13.5h3.6M10.2 14.6h2.4"
        stroke="#4a2a12"
        strokeWidth="0.2"
        strokeLinecap="round"
        opacity="0.7"
      />
      <g fill="#e9c085" stroke="#3a200c" strokeWidth="0.3">
        <ellipse cx="7" cy="14" rx="0.75" ry="1.4" />
        <ellipse cx="25" cy="14" rx="0.75" ry="1.4" />
      </g>
      <use href={`#${ids.end}`} transform="translate(16 7.9) scale(1.07)" />
      <use href={`#${ids.end}`} transform="translate(9 21.5)" />
      <use href={`#${ids.end}`} transform="translate(16 21.5) rotate(120)" />
      <use href={`#${ids.end}`} transform="translate(23 21.5) rotate(240)" />
    </g>
  );
}

export function Logo() {
  const ids = useLogIds();
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <LogDefs ids={ids} />
      <LogMark ids={ids} />
    </svg>
  );
}

// ---------- wordmark ----------

/** One log of a letter, from (x1, y1) to (x2, y2), in letter units (30 tall). */
type Log = [x1: number, y1: number, x2: number, y2: number];

const LOG_WIDTH = 4.4;

// Each letter lists its uprights before its crosspieces, so crosspieces lie on top and their sawn
// ends show at the corners, as on a log cabin.
const LETTERS: { width: number; logs: Log[] }[] = [
  // A: an A-frame whose legs cross above the apex
  {
    width: 26,
    logs: [
      [2.5, 28, 14.5, 1.5],
      [23.5, 28, 11.5, 1.5],
      [3, 19, 23, 19],
    ],
  },
  // R
  {
    width: 22,
    logs: [
      [3, 0.5, 3, 29.5],
      [16.5, 1, 16.5, 16],
      [8, 15, 20.5, 29],
      [0.5, 3, 20.5, 3],
      [0.5, 14.5, 20.5, 14.5],
    ],
  },
  // B
  {
    width: 23,
    logs: [
      [3, 0.5, 3, 29.5],
      [15, 1, 15, 15.5],
      [19, 14.5, 19, 29],
      [0.5, 3, 17.5, 3],
      [0.5, 15, 22.5, 15],
      [0.5, 27, 22.5, 27],
    ],
  },
  // O: a cabin of four logs
  {
    width: 24,
    logs: [
      [3, 0.5, 3, 29.5],
      [21, 0.5, 21, 29.5],
      [0.5, 3, 23.5, 3],
      [0.5, 27, 23.5, 27],
    ],
  },
  // R
  {
    width: 22,
    logs: [
      [3, 0.5, 3, 29.5],
      [16.5, 1, 16.5, 16],
      [8, 15, 20.5, 29],
      [0.5, 3, 20.5, 3],
      [0.5, 14.5, 20.5, 14.5],
    ],
  },
];

const LETTER_GAP = 5;

function LetterLog({ log, seed, ids }: { log: Log; seed: number; ids: LogIds }) {
  const [x1, y1, x2, y2] = log;
  const length = Math.hypot(x2 - x1, y2 - y1);
  const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  const t = LOG_WIDTH;
  // Grain streaks along the bark, shifted per log so neighbors don't match
  const a = 0.12 + (seed % 3) * 0.06;
  const grain = `M${length * a} ${-t * 0.18}h${length * 0.3}M${length * (a + 0.38)} ${t * 0.2}h${length * 0.28}`;
  return (
    <g transform={`translate(${x1} ${y1}) rotate(${angle})`}>
      <rect y={-t / 2} width={length} height={t} fill={`url(#${ids.logH})`} stroke="#3a200c" strokeWidth="0.45" />
      <path d={grain} stroke="#4a2a12" strokeWidth="0.3" strokeLinecap="round" opacity="0.7" />
      <g fill="#e9c085" stroke="#3a200c" strokeWidth="0.4">
        <ellipse rx={t * 0.24} ry={t / 2} />
        <ellipse cx={length} rx={t * 0.24} ry={t / 2} />
      </g>
    </g>
  );
}

/** The mark beside "ARBOR" spelled in logs. Sized by its CSS height. */
export function Wordmark({ className }: { className?: string }) {
  const ids = useLogIds();
  // The mark is 40 units tall; letters are 30 tall, centered beside it
  let x = 42;
  const letters = LETTERS.map((letter, i) => {
    const g = (
      <g key={i} transform={`translate(${x} 5)`}>
        {letter.logs.map((log, j) => (
          <LetterLog key={j} log={log} seed={i + j} ids={ids} />
        ))}
      </g>
    );
    x += letter.width + LETTER_GAP;
    return g;
  });
  const width = x - LETTER_GAP + 1;
  return (
    <svg className={`wordmark ${className ?? ""}`} viewBox={`0 0 ${width} 40`} role="img" aria-label="Arbor">
      <LogDefs ids={ids} />
      <g transform="scale(1.25)">
        <LogMark ids={ids} />
      </g>
      {letters}
    </svg>
  );
}
