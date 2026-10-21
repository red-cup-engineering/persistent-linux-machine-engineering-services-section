declare module "@red-cup-engineering/systemd-unit-inventory-observation-service" {
  export function observeUnitInventory(scope: string): {
    host: string;
    units: readonly Record<string, unknown>[];
    timers: readonly Record<string, unknown>[];
  };
}

declare module "@red-cup-engineering/session-activity-provider-service/collect-colony-activity" {
  export function collectColonyActivity(dialect: unknown, options: {
    window: { fromExclusive: string; toInclusive: string };
    recordedAt: string;
    sessionRoot?: string;
  }): Promise<Record<string, unknown>>;
}

declare module "@red-cup-engineering/session-transcript-dialects/claude-dialect" {
  export const claudeSessionTranscriptDialect: unknown;
}

declare module "@red-cup-engineering/session-transcript-dialects/codex-dialect" {
  export const codexSessionTranscriptDialect: unknown;
}
