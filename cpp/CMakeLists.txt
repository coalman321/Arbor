# btlive: reference btlive server (docs/live_protocol.md) for BehaviorTree.CPP 4.x.
#
#   cmake -S cpp -B build/cpp -DBTLIVE_FETCH_DEPS=ON && cmake --build build/cpp
#
# Without BTLIVE_FETCH_DEPS, BehaviorTree.CPP and IXWebSocket must already be installed (find_package).

cmake_minimum_required(VERSION 3.16)
project(btlive LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(BTLIVE_FETCH_DEPS "Download and build BehaviorTree.CPP and IXWebSocket" OFF)
option(BTLIVE_BUILD_DEMO "Build btlive_demo, which runs examples/demo_project" ON)

if(BTLIVE_FETCH_DEPS)
  include(FetchContent)
  set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
  set(BTCPP_GROOT_INTERFACE OFF CACHE BOOL "" FORCE)
  set(BTCPP_SQLITE_LOGGING OFF CACHE BOOL "" FORCE)
  set(BTCPP_EXAMPLES OFF CACHE BOOL "" FORCE)
  set(BTCPP_UNIT_TESTS OFF CACHE BOOL "" FORCE)
  set(USE_TLS OFF CACHE BOOL "" FORCE)
  set(USE_ZLIB OFF CACHE BOOL "" FORCE)
  FetchContent_Declare(behaviortree_cpp
    GIT_REPOSITORY https://github.com/BehaviorTree/BehaviorTree.CPP.git
    GIT_TAG 4.10.0
    GIT_SHALLOW ON)
  FetchContent_Declare(ixwebsocket
    GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
    GIT_TAG v11.4.6
    GIT_SHALLOW ON)
  FetchContent_MakeAvailable(behaviortree_cpp ixwebsocket)
  set(BTLIVE_BT_TARGET behaviortree_cpp)
  set(BTLIVE_IX_TARGET ixwebsocket)
else()
  find_package(behaviortree_cpp REQUIRED)
  find_package(ixwebsocket REQUIRED)
  set(BTLIVE_BT_TARGET BT::behaviortree_cpp)
  set(BTLIVE_IX_TARGET ixwebsocket::ixwebsocket)
endif()

add_library(btlive src/server.cpp)
target_include_directories(btlive PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(btlive PUBLIC ${BTLIVE_BT_TARGET} PRIVATE ${BTLIVE_IX_TARGET})

if(BTLIVE_BUILD_DEMO)
  add_executable(btlive_demo examples/demo_robot.cpp)
  target_link_libraries(btlive_demo PRIVATE btlive)
endif()
