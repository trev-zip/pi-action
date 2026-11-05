import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import * as core from "@actions/core";

import { resolveCachedExecutable, type ToolArchiveAsset } from "../tool-archive.ts";
import { errorMessage } from "../utils.ts";
import { getPiTarget } from "./binary.ts";

export const RIPGREP_VERSION = "15.2.0";
export const FD_VERSION = "10.5.1";

type SearchTool = {
  name: "rg" | "fd";
  displayName: string;
  repo: string;
  version: string;
  tagPrefix: string;
  archivePrefix: string;
};

const SEARCH_TOOLS: SearchTool[] = [
  {
    name: "rg",
    displayName: "ripgrep",
    repo: "BurntSushi/ripgrep",
    version: RIPGREP_VERSION,
    tagPrefix: "",
    archivePrefix: "ripgrep-",
  },
  {
    name: "fd",
    displayName: "fd",
    repo: "sharkdp/fd",
    version: FD_VERSION,
    tagPrefix: "v",
    archivePrefix: "fd-v",
  },
];

const RUST_TARGETS: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "windows-arm64": "aarch64-pc-windows-msvc",
  "windows-x64": "x86_64-pc-windows-msvc",
};

// pi's grep and find tools run ripgrep and fd. pi looks for them in the agent
// directory's bin folder before PATH, and otherwise downloads the latest
// release itself, which fails on runners that cannot reach GitHub's release
// redirect in time. Providing pinned, cached copies avoids that download.
export async function setupPiSearchTools(
  agentDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Promise<void> {
  const target = getPiTarget(platform, arch);

  if (!target) {
    core.warning(`No ripgrep or fd release for ${platform} (${arch}); pi will look for them`);
    return;
  }

  const binDir = path.join(agentDir, "bin");
  mkdirSync(binDir, { recursive: true });

  for (const tool of SEARCH_TOOLS) {
    const { asset, url } = getSearchToolAsset(tool.name, target, platform);

    try {
      const executable = await resolveCachedExecutable(asset, url, platform);
      const destination = path.join(binDir, path.basename(executable));
      copyFileSync(executable, destination);
      chmodSync(destination, 0o755);
    } catch (error) {
      core.warning(
        `Could not provide ${tool.displayName} for pi; pi will try to download it: ${errorMessage(error)}`,
      );
    }
  }
}

export function getSearchToolAsset(
  name: SearchTool["name"],
  target: string,
  platform: NodeJS.Platform = process.platform,
): { asset: ToolArchiveAsset; url: string } {
  const tool = SEARCH_TOOLS.find((candidate) => candidate.name === name);
  const rustTarget = RUST_TARGETS[target];

  if (!tool || !rustTarget) {
    throw new Error(`Unsupported ${name} release target: ${target}`);
  }

  const format = target.startsWith("windows-") ? "zip" : "tar";
  const assetName = `${tool.archivePrefix}${tool.version}-${rustTarget}.${format === "zip" ? "zip" : "tar.gz"}`;

  return {
    asset: {
      cacheName: tool.name,
      displayName: tool.displayName,
      executableNames: platform === "win32" ? [`${tool.name}.exe`] : [tool.name],
      version: tool.version,
      target,
      format,
    },
    url: `https://github.com/${tool.repo}/releases/download/${tool.tagPrefix}${tool.version}/${assetName}`,
  };
}
