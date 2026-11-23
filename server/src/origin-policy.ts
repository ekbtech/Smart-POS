export function isAllowedClientOrigin(origin: string | undefined, configuredOrigins: string[]): boolean {
  if (!origin || configuredOrigins.includes(origin)) return true;
  let requestUrl: URL;
  try {
    requestUrl = new URL(origin);
  } catch {
    return false;
  }

  if ((requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1")
    && /^\d+$/.test(requestUrl.port)) {
    return true;
  }

  return configuredOrigins.some((configuredOrigin) => {
    try {
      const configuredUrl = new URL(configuredOrigin);
      if (configuredUrl.port !== "5173") return false;
      configuredUrl.port = "5174";
      return configuredUrl.origin === requestUrl.origin;
    } catch {
      return false;
    }
  });
}
