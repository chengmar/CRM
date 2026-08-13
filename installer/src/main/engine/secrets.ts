import fs from "node:fs/promises";
import path from "node:path";
import type { SecretName, SecretPresence } from "../../shared/contracts.js";

export interface SecretCodec {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export interface InstallerSecretStore {
  set(values: Partial<Record<SecretName, string>>): Promise<void>;
  get(name: SecretName): Promise<string>;
  remove(name: SecretName): Promise<void>;
  presence(): Promise<SecretPresence>;
  knownValues(): Promise<string[]>;
}

type StoredSecretDocument = {
  schemaVersion: 1;
  values: Partial<Record<SecretName, string>>;
};

export class EncryptedFileSecretStore implements InstallerSecretStore {
  constructor(
    private readonly filePath: string,
    private readonly codec: SecretCodec,
  ) {}

  private async loadDocument(): Promise<StoredSecretDocument> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8")) as StoredSecretDocument;
      if (raw.schemaVersion !== 1 || typeof raw.values !== "object") {
        throw new Error("Unsupported installer secret-store format.");
      }
      return raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { schemaVersion: 1, values: {} };
      }
      throw error;
    }
  }

  private async saveDocument(document: StoredSecretDocument): Promise<void> {
    if (!this.codec.isAvailable()) {
      throw new Error("Windows secure storage is unavailable; refusing to save credentials.");
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, this.filePath);
  }

  async set(values: Partial<Record<SecretName, string>>): Promise<void> {
    const document = await this.loadDocument();
    for (const [name, value] of Object.entries(values) as Array<[SecretName, string]>) {
      if (!value) continue;
      document.values[name] = this.codec.encrypt(value).toString("base64");
    }
    await this.saveDocument(document);
  }

  async get(name: SecretName): Promise<string> {
    const document = await this.loadDocument();
    const encoded = document.values[name];
    if (!encoded) return "";
    return this.codec.decrypt(Buffer.from(encoded, "base64"));
  }

  async remove(name: SecretName): Promise<void> {
    const document = await this.loadDocument();
    delete document.values[name];
    await this.saveDocument(document);
  }

  async presence(): Promise<SecretPresence> {
    const document = await this.loadDocument();
    return Object.fromEntries(
      Object.entries(document.values).map(([name, value]) => [name, Boolean(value)]),
    ) as SecretPresence;
  }

  async knownValues(): Promise<string[]> {
    const document = await this.loadDocument();
    const values: string[] = [];
    for (const [name, encoded] of Object.entries(document.values) as Array<[SecretName, string]>) {
      if (!encoded) continue;
      const value = this.codec.decrypt(Buffer.from(encoded, "base64"));
      if (value) values.push(value);
      void name;
    }
    return values;
  }
}

export class TestSecretCodec implements SecretCodec {
  isAvailable(): boolean {
    return true;
  }

  encrypt(value: string): Buffer {
    return Buffer.from(`test:${value}`, "utf8");
  }

  decrypt(value: Buffer): string {
    return value.toString("utf8").replace(/^test:/, "");
  }
}
