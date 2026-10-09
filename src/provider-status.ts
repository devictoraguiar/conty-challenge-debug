export function mapProviderStatus(
  providerStatus: string,
): "paid" | "pending" | "failed" | "unknown" {
  switch (providerStatus) {
    case "RECEIVED":
    case "CONFIRMED":
      return "paid";
    case "PENDING":
      return "pending";
    case "FAILED":
      return "failed";
    default:
      return "unknown";
  }
}
