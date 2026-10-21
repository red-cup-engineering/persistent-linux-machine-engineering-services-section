function unavailable(type, reason, providerStatus) {
  return {
    status: 503,
    body: {
      type,
      reason,
      ...(providerStatus === undefined ? {} : { providerStatus }),
    },
  };
}

export async function readReportProvider({ providerUrl, unavailableType, fetchImpl = globalThis.fetch }) {
  if (!providerUrl) return unavailable(unavailableType, "no contracted report provider is configured");
  try {
    const response = await fetchImpl(providerUrl, { headers: { accept: "application/json" } });
    if (!response.ok) return unavailable(unavailableType, "the contracted report provider refused or is degraded", response.status);
    const body = await response.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return unavailable(unavailableType, "the contracted report provider returned a non-object artifact");
    }
    return { status: 200, body };
  } catch {
    return unavailable(unavailableType, "the contracted report provider could not be reached");
  }
}
