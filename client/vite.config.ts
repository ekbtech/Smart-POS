import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const envDirectory = resolve(import.meta.dirname, "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDirectory, "");
  const certificatePath = env.SMARTPOS_TLS_CERT;
  const keyPath = env.SMARTPOS_TLS_KEY;
  if (Boolean(certificatePath) !== Boolean(keyPath)) {
    throw new Error("Set both SMARTPOS_TLS_CERT and SMARTPOS_TLS_KEY to enable HTTPS for the mobile scanner.");
  }

  return {
    envDir: envDirectory,
    plugins: [react(), tailwindcss()],
    server: {
      host: "0.0.0.0",
      ...(certificatePath && keyPath ? {
        https: {
          cert: readFileSync(resolve(envDirectory, certificatePath)),
          key: readFileSync(resolve(envDirectory, keyPath)),
        },
      } : {}),
      proxy: {
        "/api": "http://localhost:4000",
      },
    },
  };
});
