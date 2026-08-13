import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonInstallStateRepository } from "../src/main/engine/repository.js";
import { createInitialState } from "../src/main/engine/state.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("JsonInstallStateRepository", () => {
  it("recovers the last valid backup when the primary file is corrupted", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "crm-installer-state-"));
    created.push(directory);
    const filePath = path.join(directory, "state.json");
    const repository = new JsonInstallStateRepository(filePath);
    const first = createInitialState("0.1.0");
    await repository.save(first);
    const second = structuredClone(first);
    second.status = "RUNNING";
    await repository.save(second);
    await fs.writeFile(filePath, "{broken", "utf8");
    const recovered = await repository.load();
    expect(recovered?.status).toBe("DRAFT");
  });
});
