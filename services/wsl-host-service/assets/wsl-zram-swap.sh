#!/bin/sh
# WSL-21: creates the in-memory compressed swap device and turns it on above every disk swap.
#   wsl-zram-swap <disksize> <mem-limit> <algorithm> <priority>
# disksize bounds the uncompressed bytes it accepts; mem-limit bounds the RAM its compressed pool may take.
# Idempotent: an active device is left as it is (resizing needs swapoff and a reset, which this never does).
set -eu
size=$1; limit=$2; alg=$3; prio=$4
dev=/sys/block/zram0
if grep -q '^/dev/zram0[[:space:]]' /proc/swaps; then echo "zram0 already active"; exit 0; fi
[ -e $dev ] || modprobe zram num_devices=1
if [ "$(cat $dev/disksize)" = 0 ]; then
  echo "$alg" > $dev/comp_algorithm
  echo "$size" > $dev/disksize
fi
echo "$limit" > $dev/mem_limit
mkswap /dev/zram0 >/dev/null
swapon -p "$prio" /dev/zram0
echo "zram0: disksize=$(cat $dev/disksize) mem_limit=$(cat $dev/mem_limit) algorithm=$alg priority=$prio"
