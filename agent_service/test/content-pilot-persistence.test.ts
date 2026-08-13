import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildContentPilotCatalog, stageContentPilotCatalog } from "../src/acquisition/content-pilot-catalog.js";
import { AgentDatabase } from "../src/db.js";

describe("empty content catalog persistence", () => {
  it("creates no product content until an approved catalog is supplied", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "empty-content-catalog-"));
    const db = new AgentDatabase(path.join(directory, "agent.db"));
    try {
      const result = stageContentPilotCatalog({
        db,
        catalog: buildContentPilotCatalog(new Date("2026-07-20T00:00:00.000Z")),
        createdBy: "content-catalog-test",
      });
      expect(result).toEqual({
        assets: [],
        status: "DRAFT",
        publicationAuthorized: false,
        externalWrites: 0,
      });
      expect(db.db.prepare("SELECT count(*) AS count FROM content_assets").get()).toMatchObject({ count: 0 });
      expect(db.db.prepare("SELECT count(*) AS count FROM content_versions").get()).toMatchObject({ count: 0 });
    } finally {
      db.close();
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});
