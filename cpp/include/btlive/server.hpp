// btlive server for BehaviorTree.CPP 4.x: streams a running tree to Arbor's live view over a
// WebSocket. The protocol is specified in docs/live_protocol.md.
//
//   btlive::Options options;
//   options.robot_name = "my-robot";
//   btlive::Server live(options);  // ws://<this machine>:1670
//   auto tree = factory.createTree("MainTree");
//   live.attach(tree);
//   while (true) { tree.tickOnce(); tree.sleep(std::chrono::milliseconds(10)); }

#pragma once

#include <behaviortree_cpp/bt_factory.h>

#include <chrono>
#include <memory>
#include <string>

namespace btlive {

struct Options {
  int port = 1670;
  /// Address to listen on; "0.0.0.0" accepts connections from other machines.
  std::string host = "0.0.0.0";
  /// Display name sent in `hello`.
  std::string robot_name;
  /// How often status changes are sent, batched.
  std::chrono::milliseconds batch_period{20};
};

class Server {
 public:
  /// Starts listening; throws std::runtime_error if the port can't be bound.
  explicit Server(Options options = {});
  ~Server();
  Server(const Server&) = delete;
  Server& operator=(const Server&) = delete;

  /// Starts streaming `tree`, replacing any tree attached before (which starts a new session).
  /// The tree must stay alive until it is replaced, detach() is called, or the server is destroyed.
  void attach(BT::Tree& tree);
  /// Stops streaming. Clients keep the last tree they were sent.
  void detach();
  /// Sends an `error` message to every client, e.g. for an exception thrown while ticking.
  void reportError(const std::string& message);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace btlive
