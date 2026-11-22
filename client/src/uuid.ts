let fallbackSequence = 0;

function fillFallbackRandom(bytes: Uint8Array): void {
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }

  let timestamp = Date.now();
  for (let index = 0; index < 6; index += 1) {
    bytes[index] ^= timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }

  let sequence = ++fallbackSequence;
  for (let index = 12; index < 16; index += 1) {
    bytes[index] ^= sequence % 256;
    sequence = Math.floor(sequence / 256);
  }
}

export function createUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
  else fillFallbackRandom(bytes);

  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
