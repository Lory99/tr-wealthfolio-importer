// Cross-platform packaging for the Wealthfolio addon.
//
// Why not `zip -r ...`? The stock template script uses `mkdir -p`, `find` and
// the `zip` CLI, which do not exist in Windows PowerShell/cmd. This script
// uses only Node + `archiver`, so `pnpm bundle` / `pnpm package` produce a
// byte-equivalent, Linux-installable zip on both Windows and Linux.
//
// Guarantees for the host installer:
// - entry names always use forward slashes (never `\`)
// - `manifest.json` sits at the archive root
// - includes `dist/addon.js` (+ any dist assets), `assets/` (if present),
//   `README.md`; never `node_modules`, never `*.map`
import { createWriteStream, promises as fs } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await fs.readFile(join(root, "package.json"), "utf8"));
const outDir = join(root, "dist");
const outZip = join(outDir, `${pkg.name}-${pkg.version}.zip`);

const toZipPath = (p) => p.split(sep).join("/");

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(dir) {
  const out = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (!entry.name.endsWith(".map")) out.push(full);
    }
  }
  if (await exists(dir)) await walk(dir);
  return out;
}

await fs.mkdir(outDir, { recursive: true });
// Remove stale maps + stale zips first (mirrors template behaviour).
for (const f of await collectFiles(outDir)) {
  if (f.endsWith(".zip")) await fs.rm(f, { force: true });
}

const archive = archiver("zip", { zlib: { level: 9 } });
const stream = createWriteStream(outZip);
const done = new Promise((resolve, reject) => {
  stream.on("close", resolve);
  archive.on("error", reject);
});
archive.pipe(stream);

// manifest.json at archive root (required by the host installer).
archive.file(join(root, "manifest.json"), { name: "manifest.json" });

// dist/** (built addon.js + bundled assets), minus maps/zips, flattened paths
// converted to forward slashes.
for (const f of await collectFiles(outDir)) {
  if (f.endsWith(".zip")) continue;
  archive.file(f, { name: toZipPath(relative(root, f)) });
}

// assets/** (private static files) + README.md when present.
if (await exists(join(root, "assets"))) {
  archive.directory(join(root, "assets"), "assets");
}
if (await exists(join(root, "README.md"))) {
  archive.file(join(root, "README.md"), { name: "README.md" });
}

await archive.finalize();
await done;
console.log(`packaged ${toZipPath(relative(root, outZip))} (${archive.pointer()} bytes)`);
