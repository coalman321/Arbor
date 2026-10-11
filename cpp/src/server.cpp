#include "btlive/server.hpp"

#include <behaviortree_cpp/contrib/json.hpp>
#include <behaviortree_cpp/decorators/subtree_node.h>
#include <behaviortree_cpp/json_export.h>
#include <behaviortree_cpp/loggers/abstract_logger.h>
#include <behaviortree_cpp/xml_parsing.h>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocketServer.h>

#include <condition_variable>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

namespace btlive {

using json = nlohmann::json;

namespace {

constexpr int kProtocolVersion = 1;

double nowMs() {
  return std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
}

const char* category(BT::NodeType type) {
  switch (type) {
    case BT::NodeType::ACTION: return "Action";
    case BT::NodeType::CONDITION: return "Condition";
    case BT::NodeType::CONTROL: return "Control";
    case BT::NodeType::DECORATOR: return "Decorator";
    case BT::NodeType::SUBTREE: return "SubTree";
    default: return nullptr;
  }
}

// Depth-first pre-order with SubTrees expanded in place (a SubTree's child is the root of the tree
// it instantiates): the order the editor matches nodes in. See "Node identity" in the protocol.
void collectNodes(const BT::TreeNode* node, const BT::TreeNode* parent, json& out, std::vector<const BT::TreeNode*>& order) {
  json n = {
      {"uid", node->UID()},
      {"parent", parent ? json(parent->UID()) : json(nullptr)},
      {"type", node->registrationName()},
      {"name", node->name()},
      {"path", node->fullPath()},
  };
  if (const char* c = category(node->type())) n["category"] = c;
  if (auto* sub = dynamic_cast<const BT::SubTreeNode*>(node)) n["subtree"] = sub->subtreeID();
  out.push_back(std::move(n));
  order.push_back(node);
  if (auto* control = dynamic_cast<const BT::ControlNode*>(node)) {
    for (const BT::TreeNode* child : control->children()) collectNodes(child, node, out, order);
  } else if (auto* decorator = dynamic_cast<const BT::DecoratorNode*>(node)) {
    if (decorator->child()) collectNodes(decorator->child(), node, out, order);
  }
}

}  // namespace

struct Server::Impl {
  // Records transitions as the tree ticks. Runs on the ticking thread, so it only queues them.
  class Logger : public BT::StatusChangeLogger {
   public:
    Logger(BT::TreeNode* root, Impl& impl, int session) : BT::StatusChangeLogger(root), impl_(impl), session_(session) {}
    void callback(BT::Duration, const BT::TreeNode& node, BT::NodeStatus prev, BT::NodeStatus status) override {
      std::lock_guard lock(impl_.pending_mutex);
      impl_.pending.push_back({session_, {nowMs(), node.UID(), BT::toStr(prev), BT::toStr(status)}});
    }
    void flush() override {}

   private:
    Impl& impl_;
    int session_;
  };

  struct Change {
    int session;
    json change;  // [t, uid, previous, status]
  };

  Options options;
  ix::WebSocketServer ws;

  // Guards the attached tree and serializes sends, so every client sees messages in order.
  std::mutex state_mutex;
  BT::Tree* tree = nullptr;
  int session = 0;
  json tree_msg;
  std::vector<const BT::TreeNode*> nodes;
  std::unique_ptr<Logger> logger;

  std::mutex pending_mutex;
  std::vector<Change> pending;

  std::thread flusher;
  std::mutex stop_mutex;
  std::condition_variable stop_cv;
  bool stopping = false;

  explicit Impl(Options opts) : options(std::move(opts)), ws(options.port, options.host) {}

  static void send(ix::WebSocket& client, const json& msg) { client.sendText(msg.dump()); }

  void broadcast(const json& msg, const ix::WebSocket* skip = nullptr) {
    const std::string text = msg.dump();
    for (const auto& client : ws.getClients()) {
      if (client.get() != skip) client->sendText(text);
    }
  }

  json snapshotMsg() const {
    json statuses = json::array();
    for (const BT::TreeNode* node : nodes) {
      const BT::NodeStatus status = node->status();
      if (status != BT::NodeStatus::IDLE) statuses.push_back({node->UID(), BT::toStr(status)});
    }
    return {{"op", "snapshot"}, {"session", session}, {"t", nowMs()}, {"statuses", std::move(statuses)}};
  }

  json blackboardMsg(const json& request_id) const {
    json boards = json::array();
    for (const auto& subtree : tree->subtrees) {
      json entries = json::object();
      for (const auto& key : subtree->blackboard->getKeys()) {
        auto entry = subtree->blackboard->getEntry(std::string(key));
        if (!entry) continue;
        std::unique_lock lock(entry->entry_mutex);
        json value = nullptr;
        if (!entry->value.empty() && !BT::JsonExporter::get().toJson(entry->value, value)) {
          value = entry->value.isString() ? json(entry->value.cast<std::string>()) : json(nullptr);
        }
        entries[std::string(key)] = {{"type", entry->info.typeName()}, {"value", std::move(value)}};
      }
      // The main tree's instance has no name; SubTree instances are named by the SubTree node's path.
      const std::string path = subtree->instance_name.empty() ? subtree->tree_ID : subtree->instance_name;
      boards.push_back({{"path", path}, {"tree_id", subtree->tree_ID}, {"entries", std::move(entries)}});
    }
    json msg = {{"op", "blackboard"}, {"session", session}, {"blackboards", std::move(boards)}};
    if (!request_id.is_null()) msg["request_id"] = request_id;
    return msg;
  }

  // Sends queued transitions of the current session; ones from a replaced tree are dropped.
  void flushLocked(const ix::WebSocket* skip = nullptr) {
    std::vector<Change> batch;
    {
      std::lock_guard lock(pending_mutex);
      batch.swap(pending);
    }
    json changes = json::array();
    for (auto& c : batch) {
      if (c.session == session) changes.push_back(std::move(c.change));
    }
    if (!changes.empty()) broadcast({{"op", "status"}, {"session", session}, {"changes", std::move(changes)}}, skip);
  }

  void onOpen(ix::WebSocket& client) {
    std::lock_guard lock(state_mutex);
    // Send older transitions to everyone else first, so this client's snapshot is the newest state.
    flushLocked(&client);
    send(client, {{"op", "hello"}, {"protocol", "btlive"}, {"version", kProtocolVersion}, {"robot", options.robot_name}});
    if (tree) {
      send(client, tree_msg);
      send(client, snapshotMsg());
    }
  }

  void onMessage(ix::WebSocket& client, const std::string& text) {
    json request = json::parse(text, nullptr, false);
    if (!request.is_object()) return send(client, {{"op", "error"}, {"message", "invalid JSON"}});
    const json request_id = request.value("request_id", json(nullptr));
    const std::string op = request.value("op", "");
    auto error = [&](const std::string& message) {
      json msg = {{"op", "error"}, {"message", message}};
      if (!request_id.is_null()) msg["request_id"] = request_id;
      send(client, msg);
    };

    std::lock_guard lock(state_mutex);
    if (op != "get_tree" && op != "get_snapshot" && op != "get_blackboard") return error("unknown op \"" + op + "\"");
    if (!tree) return error("no tree attached");
    if (op == "get_tree") return send(client, tree_msg);
    flushLocked(&client);
    if (op == "get_snapshot") return send(client, snapshotMsg());
    send(client, blackboardMsg(request_id));
  }

  void runFlusher() {
    std::unique_lock stop_lock(stop_mutex);
    while (!stop_cv.wait_for(stop_lock, options.batch_period, [this] { return stopping; })) {
      std::lock_guard lock(state_mutex);
      flushLocked();
    }
  }
};

Server::Server(Options options) : impl_(std::make_unique<Impl>(std::move(options))) {
  ix::initNetSystem();
  Impl& impl = *impl_;
  impl.ws.disablePerMessageDeflate();
  impl.ws.setOnClientMessageCallback(
      [&impl](std::shared_ptr<ix::ConnectionState>, ix::WebSocket& client, const ix::WebSocketMessagePtr& msg) {
        if (msg->type == ix::WebSocketMessageType::Open) impl.onOpen(client);
        else if (msg->type == ix::WebSocketMessageType::Message) impl.onMessage(client, msg->str);
      });
  auto [ok, error] = impl.ws.listen();
  if (!ok) throw std::runtime_error("btlive: can't listen on " + impl.options.host + ":" + std::to_string(impl.options.port) + ": " + error);
  impl.ws.start();
  impl.flusher = std::thread([&impl] { impl.runFlusher(); });
}

Server::~Server() {
  detach();
  {
    std::lock_guard lock(impl_->stop_mutex);
    impl_->stopping = true;
  }
  impl_->stop_cv.notify_all();
  impl_->flusher.join();
  impl_->ws.stop();
}

void Server::attach(BT::Tree& tree) {
  std::unique_ptr<Impl::Logger> old;
  {
    std::lock_guard lock(impl_->state_mutex);
    Impl& impl = *impl_;
    impl.flushLocked();  // the old tree's last transitions
    impl.tree = &tree;
    impl.session++;
    json nodes = json::array();
    impl.nodes.clear();
    collectNodes(tree.rootNode(), nullptr, nodes, impl.nodes);
    impl.tree_msg = {
        {"op", "tree"},
        {"session", impl.session},
        {"tree_id", tree.subtrees.front()->tree_ID},
        {"nodes", std::move(nodes)},
        {"xml", BT::WriteTreeToXML(tree, false, false)},
    };
    old = std::move(impl.logger);
    impl.logger = std::make_unique<Impl::Logger>(tree.rootNode(), impl, impl.session);
    impl.broadcast(impl.tree_msg);
    impl.broadcast(impl.snapshotMsg());
  }
  // Destroyed outside the lock: it may still be finishing a callback on the ticking thread.
  old.reset();
}

void Server::detach() {
  std::unique_ptr<Impl::Logger> old;
  {
    std::lock_guard lock(impl_->state_mutex);
    impl_->flushLocked();
    impl_->tree = nullptr;
    impl_->nodes.clear();
    old = std::move(impl_->logger);
  }
  old.reset();
}

void Server::reportError(const std::string& message) {
  std::lock_guard lock(impl_->state_mutex);
  impl_->broadcast({{"op", "error"}, {"message", message}});
}

}  // namespace btlive
