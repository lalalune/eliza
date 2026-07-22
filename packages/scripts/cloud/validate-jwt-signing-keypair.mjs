#!/usr/bin/env node
/**
 * Validates the Worker JWT signing pair before deployment publishes either
 * secret. The CLI emits only generic status text; key material never enters
 * command arguments, output, or error diagnostics.
 */
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { pathToFileURL } from "node:url";

const PROBE = Buffer.from("eliza-cloud-jwt-signing-keypair-preflight-v1");
const ES256_CURVES = new Set(["P-256", "prime256v1"]);

function decodePemKey(encodedKey, type) {
  const decoded = Buffer.from(encodedKey, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN")) return decoded;
  return `-----BEGIN ${type} KEY-----\n${encodedKey}\n-----END ${type} KEY-----`;
}

/** Parse, derive, sign, and verify without returning or logging key material. */
export function validateJwtSigningKeyPair(encodedPrivateKey, encodedPublicKey) {
  if (!encodedPrivateKey?.trim() || !encodedPublicKey?.trim()) {
    throw new Error("Both JWT signing keys are required");
  }

  const privateKey = createPrivateKey(
    decodePemKey(encodedPrivateKey, "PRIVATE"),
  );
  const publicKey = createPublicKey(decodePemKey(encodedPublicKey, "PUBLIC"));
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    publicKey.asymmetricKeyType !== "ec" ||
    !ES256_CURVES.has(privateKey.asymmetricKeyDetails?.namedCurve) ||
    !ES256_CURVES.has(publicKey.asymmetricKeyDetails?.namedCurve)
  ) {
    throw new Error("JWT signing keys must use ES256 (P-256)");
  }

  const derivedPublicKey = createPublicKey(privateKey).export({
    type: "spki",
    format: "der",
  });
  const configuredPublicKey = publicKey.export({ type: "spki", format: "der" });
  if (!derivedPublicKey.equals(configuredPublicKey)) {
    throw new Error("JWT signing keys do not form one pair");
  }

  const signature = sign("sha256", PROBE, privateKey);
  if (!verify("sha256", PROBE, publicKey, signature)) {
    throw new Error("JWT signing key verification failed");
  }
}

function main() {
  try {
    validateJwtSigningKeyPair(
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions injects this standalone deploy secret outside Turbo caching.
      process.env.JWT_SIGNING_PRIVATE_KEY,
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions injects this standalone deploy secret outside Turbo caching.
      process.env.JWT_SIGNING_PUBLIC_KEY,
    );
    console.log("[jwt-signing-preflight] ES256 signing key pair is valid");
  } catch {
    // error-policy:J1 deployment CLI boundary translates all parser/crypto
    // failures to one value-free diagnostic and a nonzero process status.
    console.error(
      "::error::JWT signing key pair validation failed; expected matching ES256 PKCS#8/SPKI keys",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
