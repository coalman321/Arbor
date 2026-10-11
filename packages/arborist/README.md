# Arborist

Load, lay out and draw [BehaviorTree.CPP](https://www.behaviortree.dev/) v4 trees, with live node
statuses and diffs between versions. Arborist is the viewer inside the
[Arbor](https://github.com/coalman321/Arbor) editor, packaged so that other tools can show trees the
same way.

It has three entry points:

| Import | What it is | Needs |
|---|---|---|
| `@coalman321/arborist` | Core: XML parsing, layout, status mapping, diffs. No DOM, no React, no Node APIs. | nothing |
| `@coalman321/arborist/react` | `<TreeViewer>` and the node/edge views, for React apps | `react`, `react-dom`, `@xyflow/react`, plus `@coalman321/arborist/style.css` |
| `@coalman321/arborist/mount` | `createTreeViewer(element)`: the whole viewer in one file, React and styles included | nothing |

## Quick start (any page)

```ts
import { createTreeViewer } from "@coalman321/arborist/mount";

const viewer = createTreeViewer(document.getElementById("tree")!, { theme: "dark" });

// Tree files and (optionally) the TreeNodesModel spec, read however the host likes.
const loaded = viewer.load({
  spec: { path: "nodes.xml", xml: specXml },
  files: [{ path: "trees/main.xml", xml: mainXml }],
});
console.log(loaded.diagnostics); // unparsable XML, duplicate tree IDs, ...
viewer.showTree("MainTree");
```

The element needs a size; the viewer fills it. The user can pan, zoom, select nodes, open SubTrees
(double-click) and expand them inline (the + on a SubTree node). Nothing can be edited.

## Live statuses

Statuses are reported by **runtime UID**, the way BT.CPP numbers the nodes of a running tree. Tell
the viewer which tree runs and how its nodes are numbered, then feed it status changes:

```ts
// The robot's tree: every node, depth-first pre-order with SubTrees expanded
// (BT::Tree::applyVisitor order). btlive's "tree" message carries exactly this.
viewer.setRuntimeTree("MainTree", [
  { uid: 1, parent: null, type: "Sequence", name: "root" },
  { uid: 2, parent: 1, type: "IsBatteryOk", name: "IsBatteryOk" },
  // ...
]);

viewer.applySnapshot([[1, "RUNNING"], [2, "SUCCESS"]], Date.now()); // [uid, status][] at a time
viewer.applyStatusChanges([[Date.now(), 2, "SUCCESS", "IDLE"]]);   // [t, uid, prev, status][]

viewer.mismatches; // where the robot's tree and the loaded trees differ, if they do
```

When the root starts a new run, the previous run's results fade. Nodes that finished in the current
run keep showing their result after BT.CPP resets them to IDLE. The runtime tree can also come from
a `.btlog` (its XML has every node's `_uid`) or any log the host reads.

Hosts that work in their own terms can use the core's `StatusTracker`, which does the same without a
viewer, and pass its `statuses` to `<TreeViewer statuses>` or `viewer.setStatuses()`.

## Diffs

```ts
const comparison = viewer.compare(
  { spec, files: filesAtLastCommit },   // before: XML, or loadTrees() output
  { spec, files: filesOnDisk },         // after
);
comparison.trees; // per-tree status: changed, renamed, added, removed, unchanged
viewer.clearComparison();
```

Each tree is drawn merged from both versions. Added nodes are green, removed ones red and dashed,
moved ones blue with a marker where they were, and edited ones show the old and new attribute
values. The diff is structural, so it ignores formatting, attribute order and v3/v4 syntax.

## React

```tsx
import { loadTrees, StatusTracker } from "@coalman321/arborist";
import { TreeViewer, type TreeViewerHandle } from "@coalman321/arborist/react";
import "@coalman321/arborist/style.css";

const { trees, models } = loadTrees({ spec, files });

<TreeViewer
  trees={trees}
  models={models}
  treeId="MainTree"
  statuses={tracker.statuses}   // re-render with the new object after each update
  liveTreeId={tracker.treeId}
  onSelect={(path) => ...}
  ref={handleRef}               // handleRef.current.fit(), .reveal(path)
/>;
```

`compare={compareTrees(before, after)}` shows a diff. For a custom canvas, the node views, `flowNodes()`,
`flowEdges()` and `ViewerContext` are exported as well. That's how Arbor's editor draws its
editable canvas with the same views.

## Theming

Everything sits under `.arbor-viewer`, which carries the color tokens (`--node-bg`, `--accent`,
`--cat-action`, `--st-running`, `--diff-add`, ...; see `src/viewer.css`). Override them on
`.arbor-viewer` to restyle the viewer. `theme: "light" | "dark" | "auto"` picks a built-in scheme;
"auto" follows `prefers-color-scheme`.

## Example and development

```bash
npm run build                 # dist/: index.js, react.js, mount.js, style.css, types/
npm test
npx vite examples/embed       # the mount API on Arbor's demo project, with log replay and a diff
```

Inside the Arbor repository, the app uses the TypeScript sources directly through the `source`
export condition, so no build is needed while working on both.

## License

MIT
