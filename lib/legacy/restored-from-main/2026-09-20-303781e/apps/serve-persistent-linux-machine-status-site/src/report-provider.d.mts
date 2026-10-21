export function readReportProvider(options: {
  providerUrl?: string | null;
  unavailableType: string;
  fetchImpl?: typeof fetch;
}): Promise<{ status: number; body: Record<string, unknown> }>;
