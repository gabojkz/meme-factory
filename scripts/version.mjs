#!/usr/bin/env node
/**
 * Keep package.json, package-lock.json, tauri.conf.json, Cargo.toml,
 * and Cargo.lock on the same version.
 *
 *   node scripts/version.mjs check           # files agree with each other
 *   node scripts/version.mjs check 0.3.0     # files match a specific version
 *   node scripts/version.mjs set 0.3.0       # write version everywhere
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const paths = {
  packageJson: join(root, "package.json"),
  packageLock: join(root, "package-lock.json"),
  tauriConf: join(root, "src-tauri", "tauri.conf.json"),
  cargoToml: join(root, "src-tauri", "Cargo.toml"),
  cargoLock: join(root, "src-tauri", "Cargo.lock"),
};

function normalize(raw) {
  const v = String(raw ?? "")
    .trim()
    .replace(/^v/i, "");
  if (!/^\d+\.\d+\.\d+([.-][\w.-]+)?$/.test(v)) {
    throw new Error(`Invalid version: ${raw}`);
  }
  return v;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function readVersions() {
  const packageJson = readJson(paths.packageJson);
  const packageLock = readJson(paths.packageLock);
  const tauriConf = readJson(paths.tauriConf);
  const cargoToml = readFileSync(paths.cargoToml, "utf8");
  const cargoLock = readFileSync(paths.cargoLock, "utf8");

  const cargoTomlMatch = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
  const cargoLockMatch = cargoLock.match(
    /name\s*=\s*"memefactory"\nversion\s*=\s*"([^"]+)"/,
  );

  return {
    "package.json": packageJson.version,
    "package-lock.json": packageLock.version,
    "package-lock.json (root package)": packageLock.packages?.[""]?.version,
    "src-tauri/tauri.conf.json": tauriConf.version,
    "src-tauri/Cargo.toml": cargoTomlMatch?.[1] ?? null,
    "src-tauri/Cargo.lock": cargoLockMatch?.[1] ?? null,
  };
}

function setVersion(version) {
  const next = normalize(version);

  const packageJson = readJson(paths.packageJson);
  packageJson.version = next;
  writeJson(paths.packageJson, packageJson);

  const packageLock = readJson(paths.packageLock);
  packageLock.version = next;
  if (packageLock.packages?.[""]) packageLock.packages[""].version = next;
  writeJson(paths.packageLock, packageLock);

  const tauriConf = readJson(paths.tauriConf);
  tauriConf.version = next;
  writeJson(paths.tauriConf, tauriConf);

  let cargoToml = readFileSync(paths.cargoToml, "utf8");
  cargoToml = cargoToml.replace(
    /^version\s*=\s*"[^"]+"/m,
    `version = "${next}"`,
  );
  writeFileSync(paths.cargoToml, cargoToml);

  let cargoLock = readFileSync(paths.cargoLock, "utf8");
  cargoLock = cargoLock.replace(
    /(name\s*=\s*"memefactory"\n)version\s*=\s*"[^"]+"/,
    `$1version = "${next}"`,
  );
  writeFileSync(paths.cargoLock, cargoLock);

  console.log(`Synced app version to ${next}`);
}

function checkVersion(expected) {
  const versions = readVersions();
  const values = Object.values(versions);
  const unique = [...new Set(values)];
  const target = expected ? normalize(expected) : unique[0];

  let ok = true;
  for (const [file, version] of Object.entries(versions)) {
    if (version !== target) {
      ok = false;
      console.error(`✗ ${file}: ${version ?? "(missing)"} (expected ${target})`);
    } else {
      console.log(`✓ ${file}: ${version}`);
    }
  }

  if (!ok) {
    console.error(
      "\nVersion mismatch. Run: npm run version:set -- <version>\nExample: npm run version:set -- 0.3.0",
    );
    process.exit(1);
  }

  console.log(`\nAll version files match ${target}`);
}

const [cmd, arg] = process.argv.slice(2);

try {
  if (cmd === "set") {
    if (!arg) throw new Error("Usage: node scripts/version.mjs set <version>");
    setVersion(arg);
  } else if (cmd === "check" || cmd === undefined) {
    checkVersion(arg);
  } else {
    throw new Error("Usage: node scripts/version.mjs <check|set> [version]");
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
