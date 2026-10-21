export function statusSitePage(options: {
  localFace?: boolean;
  title: string;
  machineDisplayName: string;
  colonyActor?: string | null;
  noActivityNotice?: string;
}): string;

export function statusSiteDashboardFragment(options: {
  machineDisplayName: string;
  summary: string;
  swarmMessages?: boolean;
}): string;
