export type MachineStatusSiteConfiguration = {
  readonly type: "PersistentLinuxMachineStatusSite";
  readonly machine: { readonly nodeName: string; readonly displayName: string; readonly systemdScope: string };
  readonly site: { readonly title: string; readonly summary: string; readonly publicOrigin: string };
  readonly faces: {
    readonly mutable: { readonly host: string; readonly port: number };
    readonly readOnly: readonly { readonly host: string; readonly port: number; readonly transport: string }[];
  };
  readonly oauth: {
    readonly allowedEmails: readonly string[];
    readonly stateDir: string;
    readonly clientConfigPath: string | null;
    readonly realm: string;
  };
  readonly activityProviders: readonly string[];
  readonly agentCard: { readonly path: string; readonly actorName: string } | null;
  readonly peer: { readonly label: string; readonly statusUrl: string } | null;
  readonly reportProviders: { readonly colonyUrl: string | null; readonly unionUrl: string | null };
  readonly swarmMessages: { readonly endpoint: string } | null;
  readonly runtimePulse: {
    readonly healthUrl: string;
    readonly connectorMetricsUrl: string;
    readonly providerActor: string;
    readonly settlementActor: string;
    readonly colonyActor: string;
  } | null;
  readonly activityPub: {
    readonly colonyHost: string;
    readonly publicOrigin: string;
    readonly actorRoutes: Record<string, number | string>;
    readonly nodeInfoProviderPort: number | null;
    readonly objectProviderPort: number | null;
  } | null;
  readonly x402: {
    readonly fixedRoutes: readonly { readonly method: string; readonly path: string; readonly upstreamPath: string; readonly port: number }[];
    readonly providerRoutes: Record<string, number>;
    readonly meteredPathPrefix: string;
  } | null;
};

export const MACHINE_STATUS_SITE_CONFIGURATION_TYPE: "PersistentLinuxMachineStatusSite";
export const CONFIGURATION_PATH_ENVIRONMENT_VARIABLE: "MACHINE_STATUS_SITE_CONFIG";
export const SESSION_ACTIVITY_DIALECT_NAMES: readonly string[];
export function admitMachineStatusSiteConfiguration(value: unknown): MachineStatusSiteConfiguration;
export function readMachineStatusSiteConfiguration(path: string): MachineStatusSiteConfiguration;
export function machineStatusSiteConfigurationPath(argv?: readonly string[], environment?: Record<string, string | undefined>): string;
export function readOAuthClientEnvironment(configuration: MachineStatusSiteConfiguration, environment?: Record<string, string | undefined>): Record<string, string | undefined>;
