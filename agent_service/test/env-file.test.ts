import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertEnvFile } from "../src/env-file.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      if (!new Set(["EBUSY", "EPERM", "ENOTEMPTY"]).has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
});

describe("env file updates", () => {
  it("removes duplicate target keys and can clear a previously stored secret", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-agent-env-"));
    tempDirs.push(dir);
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(
      envPath,
      [
        "SMTP_PASSWORD=old-first",
        "UNCHANGED=value",
        "SMTP_PASSWORD=old-last",
        "IMAP_PASSWORD=old",
        "",
      ].join("\n"),
      "utf8",
    );

    upsertEnvFile(envPath, { SMTP_PASSWORD: "", IMAP_PASSWORD: "new value" });

    const result = fs.readFileSync(envPath, "utf8");
    expect(result.match(/^SMTP_PASSWORD=/gm)).toHaveLength(1);
    expect(result).toContain("SMTP_PASSWORD=\n");
    expect(result).not.toContain("old-first");
    expect(result).not.toContain("old-last");
    expect(result).toContain('IMAP_PASSWORD="new value"');
    expect(result).toContain("UNCHANGED=value");
  });
});
