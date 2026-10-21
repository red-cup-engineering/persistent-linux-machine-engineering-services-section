function subjectsOf(composition, predicate, object) {
    return [
        ...new Set(composition.store.order.filter((cell)=>cell.predicate === predicate && cell.object === object).map((cell)=>cell.subject))
    ];
}
function valuesOf(composition, subject, predicate) {
    return composition.store.order.filter((cell)=>cell.subject === subject && cell.predicate === predicate).map((cell)=>cell.object);
}
function first(composition, subject, predicate) {
    return valuesOf(composition, subject, predicate)[0] ?? null;
}
function number(composition, subject, predicate) {
    const value = Number(first(composition, subject, predicate));
    return Number.isFinite(value) ? value : null;
}
function roleOrder(role) {
    return role === "agent" ? 0 : role === "script" ? 1 : 2;
}
export function projectMachineComposition(composition) {
    const machine = subjectsOf(composition, "urn:fars:type", "urn:fars:type:machine")[0] ?? null;
    const health = machine === null ? null : {
        nodeName: first(composition, machine, "urn:fars:node-name"),
        load: [
            number(composition, machine, "compute-load-1m"),
            number(composition, machine, "compute-load-5m"),
            number(composition, machine, "compute-load-15m")
        ],
        cpuCores: number(composition, machine, "cpu-core-count"),
        uptimeSeconds: number(composition, machine, "uptime-seconds"),
        memory: {
            freeBytes: number(composition, machine, "free-memory-bytes"),
            totalBytes: number(composition, machine, "total-memory-bytes")
        },
        swap: {
            freeBytes: number(composition, machine, "free-swap-bytes"),
            totalBytes: number(composition, machine, "total-swap-bytes")
        },
        storage: {
            freeBytes: number(composition, machine, "free-storage-bytes:/"),
            totalBytes: number(composition, machine, "total-storage-bytes:/")
        }
    };
    const processes = subjectsOf(composition, "urn:fars:type", "urn:fars:type:os-process").map((subject)=>({
            id: subject,
            pid: number(composition, subject, "os-pid"),
            parentPid: number(composition, subject, "os-parent-pid"),
            command: first(composition, subject, "os-command"),
            executable: first(composition, subject, "os-executable-name"),
            entrypoint: first(composition, subject, "os-entrypoint-name"),
            state: first(composition, subject, "os-process-state"),
            role: first(composition, subject, "process-role-hint"),
            residentMemoryBytes: number(composition, subject, "resident-memory-bytes"),
            threads: number(composition, subject, "os-thread-count")
        })).sort((left, right)=>roleOrder(left.role) - roleOrder(right.role) || (right.residentMemoryBytes ?? 0) - (left.residentMemoryBytes ?? 0));
    const units = subjectsOf(composition, "urn:fars:type", "urn:fars:type:systemd-unit").filter((subject)=>first(composition, subject, "urn:fars:unit-name")?.endsWith(".service")).map((subject)=>({
            id: subject,
            name: first(composition, subject, "urn:fars:unit-name"),
            active: first(composition, subject, "urn:fars:unit-active"),
            substate: first(composition, subject, "urn:fars:unit-substate"),
            description: first(composition, subject, "urn:fars:description")
        })).sort((left, right)=>String(left.name).localeCompare(String(right.name)));
    const timers = subjectsOf(composition, "urn:fars:type", "urn:fars:type:systemd-timer").map((subject)=>({
            id: subject,
            name: first(composition, subject, "urn:fars:unit-name"),
            activates: first(composition, subject, "urn:fars:timer-activates"),
            nextMicroseconds: number(composition, subject, "urn:fars:timer-next-microseconds")
        })).sort((left, right)=>String(left.name).localeCompare(String(right.name)));
    const activity = subjectsOf(composition, "urn:fars:type", "urn:fars:type:activity-event").map((subject)=>({
            id: subject,
            kind: first(composition, subject, "urn:fars:event-kind"),
            domain: first(composition, subject, "urn:fars:event-domain"),
            outcome: first(composition, subject, "urn:fars:event-outcome"),
            summary: first(composition, subject, "urn:fars:event-summary"),
            occurredAt: first(composition, subject, "urn:fars:occurred-at"),
            quantities: valuesOf(composition, subject, "urn:fars:has-quantity").map((quantity)=>({
                    label: first(composition, quantity, "urn:fars:quantity-label"),
                    amount: first(composition, quantity, "urn:fars:quantity-amount"),
                    unit: first(composition, quantity, "urn:fars:quantity-unit")
                }))
        })).sort((left, right)=>String(right.occurredAt).localeCompare(String(left.occurredAt)));
    return Object.freeze({
        type: "LinuxMachineFarsProjection",
        observedAt: composition.resources.map(({ observedAt })=>observedAt).sort().at(-1) ?? new Date().toISOString(),
        health,
        processes,
        units,
        timers,
        activity,
        providers: composition.providers,
        diagnostics: composition.diagnostics,
        graph: {
            resources: composition.resources.length,
            cells: composition.store.order.length
        }
    });
}
