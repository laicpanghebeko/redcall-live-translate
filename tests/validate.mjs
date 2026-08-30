import {readFile, readdir, stat} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function fail(message) {
  errors.push(message);
}

async function exists(relativePath) {
  try {
    return (await stat(path.join(root, relativePath))).isFile();
  } catch {
    return false;
  }
}

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function walk(directory = root) {
  const files = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if ([".git", "dist", "node_modules", "vendor"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(absolute)));
    else files.push(absolute);
  }
  return files;
}

const manifest = await json("manifest.json");
const packageJson = await json("package.json");

if (manifest.manifest_version !== 3) fail("manifest.json must use Manifest V3");
if (manifest.version !== packageJson.version) {
  fail(
    `Manifest version ${manifest.version} does not match package version ${packageJson.version}`
  );
}

const requiredFiles = new Set([
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  "offscreen.html",
  "mic-permission.html",
  "vendor/livekit-client.umd.js",
  "vendor/LICENSE.livekit-client",
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((script) => script.js || [])
]);

for (const relativePath of requiredFiles) {
  if (relativePath && !(await exists(relativePath)))
    fail(`Referenced file is missing: ${relativePath}`);
}

const forbiddenPermissions = new Set(["<all_urls>", "debugger", "management", "nativeMessaging"]);
for (const permission of [...(manifest.permissions || []), ...(manifest.host_permissions || [])]) {
  if (forbiddenPermissions.has(permission))
    fail(`Overly broad or sensitive permission: ${permission}`);
}

for (const resource of manifest.web_accessible_resources || []) {
  if ((resource.matches || []).includes("<all_urls>")) {
    fail("Web-accessible resources must not be exposed to <all_urls>");
  }
}

const csp = manifest.content_security_policy?.extension_pages || "";
if (!csp.includes("script-src 'self'")) fail("Extension CSP must restrict scripts to self");
if (/unsafe-eval|https?:/i.test(csp))
  fail("Extension CSP must not enable remote or evaluated code");

const files = await walk();
for (const file of files.filter((item) => item.endsWith(".html"))) {
  const source = await readFile(file, "utf8");
  if (/<script\b[^>]*\bsrc=["']https?:/i.test(source)) {
    fail(`Remote runtime script detected in ${path.relative(root, file)}`);
  }
}

const secretPatterns = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/
];

const scannedExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".yaml",
  ".yml"
]);
for (const file of files) {
  if (!scannedExtensions.has(path.extname(file))) continue;
  const source = await readFile(file, "utf8");
  for (const pattern of secretPatterns) {
    if (pattern.test(source)) fail(`Potential secret in ${path.relative(root, file)} (${pattern})`);
  }
}

if (errors.length) {
  console.error(`\nValidation failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Validated RedCall Live Translate ${manifest.version}`);
console.log(`- ${requiredFiles.size} runtime references resolved`);
console.log("- permissions and CSP checked");
console.log("- first-party sources scanned for common secret patterns");
