// Runs examples/demo_project with simulated nodes and streams it with btlive::Server, so Arbor's live
// view can be tried against real BehaviorTree.CPP:
//
//   ./btlive_demo ../../examples/demo_project [port]
//
// Then press Connect in Arbor with ws://localhost:1670.

#include <btlive/server.hpp>

#include <behaviortree_cpp/bt_factory.h>

#include <algorithm>
#include <filesystem>
#include <iostream>
#include <random>

using namespace std::chrono_literals;

namespace {

// The simulated robot.
double battery = 60;
std::string location = "start";
std::mt19937 rng{42};

bool chance(double p) { return std::uniform_real_distribution<>(0, 1)(rng) < p; }

// An action that runs for `duration`, then calls `done` and succeeds.
class TimedAction : public BT::StatefulActionNode {
 public:
  TimedAction(const std::string& name, const BT::NodeConfig& config, std::chrono::milliseconds duration,
              std::function<BT::NodeStatus(TimedAction&)> done)
      : BT::StatefulActionNode(name, config), duration_(duration), done_(std::move(done)) {}

  BT::NodeStatus onStart() override {
    until_ = std::chrono::steady_clock::now() + duration_;
    return BT::NodeStatus::RUNNING;
  }
  BT::NodeStatus onRunning() override {
    if (std::chrono::steady_clock::now() < until_) return BT::NodeStatus::RUNNING;
    return done_ ? done_(*this) : BT::NodeStatus::SUCCESS;
  }
  void onHalted() override {}

 private:
  std::chrono::milliseconds duration_;
  std::function<BT::NodeStatus(TimedAction&)> done_;
  std::chrono::steady_clock::time_point until_;
};

template <typename F>
void registerTimed(BT::BehaviorTreeFactory& factory, const std::string& id, std::chrono::milliseconds duration,
                   BT::PortsList ports, F done) {
  BT::TreeNodeManifest manifest{BT::NodeType::ACTION, id, std::move(ports), {}};
  factory.registerBuilder(manifest, [duration, done](const std::string& name, const BT::NodeConfig& config) {
    return std::make_unique<TimedAction>(name, config, duration, done);
  });
}

void registerNodes(BT::BehaviorTreeFactory& factory) {
  factory.registerSimpleCondition(
      "IsBatteryOk",
      [](BT::TreeNode& node) {
        return battery > node.getInput<double>("min_percent").value_or(20) ? BT::NodeStatus::SUCCESS : BT::NodeStatus::FAILURE;
      },
      {BT::InputPort<double>("min_percent", 20, "")});
  factory.registerSimpleCondition(
      "IsAtLocation",
      [](BT::TreeNode& node) {
        return node.getInput<std::string>("location").value_or("") == location ? BT::NodeStatus::SUCCESS : BT::NodeStatus::FAILURE;
      },
      {BT::InputPort<std::string>("location"), BT::InputPort<double>("tolerance", 0.1, "")});
  factory.registerSimpleAction(
      "DetectObject",
      [](BT::TreeNode& node) {
        if (!chance(0.5)) return BT::NodeStatus::FAILURE;
        node.setOutput("pose", std::string("x=1.2 y=-0.4 near ") + location);
        return BT::NodeStatus::SUCCESS;
      },
      {BT::InputPort<std::string>("object_type"), BT::OutputPort<std::string>("pose")});
  factory.registerSimpleAction(
      "Say",
      [](BT::TreeNode& node) {
        std::cout << "robot says: " << node.getInput<std::string>("message").value_or("") << "\n";
        return BT::NodeStatus::SUCCESS;
      },
      {BT::InputPort<std::string>("message")});

  registerTimed(factory, "MoveTo", 1500ms, {BT::InputPort<std::string>("location"), BT::InputPort<double>("speed", 0.5, "")},
                [](TimedAction& node) {
                  location = node.getInput<std::string>("location").value_or("");
                  return BT::NodeStatus::SUCCESS;
                });
  registerTimed(factory, "Pick", 800ms, {BT::InputPort<std::string>("pose")},
                [](TimedAction&) { return chance(0.7) ? BT::NodeStatus::SUCCESS : BT::NodeStatus::FAILURE; });
  registerTimed(factory, "Place", 800ms, {BT::InputPort<std::string>("location")}, nullptr);
  registerTimed(factory, "Dock", 1000ms, {}, nullptr);
  // Untyped: the demo passes it a SubTree port that BT.CPP may have typed from a literal (int).
  registerTimed(factory, "ChargeUntil", 2000ms, {BT::InputPort("percent")}, [](TimedAction& node) {
    battery = node.getInput<double>("percent").value_or(90);
    return BT::NodeStatus::SUCCESS;
  });
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 2) {
    std::cerr << "Usage: btlive_demo <project dir> [port]\n";
    return 1;
  }
  BT::BehaviorTreeFactory factory;
  registerNodes(factory);
  for (const auto& file : std::filesystem::recursive_directory_iterator(std::filesystem::path(argv[1]) / "trees")) {
    if (file.path().extension() == ".xml") factory.registerBehaviorTreeFromFile(file.path());
  }

  btlive::Options options;
  options.port = argc > 2 ? std::stoi(argv[2]) : 1670;
  options.robot_name = "btlive-demo";
  btlive::Server live(options);

  std::cout << "btlive-demo: ticking MainTree on ws://localhost:" << options.port << "\n";
  while (true) {
    // A fresh tree per run, like an application that reloads its mission: each one is a new session.
    auto tree = factory.createTree("MainTree");
    live.attach(tree);
    BT::NodeStatus status = BT::NodeStatus::RUNNING;
    while (status == BT::NodeStatus::RUNNING) {
      try {
        status = tree.tickOnce();
      } catch (const std::exception& e) {
        live.reportError(e.what());
        status = BT::NodeStatus::FAILURE;
      }
      battery = std::max(0.0, battery - 0.3);
      tree.sleep(100ms);
    }
    std::cout << "MainTree finished: " << BT::toStr(status) << "\n";
    live.detach();
    std::this_thread::sleep_for(1s);
  }
}
