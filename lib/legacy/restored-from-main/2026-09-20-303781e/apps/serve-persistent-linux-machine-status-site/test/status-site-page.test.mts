import assert from "node:assert/strict";
import test from "node:test";
import { statusSitePage, statusSiteDashboardFragment } from "../src/status-site-page.mjs";

const page = { title: "quiet-oak-hill", machineDisplayName: "Quiet Oak Hill", colonyActor: "urn:ame:quiet-oak-hill-colony", noActivityNotice: "No codex or claude activity in the last hour." };

test("the machine-local shell bootstraps without remote OAuth while a relay shell does not", () => {
  assert.match(statusSitePage({ ...page, localFace: true }), /const localFace=true/u);
  assert.match(statusSitePage({ ...page, localFace: false }), /const localFace=false/u);
});

test("the public document carries the configured names and no privileged observation", () => {
  const html = statusSitePage({ ...page, localFace: false });
  assert.match(html, /<title>quiet-oak-hill<\/title>/u);
  assert.match(html, /machineDisplayName="Quiet Oak Hill"/u);
  assert.match(html, /defaultColonyActor="urn:ame:quiet-oak-hill-colony"/u);
  // The gate document carries the login shell and the generic rendering
  // program, but no dashboard markup and no machine observation: those bytes
  // arrive only through the guarded fragment route.
  assert.ok(!html.includes("<h1>"));
  assert.ok(!html.includes("swarm-form"));
  assert.ok(!html.includes("Ask the swarm"));
  assert.match(html, /<div id="app"><\/div>/u);
});

test("a title carrying HTML is escaped rather than interpolated", () => {
  const html = statusSitePage({ ...page, title: "<script>alert(1)</script>" });
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
});

test("the guarded fragment carries the configured machine name and summary", () => {
  const fragment = statusSiteDashboardFragment({ machineDisplayName: "Quiet Oak Hill", summary: "Status dashboard for the quiet-oak-hill host.", swarmMessages: true });
  assert.match(fragment, /<h1>Quiet Oak Hill<\/h1>/u);
  assert.match(fragment, /Status dashboard for the quiet-oak-hill host\./u);
  assert.match(fragment, /machine-processes/u);
});

test("the authenticated swarm operation appears only when the machine contracts one", () => {
  const withOperation = statusSiteDashboardFragment({ machineDisplayName: "m", summary: "s", swarmMessages: true });
  const withoutOperation = statusSiteDashboardFragment({ machineDisplayName: "m", summary: "s", swarmMessages: false });
  assert.match(withOperation, /data-endpoint="\/api\/swarm\/messages"/u);
  assert.ok(!withoutOperation.includes("/api/swarm/messages"));
  assert.match(withoutOperation, /machine-health/u);
});

test("a summary carrying HTML is escaped rather than interpolated", () => {
  const fragment = statusSiteDashboardFragment({ machineDisplayName: "<b>m</b>", summary: "<i>s</i>" });
  assert.ok(!fragment.includes("<b>m</b>"));
  assert.match(fragment, /&lt;i&gt;s&lt;\/i&gt;/u);
});
