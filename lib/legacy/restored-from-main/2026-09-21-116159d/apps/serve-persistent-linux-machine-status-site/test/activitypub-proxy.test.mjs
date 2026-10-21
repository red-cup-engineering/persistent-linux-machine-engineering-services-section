import assert from "node:assert/strict";
import test from "node:test";
import { admitActorRoutes, isActivityPubPath, providerTargetForUrl } from "../src/activitypub-proxy.mjs";
const colonyHost = "quiet-oak-hill.example";
test("isActivityPubPath matches actor, inbox, and well-known paths", ()=>{
    assert.ok(isActivityPubPath("/actors/example"));
    assert.ok(isActivityPubPath("/actors/example/inbox"));
    assert.ok(isActivityPubPath("/inbox"));
    assert.ok(isActivityPubPath("/.well-known/webfinger"));
    assert.ok(!isActivityPubPath("/actors/example/extra/segments"));
    assert.ok(!isActivityPubPath("/unrelated"));
});
test("admitActorRoutes admits a loopback port binding and a remote HTTPS origin", ()=>{
    const routes = admitActorRoutes({
        codex: 8794,
        remote: "https://example.com"
    });
    assert.equal(routes.get("codex"), 8794);
    assert.equal(routes.get("remote").hostname, "example.com");
});
test("admitActorRoutes refuses a credentialed or path-bearing origin, a bad port, and a non-object", ()=>{
    assert.throws(()=>admitActorRoutes({
            bad: "https://user:pass@example.com/path"
        }), /without credentials, path/u);
    assert.throws(()=>admitActorRoutes({
            bad: 0
        }), /must name a TCP port/u);
    assert.throws(()=>admitActorRoutes({
            "Bad Actor": 8794
        }), /actor name is malformed/u);
    assert.throws(()=>admitActorRoutes(null), /must be an object/u);
});
test("an empty route table is admitted: a machine may contract no actor yet", ()=>{
    assert.equal(admitActorRoutes({}).size, 0);
});
test("providerTargetForUrl routes an actor path to its configured provider", ()=>{
    const routes = admitActorRoutes({
        codex: 8794
    });
    assert.equal(providerTargetForUrl(new URL(`https://${colonyHost}/actors/codex`), {
        routes,
        colonyHost,
        nodeInfoProviderPort: 8794
    }), 8794);
});
test("providerTargetForUrl routes a WebFinger resource to the named actor's provider", ()=>{
    const routes = admitActorRoutes({
        codex: 8794
    });
    const url = new URL(`https://${colonyHost}/.well-known/webfinger?resource=acct:codex@${colonyHost}`);
    assert.equal(providerTargetForUrl(url, {
        routes,
        colonyHost
    }), 8794);
    const foreign = new URL(`https://${colonyHost}/.well-known/webfinger?resource=acct:codex@elsewhere.example`);
    assert.throws(()=>providerTargetForUrl(foreign, {
            routes,
            colonyHost
        }), /no contracted ActivityPub actor/u);
});
test("providerTargetForUrl routes node information only when a provider is contracted", ()=>{
    const routes = admitActorRoutes({});
    assert.equal(providerTargetForUrl(new URL(`https://${colonyHost}/nodeinfo/2.1`), {
        routes,
        colonyHost,
        nodeInfoProviderPort: 8794
    }), 8794);
    assert.throws(()=>providerTargetForUrl(new URL(`https://${colonyHost}/nodeinfo/2.1`), {
            routes,
            colonyHost
        }), /no ActivityPub node-information provider/u);
});
test("providerTargetForUrl routes an activity object only when an object provider is contracted", ()=>{
    const routes = admitActorRoutes({});
    assert.equal(providerTargetForUrl(new URL(`https://${colonyHost}/activities/a/b/c`), {
        routes,
        colonyHost,
        objectProviderPort: 8795
    }), 8795);
    assert.throws(()=>providerTargetForUrl(new URL(`https://${colonyHost}/activities/a/b/c`), {
            routes,
            colonyHost
        }), /no ActivityPub object provider/u);
});
test("providerTargetForUrl rejects a URL outside the configured colony host", ()=>{
    const routes = admitActorRoutes({
        codex: 8794
    });
    assert.throws(()=>providerTargetForUrl(new URL("https://elsewhere.example/actors/codex"), {
            routes,
            colonyHost
        }), /outside the quiet-oak-hill.example colony territory/u);
});
test("providerTargetForUrl rejects an actor with no contracted provider", ()=>{
    const routes = admitActorRoutes({});
    assert.throws(()=>providerTargetForUrl(new URL(`https://${colonyHost}/actors/unknown`), {
            routes,
            colonyHost
        }), /no ActivityPub provider is contracted for actor unknown/u);
});
test("providerTargetForUrl requires a colony host to be configured at all", ()=>{
    assert.throws(()=>providerTargetForUrl(new URL("https://any.example/actors/codex"), {
            routes: admitActorRoutes({}),
            colonyHost: ""
        }), /colony host is required/u);
});
