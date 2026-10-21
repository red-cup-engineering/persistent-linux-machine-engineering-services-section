import type { App } from "@red-cup-engineering/http-server";

export function isActivityPubPath(path: string): boolean;
export function admitActorRoutes(actorRoutes: Record<string, number | string>): Map<string, number | URL>;
export function providerTargetForUrl(url: URL, options: {
  routes: Map<string, number | URL>;
  colonyHost: string;
  nodeInfoProviderPort?: number | null;
  objectProviderPort?: number | null;
}): number | URL;
export function activityPubProxyApp(options: {
  actorRoutes: Record<string, number | string>;
  colonyHost: string;
  publicOrigin: string;
  nodeInfoProviderPort?: number | null;
  objectProviderPort?: number | null;
}): App;
