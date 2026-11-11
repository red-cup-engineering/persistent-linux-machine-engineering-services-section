#!/bin/sh
# WSL bridges each process a Windows program starts inside it (wsl.exe) through a root "Relay".
# When that session dies first, the relay is left orphaned under init with no child, ignoring
# SIGTERM, still holding its vsock channels. Each channel pins a 512 KiB contiguous vmbus ring,
# so enough orphans leave no contiguous memory for a new channel, and every wsl.exe and interop
# call hangs. A live relay is named "Relay(<pid>)" under a SessionLeader and is never matched.
set -eu
min_age=${1:-600}
reaped=0
for pid in $(ps -eo pid=,ppid=,etimes=,comm= | awk -v age="$min_age" '$2 == 1 && $4 == "Relay" && $3 >= age { print $1 }'); do
  [ -z "$(ps --ppid "$pid" -o pid=)" ] || continue
  kill -KILL "$pid" 2>/dev/null && reaped=$((reaped + 1))
done
echo "reaped $reaped orphaned WSL relay(s)"

# Orphans are one cause; load is the other. Under agent load (installs, boot probes, tests) the
# 12 GB VM fragments until no order-7 block is free and a new channel cannot get its ring, with no
# orphan in sight (2026-10-03 19:52: interop at 7.7 s, ChatGPT desktop hung before its first log
# line). When fewer than $min_rings blocks of 512 KiB or larger are free, compact memory.
min_rings=${2:-64}
free_rings=$(awk '{ s = 0; for (i = 12; i <= NF; i++) s += $i * 2 ^ (i - 12); t += s } END { print t + 0 }' /proc/buddyinfo)
if [ "$free_rings" -lt "$min_rings" ]; then
  echo 1 > /proc/sys/vm/compact_memory
  echo "compacted memory: $free_rings free 512 KiB ring(s) before, $(awk '{ s = 0; for (i = 12; i <= NF; i++) s += $i * 2 ^ (i - 12); t += s } END { print t + 0 }' /proc/buddyinfo) after"
fi
