#include "StrictController.h"
#include <assert.h>
#include <iostream>

int main() {
  StrictController c; c.begin(0);
  assert(c.offer({1,true,10}, 0));
  c.tick(1999); assert(c.phase == Phase::Waiting);
  c.tick(2000); assert(c.phase == Phase::Green && c.deadline == 12000);
  assert(c.offer({2,false,20}, 3000));
  assert(!c.offer({1,true,180}, 4000)); assert(c.deadline == 12000);
  assert(!c.offer({2,false,180}, 5000)); assert(c.pending.redSeconds == 20);
  c.tick(11999); assert(c.phase == Phase::Green);
  c.tick(12000); assert(c.phase == Phase::Yellow && c.deadline == 15000);
  assert(c.offer({2,false,20}, 14000));
  c.tick(15000); assert(c.phase == Phase::Clearance && c.deadline == 17000);
  c.tick(17000); assert(c.phase == Phase::Waiting && c.completedId == 1);
  c.tick(17001); assert(c.phase == Phase::Green && c.active.id == 2 && c.deadline == 37001);
  c.networkFault(); assert(c.deadline == 37001);
  c.tick(37001); assert(c.phase == Phase::Yellow);
  c.tick(40001); c.tick(42001); c.tick(50000); assert(c.phase == Phase::Waiting);
  assert(!c.offer({1,true,10},50000)); // Replayed completed command cannot run.
  assert(!c.offer({3,false,10},50000)); // No same-direction extension.
  assert(c.offer({3,true,30},50000)); c.tick(56000); assert(c.phase == Phase::Waiting); // Stale queued command.
  assert(c.offer({3,true,30},56000)); c.tick(56001); assert(c.active.id == 3);
  c.tick(999999); assert(c.phase == Phase::Yellow && c.deadline == 1002999); // Late tick cannot skip clearance.
  StrictController rollover; rollover.begin(4294967290ULL); rollover.offer({1,true,10},4294967290ULL);
  rollover.tick(4294969290ULL); assert(rollover.remaining(4294969291ULL)==9999);
  std::cout << "PASS strict timing, pending immutability, duplicate/replay protection, clearance, offline behavior and long uptime\n";
}
