// Cross-platform `rm -rf dist` replacement (works in PowerShell, cmd, bash).
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await rm(join(root, "dist"), { recursive: true, force: true });
console.log("cleaned dist/");
