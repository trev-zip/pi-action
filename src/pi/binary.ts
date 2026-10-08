import {
  findArchiveExecutable,
  resolveCachedExecutable,
  type ToolArchiveAsset,
  type ToolArchiveExecutableSpec,
} from "../tool-archive.ts";

export const PI_VERSION = "1.1.0";

export async function resolvePiExecutable(): Promise<string> {
  if (process.env.PI_PATH) {
    return process.env.PI_PATH;
  }

  const version = PI_VERSION;
  const target = getPiTarget();

  if (!target) {
    throw new Error(`Unsupported pi platform: ${process.platform} (${process.arch})`);
  }

  const asset = getPiToolArchiveAsset(version, target);
  const url = getPiReleaseAssetUrl(version, target);

  return resolveCachedExecutable(asset, url);
}

export function getPiTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (arch !== "x64" && arch !== "arm64") {
    return null;
  }

  if (platform === "linux" || platform === "android") {
    return `linux-${arch}`;
  }

  if (platform === "darwin") {
    return `darwin-${arch}`;
  }

  if (platform === "win32") {
    return `windows-${arch}`;
  }

  return null;
}

export function getPiReleaseAsset(target: string): { assetName: string; format: "tar" | "zip" } {
  const supportedTargets = new Set([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "windows-arm64",
    "windows-x64",
  ]);

  if (!supportedTargets.has(target)) {
    throw new Error(`Unsupported pi release target: ${target}`);
  }

  if (target.startsWith("windows-")) {
    return { assetName: `pi-${target}.zip`, format: "zip" };
  }

  return { assetName: `pi-${target}.tar.gz`, format: "tar" };
}

export function getPiReleaseAssetUrl(version: string, target: string): string {
  const { assetName } = getPiReleaseAsset(target);
  return `https://github.com/earendil-works/pi/releases/download/v${version}/${assetName}`;
}

export function findPiExecutable(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return findArchiveExecutable(directory, getPiExecutableSpec(platform), platform);
}

export function getPiToolArchiveAsset(version: string, target: string): ToolArchiveAsset {
  return {
    ...getPiExecutableSpec(),
    ...getPiReleaseAsset(target),
    version,
    target,
  };
}

function getPiExecutableSpec(
  platform: NodeJS.Platform = process.platform,
): ToolArchiveExecutableSpec {
  return {
    cacheName: "pi",
    displayName: "pi",
    executableNames: platform === "win32" ? ["pi.exe"] : ["pi"],
  };
}
