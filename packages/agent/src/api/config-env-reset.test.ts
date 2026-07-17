/**
 * Verifies destructive reset redacts credentials from the live dotenv file and
 * every recovery companion while preserving unrelated formatting and values.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  deleteConfigEnvForReset,
  removeConfigEnvKeys,
  validateConfigEnvResetPaths,
} from "./config-env";

describe("removeConfigEnvKeys", () => {
  let stateDir: string;
  const savedSecret = process.env.EVM_PRIVATE_KEY;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "config-env-reset-"));
    process.env.EVM_PRIVATE_KEY = "process-secret";
  });

  afterEach(async () => {
    if (savedSecret === undefined) delete process.env.EVM_PRIVATE_KEY;
    else process.env.EVM_PRIVATE_KEY = savedSecret;
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("redacts live, backup, and interrupted-write copies atomically", async () => {
    const filePath = path.join(stateDir, "config.env");
    await fs.writeFile(
      filePath,
      "# keep this comment\nEVM_PRIVATE_KEY=live-secret\nKEEP=value\nEVM_PRIVATE_KEY=older-secret\n",
    );
    await fs.writeFile(
      `${filePath}.bak`,
      "EVM_PRIVATE_KEY=backup-secret\nKEEP_BACKUP=yes\n",
    );
    await fs.writeFile(`${filePath}.tmp`, "EVM_PRIVATE_KEY=temp-secret\n");
    await fs.writeFile(
      `${filePath}.bak.tmp`,
      "EVM_PRIVATE_KEY=backup-temp-secret\n",
    );

    await removeConfigEnvKeys(["EVM_PRIVATE_KEY"], { stateDir });

    expect(await fs.readFile(filePath, "utf8")).toBe(
      "# keep this comment\nKEEP=value\n",
    );
    expect(await fs.readFile(`${filePath}.bak`, "utf8")).toBe(
      "KEEP_BACKUP=yes\n",
    );
    await expect(fs.stat(`${filePath}.tmp`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(`${filePath}.bak.tmp`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(process.env.EVM_PRIVATE_KEY).toBeUndefined();
  });

  it("rejects malformed keys before touching any file", async () => {
    const filePath = path.join(stateDir, "config.env");
    await fs.writeFile(filePath, "KEEP=value\n");

    await expect(
      removeConfigEnvKeys(["NOT-A-KEY"], { stateDir }),
    ).rejects.toThrow("invalid key");

    expect(await fs.readFile(filePath, "utf8")).toBe("KEEP=value\n");
  });

  it("deletes every owned live, backup, and staging artifact", async () => {
    const filePath = path.join(stateDir, "config.env");
    for (const candidate of [
      filePath,
      `${filePath}.bak`,
      `${filePath}.tmp`,
      `${filePath}.bak.tmp`,
    ]) {
      await fs.writeFile(candidate, "SECRET=value\n");
    }

    await deleteConfigEnvForReset({ stateDir });

    for (const candidate of [
      filePath,
      `${filePath}.bak`,
      `${filePath}.tmp`,
      `${filePath}.bak.tmp`,
    ]) {
      await expect(fs.stat(candidate)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("refuses a symlink without deleting its external target or companions", async () => {
    const filePath = path.join(stateDir, "config.env");
    const externalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "config-env-target-"),
    );
    const external = path.join(externalDir, "secrets.env");
    await fs.writeFile(external, "SECRET=external\n");
    await fs.symlink(external, filePath);
    await fs.writeFile(`${filePath}.bak`, "SECRET=backup\n");
    await fs.writeFile(`${filePath}.tmp`, "SECRET=temporary\n");
    await fs.writeFile(`${filePath}.bak.tmp`, "SECRET=backup-temporary\n");

    expect(() => validateConfigEnvResetPaths({ stateDir })).toThrow(
      "refusing symlinked config.env reset path",
    );
    await expect(deleteConfigEnvForReset({ stateDir })).rejects.toThrow(
      "refusing symlinked config.env reset path",
    );

    for (const candidate of [
      filePath,
      `${filePath}.bak`,
      `${filePath}.tmp`,
      `${filePath}.bak.tmp`,
      external,
    ]) {
      await expect(fs.stat(candidate)).resolves.toBeDefined();
    }
    await fs.rm(externalDir, { force: true, recursive: true });
  });

  it("refuses a symlinked state-root ancestor before deleting config artifacts", async () => {
    const externalDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "config-env-ancestor-target-"),
    );
    const linkedRoot = path.join(stateDir, "linked-state");
    await fs.symlink(externalDir, linkedRoot, "dir");
    const filePath = path.join(externalDir, "config.env");
    await fs.writeFile(filePath, "SECRET=external\n");

    expect(() => validateConfigEnvResetPaths({ stateDir: linkedRoot })).toThrow(
      "refusing symlinked config.env state root reset path",
    );
    await expect(
      deleteConfigEnvForReset({ stateDir: linkedRoot }),
    ).rejects.toThrow("refusing symlinked config.env state root reset path");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe(
      "SECRET=external\n",
    );

    await fs.rm(externalDir, { force: true, recursive: true });
  });
});
