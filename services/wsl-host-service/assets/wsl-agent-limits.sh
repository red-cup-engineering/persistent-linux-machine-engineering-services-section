#!/bin/sh
# Applies /etc/default/wsl-agent-limits to /sys/fs/cgroup/non-systemd.
set -eu
. /etc/default/wsl-agent-limits
cg=/sys/fs/cgroup/non-systemd
# The path unit can fire before systemd enables cpu for the root's children (2026-10-25: cpu.weight absent, cpu and io ceilings unset).
for c in cpu io memory pids; do grep -qw $c /sys/fs/cgroup/cgroup.subtree_control || echo +$c > /sys/fs/cgroup/cgroup.subtree_control; done
echo "$MEMORY_HIGH" > $cg/memory.high
echo "$MEMORY_MAX"  > $cg/memory.max
echo "$SWAP_MAX"    > $cg/memory.swap.max
echo "$PIDS_MAX"    > $cg/pids.max
echo "$CPU_WEIGHT"  > $cg/cpu.weight
dev() { lsblk -dno MAJ:MIN "$1" 2>/dev/null | tr -d ' '; }
# WSL-23: bound only the disk swap; an in-memory (zram) device has no disk traffic to bound.
root=$(dev "$(findmnt -no SOURCE /)"); swap=$(dev "$(swapon --show=NAME --noheadings | grep -v zram | head -1)")
[ -n "$root" ] && echo "$root $IO_MAX_ROOT" > $cg/io.max
[ -n "$swap" ] && echo "$swap $IO_MAX_SWAP" > $cg/io.max
echo "non-systemd: high=$(cat $cg/memory.high) max=$(cat $cg/memory.max) swap=$(cat $cg/memory.swap.max) pids=$(cat $cg/pids.max) io=[$(tr '\n' ';' < $cg/io.max)]"
