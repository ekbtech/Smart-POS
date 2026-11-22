import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMpesaAvailability, mpesaCallbackSchema, mpesaPaymentRequestSchema, normalizeKenyanPhone,
} from "./mpesa.js";

afterEach(() => vi.unstubAllEnvs());

describe("M-Pesa payment validation", () => {
  it("normalizes the supported Kenyan mobile number formats", () => {
    expect(normalizeKenyanPhone("0712345678")).toBe("254712345678");
    expect(normalizeKenyanPhone("254712345678")).toBe("254712345678");
    expect(normalizeKenyanPhone("0112345678")).toBeNull();
    expect(normalizeKenyanPhone("+254712345678")).toBeNull();
  });

  it("requires a valid Kenyan phone and unique product lines", () => {
    const request = {
      items: [{ productId: 3, quantity: "1.25" }],
      discount: "0.00",
      phone: "0712345678",
      description: "Retail sale",
    };
    expect(mpesaPaymentRequestSchema.safeParse(request).success).toBe(true);
    expect(mpesaPaymentRequestSchema.safeParse({ ...request, phone: "12345" }).success).toBe(false);
    expect(mpesaPaymentRequestSchema.safeParse({
      ...request,
      items: [...request.items, { productId: 3, quantity: "1" }],
    }).success).toBe(false);
  });

  it("reports Daraja available only with server credentials and a public HTTPS callback", () => {
    vi.stubEnv("MPESA_ENVIRONMENT", "sandbox");
    vi.stubEnv("MPESA_CONSUMER_KEY", "test-key");
    vi.stubEnv("MPESA_CONSUMER_SECRET", "test-secret");
    vi.stubEnv("MPESA_SHORTCODE", "123456");
    vi.stubEnv("MPESA_PASSKEY", "test-passkey");
    vi.stubEnv("MPESA_CALLBACK_URL", "http://localhost/api/mpesa/callback");
    expect(getMpesaAvailability().configured).toBe(false);

    vi.stubEnv("MPESA_CALLBACK_URL", "https://192.168.1.20/api/mpesa/callback");
    expect(getMpesaAvailability().configured).toBe(false);
    vi.stubEnv("MPESA_CALLBACK_URL", "https://api.local/api/mpesa/callback");
    expect(getMpesaAvailability().configured).toBe(false);

    vi.stubEnv("MPESA_CALLBACK_URL", "https://api.example.com/api/mpesa/callback");
    expect(getMpesaAvailability()).toEqual({
      configured: true,
      reason: null,
      requiresWholeShillings: true,
    });
  });

  it("accepts Daraja STK callbacks with result metadata and rejects malformed result codes", () => {
    const callback = {
      Body: {
        stkCallback: {
          MerchantRequestID: "merchant-1",
          CheckoutRequestID: "checkout-1",
          ResultCode: 0,
          ResultDesc: "Success",
          CallbackMetadata: { Item: [{ Name: "Amount", Value: 12 }, { Name: "MpesaReceiptNumber", Value: "QWERTY1234" }] },
        },
      },
    };
    expect(mpesaCallbackSchema.safeParse(callback).success).toBe(true);
    expect(mpesaCallbackSchema.safeParse({
      ...callback,
      Body: { stkCallback: { ...callback.Body.stkCallback, ResultCode: "success" } },
    }).success).toBe(false);
  });
});
