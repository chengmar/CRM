import fs from "node:fs";
import path from "node:path";

function encodeValue(value: string): string {
  return /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : JSON.stringify(value);
}

export function upsertEnvFile(filePath: string, values: Record<string, string>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const requested = new Map(Object.entries(values));
  const written = new Set<string>();
  const lines = current ? current.split(/\r?\n/) : [];
  const updated: string[] = [];
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    const key = match?.[1];
    if (!key || !requested.has(key)) {
      updated.push(line);
      continue;
    }
    if (written.has(key)) continue;
    updated.push(`${key}=${encodeValue(requested.get(key) ?? "")}`);
    written.add(key);
  }
  if (updated.length > 0 && updated.at(-1) !== "") updated.push("");
  for (const [key, value] of requested) {
    if (!written.has(key)) updated.push(`${key}=${encodeValue(value)}`);
  }
  const output = `${updated.join(newline).replace(/(?:\r?\n)+$/, "")}${newline}`;
  fs.writeFileSync(filePath, output, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows ACLs are managed outside Node; the file remains excluded by .gitignore.
  }
}
