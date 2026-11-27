import { createSign } from "node:crypto";

export type QzSigningCredentials = { certificate: string; privateKey: string };

function decodeBase64EnvironmentValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const decoded = Buffer.from(value, "base64").toString("utf8").trim();
  return decoded || undefined;
}

export function getQzSigningCredentials(
  env: NodeJS.ProcessEnv = process.env,
): QzSigningCredentials | undefined {
  const certificate = decodeBase64EnvironmentValue(env.QZ_CERTIFICATE_BASE64);
  const privateKey = decodeBase64EnvironmentValue(env.QZ_PRIVATE_KEY_BASE64);
  if (!certificate?.includes("-----BEGIN CERTIFICATE-----")
    || !certificate.includes("-----END CERTIFICATE-----")
    || !privateKey
    || !/-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(privateKey)) {
    return undefined;
  }
  return { certificate, privateKey };
}

export function signQzRequest(request: string, privateKey: string): string {
  const signer = createSign("RSA-SHA512");
  signer.update(request, "utf8");
  signer.end();
  return signer.sign(privateKey, "base64");
}
