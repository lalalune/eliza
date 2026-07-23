/**
 * Destructive-bulk classifier tests: what fires the chat-path confirm gate and
 * — just as load-bearing — what must NOT fire it. Deterministic, no processes.
 */
import { describe, expect, it } from "vitest";
import { classifyDestructiveCommand } from "./destructive-gate";

describe("classifyDestructiveCommand — fires", () => {
  it("rm -rf on a path", () => {
    const v = classifyDestructiveCommand("rm -rf /home/milady/projects/old");
    expect(v.destructive).toBe(true);
    expect(v.reason).toBe("recursive delete");
    expect(v.targets).toContain("/home/milady/projects/old");
  });
  it("rm -fr and rm -R variants", () => {
    expect(classifyDestructiveCommand("rm -fr build").destructive).toBe(true);
    expect(classifyDestructiveCommand("rm -R cache").destructive).toBe(true);
  });
  it("recursive rm hidden behind a chain", () => {
    const v = classifyDestructiveCommand("ls && rm -rf ./data");
    expect(v.destructive).toBe(true);
  });
  it("PowerShell Remove-Item -Recurse", () => {
    const v = classifyDestructiveCommand(
      'Remove-Item -Recurse -Force "$env:TEMP\\old-project"',
    );
    expect(v.destructive).toBe(true);
    expect(v.reason).toBe("recursive delete");
  });
  it.each([
    ["ri -Recurse old-dir"],
    ["del -Recurse old-dir"],
    ["rd -Recurse old-dir"],
    ["erase -Recurse old-dir"],
    ["rmdir -Recurse old-dir"],
  ])("PowerShell Remove-Item alias: %s", (command) => {
    const v = classifyDestructiveCommand(command);
    expect(v.destructive).toBe(true);
    expect(v.reason).toBe("recursive delete");
    expect(v.targets).toContain("old-dir");
  });
  it.each([
    ["Remove-Item -r old-dir"],
    ["Remove-Item -re old-dir"],
    ["Remove-Item -Rec old-dir"],
    ["Remove-Item -Recu old-dir"],
    ["Remove-Item -recurs old-dir"],
    ["Remove-Item -RECURSE old-dir"],
    ["Remove-Item -Recurse:$true old-dir"],
    ["Remove-Item -Rec:$true old-dir"],
  ])("PowerShell -Recurse abbreviation: %s", (command) => {
    const v = classifyDestructiveCommand(command);
    expect(v.destructive).toBe(true);
    expect(v.reason).toBe("recursive delete");
    expect(v.targets).toContain("old-dir");
  });
  it("case-insensitive cmdlet name", () => {
    expect(
      classifyDestructiveCommand("REMOVE-ITEM -recurse C:\\temp\\junk")
        .destructive,
    ).toBe(true);
  });
  it("full path to the cmdlet-shaped bin still classifies", () => {
    expect(
      classifyDestructiveCommand("C:\\Windows\\del -Recurse old-dir")
        .destructive,
    ).toBe(true);
  });
  it("forced glob delete", () => {
    expect(
      classifyDestructiveCommand("rm -f /var/log/app/*.log").destructive,
    ).toBe(true);
  });
  it("find -delete", () => {
    expect(
      classifyDestructiveCommand("find /tmp/scratch -name '*.tmp' -delete")
        .destructive,
    ).toBe(true);
  });
  it("dd onto a raw device", () => {
    const v = classifyDestructiveCommand("dd if=/dev/zero of=/dev/sda bs=1M");
    expect(v.destructive).toBe(true);
    expect(v.targets).toContain("of=/dev/sda");
  });
  it("mkfs family and shred", () => {
    expect(classifyDestructiveCommand("mkfs.ext4 /dev/sdb1").destructive).toBe(
      true,
    );
    expect(classifyDestructiveCommand("shred -u secrets.txt").destructive).toBe(
      true,
    );
  });
  it("DROP DATABASE through a sql runner", () => {
    const v = classifyDestructiveCommand('psql -c "DROP DATABASE eliza"');
    expect(v.destructive).toBe(true);
    expect(v.targets[0]).toContain("eliza");
  });
});

describe("classifyDestructiveCommand — must NOT fire", () => {
  it.each([
    ["ls -la /tmp"],
    ["rm single-file.txt"],
    ["rm -f one-exact-file.log"],
    ["git rm old.ts"],
    ["df -h / && du -sh /home"],
    ["grep -r pattern src/"],
    ["echo 'rm -rf /' # just talking about it"],
    ["find . -name '*.ts' -print"],
    ["dd if=/dev/urandom of=./random.bin count=1"],
    ["mkdir -p new/dir"],
    ["Remove-Item single-file.txt"],
    ["Remove-Item -Force one-exact-file.log"],
    ["del stale-file.txt"],
    ["rmdir empty-dir"],
    ["ri -Path single-file.txt"],
    // -Recurse:$false explicitly disables recursion — a single-item delete.
    ["Remove-Item -Recurse:$false single-file.txt"],
  ])("%s", (command) => {
    expect(classifyDestructiveCommand(command).destructive).toBe(false);
  });
  it("quoted rm -rf inside a string argument does not fire", () => {
    expect(
      classifyDestructiveCommand('echo "rm -rf would be bad"').destructive,
    ).toBe(false);
  });
});
