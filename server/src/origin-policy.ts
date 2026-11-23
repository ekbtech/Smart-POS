export function isAllowedClientOrigin(
  origin: string | undefined,
  configuredOrigins: string[],
  allowDevelopmentPorts: boolean,
): boolean {
  if (!origin || configuredOrigins.includes(origin)) return true;
  let requestUrl: URL;
  try {
    requestUrl = new URL(origin);
  } catch {
    return false;
  }

  const isDevelopmentPort = Number(requestUrl.port) >= 5173;
  if (allowDevelopmentPorts && isDevelopmentPort
    && (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1")) {
    return true;
  }

  if (!allowDevelopmentPorts || !isDevelopmentPort) return false;
  return configuredOrigins.some((configuredOrigin) => {
    try {
      const configuredUrl = new URL(configuredOrigin);
      return configuredUrl.protocol === requestUrl.protocol
        && configuredUrl.hostname === requestUrl.hostname;
    } catch {
      return false;
    }
  });
}
