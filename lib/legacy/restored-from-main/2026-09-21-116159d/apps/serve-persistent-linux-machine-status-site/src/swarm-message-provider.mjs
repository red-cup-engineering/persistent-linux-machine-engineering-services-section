export function admittedSwarmMessageEndpoint(source) {
    if (typeof source !== "string" || source.length === 0) {
        throw new TypeError("a swarm message provider endpoint is required");
    }
    const endpoint = new URL(source);
    if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/messages" || endpoint.username || endpoint.password) {
        throw new TypeError("swarm message provider must be the loopback-only /messages service");
    }
    return endpoint;
}
function failed(reason) {
    return {
        type: "SwarmMessageResult",
        status: "failed",
        reason
    };
}
export async function submitSwarmMessage(message, options = {}) {
    if (typeof message !== "string" || message.trim() === "") return {
        status: 400,
        body: failed("message must contain plain user text")
    };
    if (new TextEncoder().encode(message).byteLength > 16_000) return {
        status: 413,
        body: failed("message exceeds the 16000-byte limit")
    };
    const endpoint = admittedSwarmMessageEndpoint(options.endpoint);
    try {
        const response = await (options.fetchImpl ?? fetch)(endpoint, {
            method: "POST",
            headers: {
                accept: "application/json",
                "content-type": "application/json"
            },
            body: JSON.stringify({
                message
            }),
            signal: AbortSignal.timeout(options.timeoutMs ?? 900_000)
        });
        const body = await response.json();
        if (body?.type !== "SwarmMessageResult" || ![
            "completed",
            "failed"
        ].includes(body.status)) {
            return {
                status: 502,
                body: failed("swarm provider returned an invalid result envelope")
            };
        }
        return {
            status: response.ok ? 200 : 502,
            body
        };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return {
            status: 502,
            body: failed(`swarm provider unavailable: ${reason}`)
        };
    }
}
