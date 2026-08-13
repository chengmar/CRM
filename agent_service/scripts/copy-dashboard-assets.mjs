import fs from "node:fs";
import path from "node:path";

const source = path.resolve("src", "dashboard", "public");
const destination = path.resolve("dist", "dashboard", "public");
const assets = ["index.html", "dashboard.css", "dashboard.js"];

fs.mkdirSync(destination, { recursive: true });
for (const asset of assets) {
  fs.copyFileSync(path.join(source, asset), path.join(destination, asset));
}
