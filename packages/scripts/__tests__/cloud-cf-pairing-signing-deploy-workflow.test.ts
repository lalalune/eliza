/**
 * Locks dedicated-agent pairing to a deployment that publishes both ES256
 * signing keys without exposing their values in workflow output.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";

const repoRoot = new URL("../../../", import.meta.url);
const workflowSource = readFileSync(
  new URL(".github/workflows/cloud-cf-deploy.yml", repoRoot),
  "utf8",
);
const apiDirectory = new URL("packages/cloud/api/", repoRoot);

function generateEncodedPair(): { privateKey: string; publicKey: string } {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey: Buffer.from(
      pair.privateKey.export({ type: "pkcs8", format: "pem" }),
    ).toString("base64"),
    publicKey: Buffer.from(
      pair.publicKey.export({ type: "spki", format: "pem" }),
    ).toString("base64"),
  };
}

const configuredPair = generateEncodedPair();
const otherPair = generateEncodedPair();

interface WorkflowStep {
  name?: string;
  env?: Record<string, string>;
  run?: string;
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const workflow = Bun.YAML.parse(workflowSource) as Workflow;
const publishStep = workflow.jobs?.["deploy-api"]?.steps?.find(
  (step) => step.name === "Publish Worker AI secrets",
);

if (!publishStep?.run) {
  throw new Error("Missing Publish Worker AI secrets workflow step");
}

const preflightEnd = publishStep.run.indexOf(
  "# Construct the staging fallback only when the source key is real.",
);
if (preflightEnd < 0) {
  throw new Error("Missing pairing signing preflight boundary");
}
const pairingPreflight = publishStep.run.slice(0, preflightEnd);

function runPairingPreflight(env: Record<string, string>) {
  return spawnSync("bash", ["-c", pairingPreflight], {
    encoding: "utf8",
    cwd: apiDirectory,
    env: {
      ...process.env,
      JWT_SIGNING_PRIVATE_KEY: "",
      JWT_SIGNING_PUBLIC_KEY: "",
      ...env,
    },
  });
}

describe("Cloud CF pairing signing deploy contract", () => {
  test("sources and publishes both signing keys through Worker secrets", () => {
    expect(publishStep.env?.JWT_SIGNING_PRIVATE_KEY).toBe(
      "$" + "{{ secrets.JWT_SIGNING_PRIVATE_KEY }}",
    );
    expect(publishStep.env?.JWT_SIGNING_PUBLIC_KEY).toBe(
      "$" + "{{ secrets.JWT_SIGNING_PUBLIC_KEY }}",
    );
    expect(publishStep.run).toMatch(
      /JWT_SIGNING_PRIVATE_KEY \\\s+JWT_SIGNING_PUBLIC_KEY \\/,
    );
    expect(publishStep.run).toContain(
      `printf '%s' "$value" | bunx wrangler secret put "$name"`,
    );
    expect(
      publishStep.run.indexOf("validate-jwt-signing-keypair.mjs"),
    ).toBeLessThan(publishStep.run.indexOf("wrangler secret put"));
  });

  test("fails before publication when either key is absent or blank", () => {
    for (const missing of [
      "JWT_SIGNING_PRIVATE_KEY",
      "JWT_SIGNING_PUBLIC_KEY",
    ]) {
      const result = runPairingPreflight({
        JWT_SIGNING_PRIVATE_KEY: configuredPair.privateKey,
        JWT_SIGNING_PUBLIC_KEY: configuredPair.publicKey,
        [missing]: " \t\n",
      });
      expect(
        result.status,
        `${missing}: ${result.stdout}${result.stderr}`,
      ).toBe(1);
      expect(result.stdout).toContain(missing);
      expect(result.stdout).not.toContain(configuredPair.privateKey);
      expect(result.stdout).not.toContain(configuredPair.publicKey);
    }
  });

  test("cryptographically accepts a matching ES256 pair without printing it", () => {
    const result = runPairingPreflight({
      JWT_SIGNING_PRIVATE_KEY: configuredPair.privateKey,
      JWT_SIGNING_PUBLIC_KEY: configuredPair.publicKey,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("ES256 signing key pair is valid");
    expect(result.stdout).not.toContain(configuredPair.privateKey);
    expect(result.stdout).not.toContain(configuredPair.publicKey);
  });

  test("rejects malformed key material before publication without printing it", () => {
    const malformed = Buffer.from("malformed-private-key").toString("base64");
    const result = runPairingPreflight({
      JWT_SIGNING_PRIVATE_KEY: malformed,
      JWT_SIGNING_PUBLIC_KEY: configuredPair.publicKey,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "JWT signing key pair validation failed",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(malformed);
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      configuredPair.publicKey,
    );
  });

  test("rejects mismatched valid ES256 keys before publication", () => {
    const result = runPairingPreflight({
      JWT_SIGNING_PRIVATE_KEY: configuredPair.privateKey,
      JWT_SIGNING_PUBLIC_KEY: otherPair.publicKey,
    });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "JWT signing key pair validation failed",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      configuredPair.privateKey,
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      otherPair.publicKey,
    );
  });
});
