#pragma once
#include <stdint.h>

struct Command {
  Command(uint32_t number=0, bool redNS=true, uint32_t seconds=0) : id(number), redNorthSouth(redNS), redSeconds(seconds) {}
  uint32_t id = 0;
  bool redNorthSouth = true;
  uint32_t redSeconds = 0;
};
enum class Phase { Waiting, Green, Yellow, Clearance };

// This class never reads a server clock and has no operation that changes an
// active deadline. It is shared by ESP32 firmware and native timing tests.
class StrictController {
 public:
  Phase phase = Phase::Waiting;
  Command active, pending;
  uint32_t completedId = 0;
  uint64_t deadline = 0;
  void begin(uint64_t now) { readyAt = now + 2000; }
  bool offer(Command command, uint64_t now) {
    if (!command.id || command.redSeconds < 10 || command.redSeconds > 180 || command.id <= completedId || command.id == active.id) return false;
    if (pending.id) {
      if (pending.id != command.id || pending.redSeconds != command.redSeconds || pending.redNorthSouth != command.redNorthSouth) return false;
      receivedAt = now; return true; // Duplicate refreshes freshness, never timing.
    }
    if ((active.id && active.redNorthSouth == command.redNorthSouth) || (!active.id && hasLast && lastRedNorthSouth == command.redNorthSouth)) return false;
    pending = command; receivedAt = now; return true;
  }
  void networkFault() { pending = Command{}; }
  void tick(uint64_t now) {
    if (phase == Phase::Waiting) {
      if (pending.id && now - receivedAt > 5000) pending = Command{};
      if (pending.id && now >= readyAt) {
        active = pending; pending = Command{};
        phase = Phase::Green; deadline = now + uint64_t(active.redSeconds) * 1000;
      }
    } else if (now >= deadline) {
      if (phase == Phase::Green) { phase = Phase::Yellow; deadline = now + 3000; }
      else if (phase == Phase::Yellow) { phase = Phase::Clearance; deadline = now + 2000; }
      else {
        completedId = active.id; lastRedNorthSouth = active.redNorthSouth; hasLast = true;
        active = Command{}; phase = Phase::Waiting; readyAt = now;
      }
    }
  }
  uint32_t remaining(uint64_t now) const { return phase == Phase::Waiting || now >= deadline ? 0 : uint32_t(deadline - now); }
 private:
  uint64_t readyAt = 0, receivedAt = 0;
  bool hasLast = false, lastRedNorthSouth = true;
};
