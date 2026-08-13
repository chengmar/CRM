import fs from "node:fs/promises";
import path from "node:path";
import { installStateSchema, type InstallState } from "../../shared/contracts.js";

export interface InstallStateRepository {
  load(): Promise<InstallState | null>;
  save(state: InstallState): Promise<void>;
}

async function readState(filePath: string): Promise<InstallState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return installStateSchema.parse(parsed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

export class JsonInstallStateRepository implements InstallStateRepository {
  readonly filePath: string;
  readonly backupPath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.backupPath = `${filePath}.bak`;
  }

  async load(): Promise<InstallState | null> {
    try {
      return await readState(this.filePath);
    } catch (primaryError) {
      try {
        const backup = await readState(this.backupPath);
        if (backup) {
          await this.save(backup);
          return backup;
        }
      } catch {
        // The primary error carries the useful corruption detail.
      }
      throw primaryError;
    }
  }

  async save(state: InstallState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const data = `${JSON.stringify(state, null, 2)}\n`;
    await fs.writeFile(temporaryPath, data, { encoding: "utf8", mode: 0o600 });
    try {
      await fs.copyFile(this.filePath, this.backupPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.rename(temporaryPath, this.filePath);
  }
}

export class MemoryInstallStateRepository implements InstallStateRepository {
  private state: InstallState | null = null;

  async load(): Promise<InstallState | null> {
    return this.state ? structuredClone(this.state) : null;
  }

  async save(state: InstallState): Promise<void> {
    this.state = structuredClone(state);
  }
}
