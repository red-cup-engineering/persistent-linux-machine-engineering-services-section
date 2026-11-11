#!/bin/sh
# Keeps order-7 (512 KiB) contiguous blocks free for WSL's hv_sock rings.
# Every new Windows<->Linux channel (each wsl.exe or interop launch, each VS Code or Codex spawn)
# allocates its vmbus ring as one order-7 block. Under agent load memory fragments until none is
# free: hvs_probe fails ("page allocation failure: order:7"), UtilAcceptVsock times out, and
# Windows powers the VM off. Proactive compaction alone did not prevent this on 2026-10-09.
# This watcher compacts on demand when the free count falls below the floor, and drops clean
# page cache as a second step when compaction alone does not restore it.
#
#   wsl-hvsock-headroom-guard <min-order7-blocks> <interval-seconds> <drop-caches:yes|no> [<max-cache-mib> <min-seconds-between-cache-drops> [<reclaim-cgroups>]]
#
# WSL-20: with a page-cache ceiling, it also drops clean page cache whenever the cache exceeds the ceiling
# (at most once per the minimum gap). A busy VM never goes idle for WSL's autoMemoryReclaim, and its cache
# otherwise pins Windows memory; free-page reporting hands the freed pages back to Windows.
# WSL-22: <reclaim-cgroups> is a colon-separated list of cgroups under /sys/fs/cgroup. The excess is taken from
# each in turn through memory.reclaim, which evicts that cgroup's coldest pages, before the guard falls back to
# dropping all clean cache, which also evicts the hot executables of interactive programs.
set -u
min=${1:-32}; interval=${2:-5}; drop=${3:-yes}; maxcache=${4:-0}; gap=${5:-60}; reclaim=${6:-}; lastcache=0
cachedmib() { awk '/^Cached:/ { print int($2 / 1024) }' /proc/meminfo; }

# Free blocks able to hold an order-7 allocation, counted in order-7 units, over all zones.
free7() {
  awk '{ s = 0; for (o = 7; o <= 10; o++) { c = $(o + 5); if (c != "") s += c * 2 ^ (o - 7) } t += s } END { print t + 0 }' /proc/buddyinfo
}

while :; do
  before=$(free7)
  if [ "$before" -lt "$min" ]; then
    echo 1 > /proc/sys/vm/compact_memory
    after=$(free7)
    if [ "$after" -lt "$min" ] && [ "$drop" = yes ]; then
      sync
      echo 1 > /proc/sys/vm/drop_caches
      echo 1 > /proc/sys/vm/compact_memory
      final=$(free7)
      echo "order-7 free ${before} < ${min}: compacted to ${after}; dropped clean page cache and compacted to ${final}"
    else
      echo "order-7 free ${before} < ${min}: compacted to ${after}"
    fi
  fi
  if [ "$maxcache" -gt 0 ]; then
    cached=$(cachedmib)
    now=$(date +%s)
    if [ "$cached" -gt "$maxcache" ] && [ $((now - lastcache)) -ge "$gap" ]; then
      start=$cached; took=""
      for cg in $(echo "$reclaim" | tr ':' ' '); do
        [ "$cached" -gt "$maxcache" ] || break
        f=/sys/fs/cgroup/$cg/memory.reclaim
        [ -w "$f" ] || continue
        # A partial reclaim returns EAGAIN; the re-read below decides what happens next.
        echo "$(( (cached - maxcache) * 1048576 )) swappiness=0" > "$f" 2>/dev/null || :
        cached=$(cachedmib); took="$took $cg"
      done
      if [ "$cached" -gt "$maxcache" ]; then
        sync
        echo 1 > /proc/sys/vm/drop_caches
        echo "page cache ${start} MiB > ${maxcache} MiB: reclaimed from${took:- nothing} to ${cached} MiB; dropped clean cache to $(cachedmib) MiB"
      else
        echo "page cache ${start} MiB > ${maxcache} MiB: reclaimed from${took} to ${cached} MiB"
      fi
      lastcache=$now
    fi
  fi
  sleep "$interval"
done
