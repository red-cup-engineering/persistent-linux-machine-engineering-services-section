import type { App } from "@red-cup-engineering/http-server";

export type X402Routes = {
  fixed: Map<string, { port: number; upstreamPath: string }>;
  providers: Map<string, number>;
  meteredPath: RegExp;
  meteredOperation: RegExp;
};

export function admitX402Routes(options: {
  fixedRoutes?: readonly { method: string; path: string; upstreamPath: string; port: number }[];
  providerRoutes?: Record<string, number>;
  meteredPathPrefix?: string;
}): X402Routes;
export function x402Route(method: string, pathname: string, routes: X402Routes): { port: number; upstreamPath: string };
export function isX402Path(path: string, routes: X402Routes): boolean;
export function x402ProxyApp(options: { routes: X402Routes; publicOrigin: string }): App;
