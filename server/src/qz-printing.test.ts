import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getQzSigningCredentials, signQzRequest } from "./qz-printing.js";

describe("QZ Tray signing", () => {
  it("only exposes signing material when both base64-encoded values are valid PEM", () => {
    expect(getQzSigningCredentials({})).toBeUndefined();
    expect(getQzSigningCredentials({
      QZ_CERTIFICATE_BASE64: Buffer.from("not a certificate").toString("base64"),
      QZ_PRIVATE_KEY_BASE64: Buffer.from("not a private key").toString("base64"),
    })).toBeUndefined();
  });

  it("decodes the certificate and matching private-key environment values", () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const certificate = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----";
    expect(getQzSigningCredentials({
      QZ_CERTIFICATE_BASE64: Buffer.from(certificate).toString("base64"),
      QZ_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString("base64"),
    })).toEqual({ certificate, privateKey: privateKey.trim() });
  });

  it("signs each QZ request using RSA-SHA512 and returns a base64 signature", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const request = '{"call":"print","params":[]}';
    const signature = signQzRequest(request, privateKey);
    const verifier = createVerify("RSA-SHA512");
    verifier.update(request, "utf8");
    verifier.end();

    expect(verifier.verify(publicKey, signature, "base64")).toBe(true);
  });
});
