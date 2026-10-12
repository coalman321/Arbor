# btlive v1: live tree status over WebSocket

`btlive` is how a robot running BehaviorTree.CPP streams its tree's state to Arbor. It is JSON text
over a single WebSocket. The robot is the server; the editor (or any other tool) connects as a
client and only listens, apart from a few requests.

- **Robot side:** implement the server in your application, for BehaviorTree.CPP 4.x. A
  `BT::StatusChangeLogger` subclass sees every transition, and `BT::Tree::applyVisitor` gives the
  node order described under [Node identity](#node-identity).
- **Reference server:** [`cpp/`](../cpp/) for BehaviorTree.CPP 4.x applications, ready to use.
  The mock robot in [`src/mock/`](../src/mock/) is a simulated one in TypeScript.
- **Reference client:** [`src/web/live.ts`](../src/web/live.ts).
- **Types:** [`packages/arborist/src/protocol.ts`](../packages/arborist/src/protocol.ts) mirrors this document. Keep the
  two in sync.

## Connection

| | |
|---|---|
| Transport | WebSocket, text frames, one JSON object per frame |
| Default port | `1670` (Groot2 uses 1667/1668; this avoids colliding with it) |
| Path | `/` |
| Auth | None. Only expose the port on networks you trust. |

The editor doesn't connect to the robot from the browser. Its backend opens the robot socket and
relays frames unchanged, adding `relay` messages about the robot connection's state. The robot only
needs to be reachable from the machine running the editor backend.

On connect, the server sends `hello`. If a tree is attached, it then sends `tree` and `snapshot`.
After that it pushes `status` batches as nodes change, and a new `tree` whenever the application
attaches a different tree.

## Sessions

Every time the robot starts streaming a tree instance, it increments `session`. Every message about
node statuses carries the session it belongs to. A client ignores `snapshot`/`status` messages whose
session doesn't match the last `tree` it received; they belong to a tree that has been replaced.

## Node identity

Nodes are identified by `uid`: `BT::TreeNode::UID()`, unique within one tree instance and stable
for its lifetime. Node definitions have no stable identity across processes, so the editor pairs
runtime nodes with nodes in its files **by structure**. Both sides walk the tree depth-first in
pre-order, with every `SubTree` expanded in place, the same way `BT::Tree::applyVisitor` walks it. The
editor then compares node types position by position. Where they differ (the robot runs an older
version of the file, say), it reports a mismatch and leaves that branch unmapped.

## Robot → client messages

### `hello`

```json
{ "op": "hello", "protocol": "btlive", "version": 1, "robot": "hexd-01" }
```

`version` is the protocol version. A client should warn if it isn't one it implements. `robot` is a
display name and may be empty.

### `tree`

The tree the robot is executing.

```json
{
  "op": "tree",
  "session": 3,
  "tree_id": "MainTree",
  "nodes": [
    { "uid": 1, "parent": null, "type": "ReactiveFallback", "name": "root", "category": "Control", "path": "root" },
    { "uid": 5, "parent": 2, "type": "SubTree", "name": "Recharge", "category": "SubTree", "path": "Recharge::5", "subtree": "Recharge" },
    { "uid": 6, "parent": 5, "type": "Sequence", "name": "Sequence", "category": "Control", "path": "Recharge::5/Sequence::6" }
  ],
  "xml": "<root BTCPP_format=\"4\">…</root>"
}
```

| Field | |
|---|---|
| `tree_id` | ID of the main tree (`BT::Tree::subtrees[0]->tree_ID`) |
| `nodes` | **Every** node, in depth-first pre-order (parents before children, children in order) |
| `nodes[].uid` | `TreeNode::UID()` |
| `nodes[].parent` | Parent's uid; `null` only for the root. A SubTree node's single child is the root of the tree it instantiates. |
| `nodes[].type` | Registration ID (`TreeNode::registrationName()`), e.g. `Sequence`, `MoveTo`, `SubTree` |
| `nodes[].name` | Instance name (`TreeNode::name()`) |
| `nodes[].category` | Optional: `Action`, `Condition`, `Control`, `Decorator` or `SubTree` |
| `nodes[].path` | Optional: `TreeNode::fullPath()`, for display |
| `nodes[].subtree` | SubTree nodes only: ID of the tree instantiated |
| `xml` | Optional: the tree as loaded (`BT::WriteTreeToXML`), so a client can show what differs |

### `snapshot`

The current status of every node that isn't `IDLE`. Sent after `tree`, and on request. Nodes not
listed are `IDLE`.

```json
{ "op": "snapshot", "session": 3, "t": 1791651710158.2, "statuses": [[1, "RUNNING"], [2, "RUNNING"], [7, "SUCCESS"]] }
```

`t` is the robot's wall clock, in milliseconds since the Unix epoch.

### `status`

A batch of status transitions, oldest first. Servers batch changes, every 20 ms by default, to keep
the message rate bounded however fast the tree ticks.

```json
{ "op": "status", "session": 3, "changes": [[1791651710158.2, 7, "IDLE", "RUNNING"], [1791651710161.9, 7, "RUNNING", "SUCCESS"]] }
```

Each change is `[t, uid, previous, status]`. `t` is milliseconds since the Unix epoch, robot clock.
Statuses are `IDLE`, `RUNNING`, `SUCCESS`, `FAILURE` and `SKIPPED`. Transitions back to `IDLE` are
included: BT.CPP resets nodes to `IDLE` when their parent completes, so a node's *result* is the last
non-`IDLE` status before that.

### `blackboard`

The reply to `get_blackboard`: every blackboard of the tree, one per tree instance (the main tree and
each SubTree instance).

```json
{
  "op": "blackboard",
  "request_id": 7,
  "session": 3,
  "blackboards": [
    { "path": "MainTree", "tree_id": "MainTree", "entries": { "attempts": { "type": "int", "value": 1 } } },
    { "path": "FetchObject::16", "tree_id": "FetchObject", "entries": { "object_pose": { "type": "geometry_msgs::msg::PoseStamped", "value": null } } }
  ]
}
```

`value` is the entry converted with `BT::JsonExporter` when its type is registered there, else its
string form when it holds a string, else `null`. `type` is the entry's declared C++ type.

### `error`

```json
{ "op": "error", "message": "unknown op \"foo\"", "request_id": 8 }
```

Sent for a bad request (with its `request_id`, if it had one), or by the application to report a
runtime problem, such as an exception thrown while ticking.

## Client → robot messages

| Message | Reply |
|---|---|
| `{ "op": "get_tree" }` | `tree` |
| `{ "op": "get_snapshot" }` | `snapshot` |
| `{ "op": "get_blackboard", "request_id": 7 }` | `blackboard` with the same `request_id` |

`request_id` is optional and echoed back unchanged.

## Editor backend → browser only

### `relay`

The state of the backend's connection to the robot. The backend retries every 2 s while the robot is
unreachable.

```json
{ "op": "relay", "state": "connected", "url": "ws://robot:1670" }
```

`state` is `connecting`, `connected`, `disconnected` or `error`, with an optional `message`.

## Compatibility

New optional fields may be added to any message without changing `version`; clients ignore fields
they don't know. Removing or changing the meaning of a field, or a message that clients must handle,
increments `version`.
