export type StatusSiteRuntimePulseParameters = {
  healthUrl: string;
  connectorMetricsUrl: string;
  providerActor: string;
  settlementActor: string;
  colonyActor: string;
};

export function collectStatusSiteRuntimeActivity(options: StatusSiteRuntimePulseParameters & {
  window: { fromExclusive: string; toInclusive: string };
  recordedAt: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>>;

export function statusSiteRuntimeActivityProvider(runtimePulse: StatusSiteRuntimePulseParameters): {
  name: string;
  collect: (request: { window: { fromExclusive: string; toInclusive: string }; recordedAt: string }) => Promise<Record<string, unknown>>;
};
