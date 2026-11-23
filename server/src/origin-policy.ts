function isPrivateIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split(".").map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first === 10
    || (first === 172 && second !== undefined && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

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
    && (requestUrl.hostname === "localhost"
      || requestUrl.hostname === "127.0.0.1"
      || isPrivateIpv4(requestUrl.hostname))) {
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
