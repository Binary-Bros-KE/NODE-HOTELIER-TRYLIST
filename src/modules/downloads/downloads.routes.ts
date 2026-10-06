import { Router } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Public, unauthenticated downloads — currently just the HOTELIER print
// bridge installer. No tenant, no auth: this is a device install, not tenant
// data, so it's mounted standalone before tenantContext (same pattern as
// public-receipts). The binary itself isn't in git (~90MB, rebuilt
// independently of app releases) — it's dropped straight onto the VPS at
// RELEASE_DIR by whoever publishes a new bridge version.
export const downloadsRouter = Router();

const RELEASE_DIR = path.resolve(process.cwd(), "releases", "print-bridge");
const EXE_NAME = "hotelier-print-bridge.exe";
const MANIFEST_NAME = "hotelier-print-bridge.json";

type BridgeManifest = { version?: string; publishedAt?: string; sha256?: string };

function bridgeFile() {
  return path.join(RELEASE_DIR, EXE_NAME);
}

function bridgeManifest(): BridgeManifest {
  const file = path.join(RELEASE_DIR, MANIFEST_NAME);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim()) as BridgeManifest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function versionedFilename(version: string | undefined) {
  const clean = version?.trim().replace(/^v/i, "").replace(/[^0-9A-Za-z._-]/g, "");
  return clean ? `hotelier-print-bridge-v${clean}.exe` : EXE_NAME;
}

function sha256(file: string) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function bridgeInfo() {
  const file = bridgeFile();
  if (!fs.existsSync(file)) return null;
  const stats = fs.statSync(file);
  const manifest = bridgeManifest();
  return {
    published: true,
    version: manifest.version ?? null,
    filename: versionedFilename(manifest.version),
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    publishedAt: manifest.publishedAt ?? null,
    sha256: manifest.sha256 ?? sha256(file),
  };
}

downloadsRouter.get("/print-bridge/version", (_req, res) => {
  const info = bridgeInfo();
  if (!info) {
    res.status(404).json({ published: false, error: "The print bridge hasn't been published yet." });
    return;
  }
  res.json(info);
});

downloadsRouter.get("/print-bridge", (_req, res) => {
  const file = bridgeFile();
  if (!fs.existsSync(file)) {
    res.status(404).json({ error: "The print bridge hasn't been published yet." });
    return;
  }
  const info = bridgeInfo();
  if (info?.version) res.setHeader("X-Hotelier-Print-Bridge-Version", info.version);
  if (info?.sha256) res.setHeader("X-Hotelier-Print-Bridge-SHA256", info.sha256);
  res.download(file, info?.filename ?? EXE_NAME);
});
