// The Arbor mark: a root node with three children, drawn in currentColor so it follows the text color.
// Matches src/web/arbor.svg, which is the favicon.

export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M16 11.2V14M9 14h14M9 14v3.6M16 14v3.6M23 14v3.6" />
      </g>
      <g fill="currentColor">
        <circle cx="16" cy="8.5" r="3" />
        <circle cx="9" cy="21.5" r="2.6" />
        <circle cx="16" cy="21.5" r="2.6" />
        <circle cx="23" cy="21.5" r="2.6" />
      </g>
    </svg>
  );
}
