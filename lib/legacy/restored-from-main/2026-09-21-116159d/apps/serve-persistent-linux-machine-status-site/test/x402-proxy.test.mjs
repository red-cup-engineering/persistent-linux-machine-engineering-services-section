import assert from "node:assert/strict";
import test from "node:test";
import { admitX402Routes, isX402Path, x402Route } from "../src/x402-proxy.mjs";
const routes = admitX402Routes({
    fixedRoutes: [
        {
            method: "POST",
            path: "/compute/inference",
            upstreamPath: "/inference",
            port: 4022
        },
        {
            method: "GET",
            path: "/.well-known/brokerage-products",
            upstreamPath: "/.well-known/brokerage-products",
            port: 4100
        }
    ],
    providerRoutes: {
        acme: 9000
    }
});
test("x402Route routes a fixed compute path to its configured upstream", ()=>{
    assert.deepEqual(x402Route("POST", "/compute/inference", routes), {
        port: 4022,
        upstreamPath: "/inference"
    });
});
test("x402Route routes a fixed brokerage path to its own configured port", ()=>{
    assert.deepEqual(x402Route("GET", "/.well-known/brokerage-products", routes), {
        port: 4100,
        upstreamPath: "/.well-known/brokerage-products"
    });
});
test("x402Route routes a per-provider metered path to its configured port", ()=>{
    assert.deepEqual(x402Route("POST", "/x402/acme/invoke", routes), {
        port: 9000,
        upstreamPath: "/x402/acme/invoke"
    });
    assert.deepEqual(x402Route("GET", "/x402/acme/offer", routes), {
        port: 9000,
        upstreamPath: "/x402/acme/offer"
    });
    const result = `/x402/acme/result/${"a".repeat(64).replace(/a/gu, "0")}`;
    assert.deepEqual(x402Route("GET", result, routes), {
        port: 9000,
        upstreamPath: result
    });
});
test("x402Route rejects a metered write path used with GET and a read path used with POST", ()=>{
    assert.throws(()=>x402Route("GET", "/x402/acme/invoke", routes), /outside the contracted metered ingress/u);
    assert.throws(()=>x402Route("POST", "/x402/acme/offer", routes), /outside the contracted metered ingress/u);
});
test("x402Route rejects a metered path for an unconfigured provider", ()=>{
    assert.throws(()=>x402Route("POST", "/x402/nope/invoke", routes), /outside the contracted metered ingress/u);
});
test("x402Route rejects a fixed path used with an uncontracted method", ()=>{
    assert.throws(()=>x402Route("GET", "/compute/inference", routes), /outside the contracted metered ingress/u);
});
test("x402Route rejects a path outside the contracted ingress", ()=>{
    assert.throws(()=>x402Route("GET", "/unrelated", routes), /outside the contracted metered ingress/u);
});
test("isX402Path admits exactly the configured surface", ()=>{
    assert.ok(isX402Path("/compute/inference", routes));
    assert.ok(isX402Path("/.well-known/brokerage-products", routes));
    assert.ok(isX402Path("/x402/acme/invoke", routes));
    assert.ok(!isX402Path("/compute/status", routes));
    assert.ok(!isX402Path("/unrelated", routes));
});
test("the metered path prefix is configurable", ()=>{
    const metered = admitX402Routes({
        providerRoutes: {
            acme: 9000
        },
        meteredPathPrefix: "/metered"
    });
    assert.deepEqual(x402Route("POST", "/metered/acme/invoke", metered), {
        port: 9000,
        upstreamPath: "/metered/acme/invoke"
    });
    assert.throws(()=>x402Route("POST", "/x402/acme/invoke", metered), /outside the contracted metered ingress/u);
});
test("admitX402Routes refuses a malformed table", ()=>{
    assert.throws(()=>admitX402Routes({
            fixedRoutes: {}
        }), /must be an array/u);
    assert.throws(()=>admitX402Routes({
            providerRoutes: {
                "Bad Provider": 1
            }
        }), /provider name is malformed/u);
    assert.throws(()=>admitX402Routes({
            providerRoutes: {
                acme: 0
            }
        }), /must name one TCP port/u);
    assert.throws(()=>admitX402Routes({
            meteredPathPrefix: "x402"
        }), /absolute path prefix/u);
});
test("an empty table admits nothing rather than defaulting to a port", ()=>{
    const empty = admitX402Routes({});
    assert.ok(!isX402Path("/compute/inference", empty));
    assert.throws(()=>x402Route("POST", "/compute/inference", empty), /outside the contracted metered ingress/u);
});
