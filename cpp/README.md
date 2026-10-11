# btlive for BehaviorTree.CPP

A reference [btlive](../docs/live_protocol.md) server for C++ applications that use
[BehaviorTree.CPP](https://www.behaviortree.dev/) 4.x. Add it to your application and Arbor's live
view can connect to the running tree: **Connect** with `ws://<robot>:1670`.

It is two files, [`include/btlive/server.hpp`](include/btlive/server.hpp) and
[`src/server.cpp`](src/server.cpp). Use it as a library, or copy them into your project and adapt
them. It depends on BehaviorTree.CPP and [IXWebSocket](https://github.com/machinezone/IXWebSocket).
JSON comes from the copy of nlohmann/json that BehaviorTree.CPP ships.

## Use

```cpp
#include <btlive/server.hpp>

btlive::Options options;            // port 1670 on all interfaces, status batches every 20 ms
options.robot_name = "my-robot";
btlive::Server live(options);       // starts listening; throws if the port is taken

auto tree = factory.createTree("MainTree");
live.attach(tree);                  // clients now see this tree
while (tree.tickOnce() == BT::NodeStatus::RUNNING) {
  tree.sleep(std::chrono::milliseconds(10));
}
```

- **`attach(tree)`** starts streaming a tree. Calling it again with another tree replaces it and starts
  a new session, which connected clients switch to. The tree must outlive the attachment: call
  `detach()` (or attach another tree) before destroying it.
- **`detach()`** stops streaming. Connected clients keep showing the last tree.
- **`reportError(message)`** sends an `error` message to every client, for example from a `catch`
  around `tickOnce()`.

Blackboard values are sent as JSON when their type is registered with `BT::JsonExporter`, as text
when they hold a string, and as `null` otherwise.

The server has no authentication. By default it listens on all interfaces, so the editor can
connect from another machine; set `options.host = "127.0.0.1"` to only accept local connections.

## Build

With BehaviorTree.CPP and IXWebSocket installed (for example from ROS 2, vcpkg or your package
manager):

```bash
cmake -S cpp -B build/cpp
cmake --build build/cpp
```

To have CMake download and build both instead, add `-DBTLIVE_FETCH_DEPS=ON`. In your own CMake
project, use `add_subdirectory(path/to/Arbor/cpp)` and link the `btlive` target.

## Demo

`btlive_demo` runs the trees of [`examples/demo_project`](../examples/demo_project) with simulated
nodes (a battery that drains, detections that sometimes fail) and streams them:

```bash
cmake -S cpp -B build/cpp -DBTLIVE_FETCH_DEPS=ON
cmake --build build/cpp
./build/cpp/btlive_demo examples/demo_project       # ws://localhost:1670
```

Open `examples/demo_project` in Arbor and press **Connect**. The demo restarts the tree each time it
finishes, so you can also watch session changes.
