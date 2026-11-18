import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";


interface ProcessEntry {
  ProcessId?: number;
  ExecutablePath?: string | null;
}


function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function normalizeWinPath(targetPath: string): string {
  return path.resolve(targetPath).replace(/[\\/]+$/, "").toLowerCase();
}


function queryAntigravityProcesses(): ProcessEntry[] {
  if (process.platform !== "win32") {
    return [];
  }

  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='Antigravity.exe'\" " +
    "| Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress";

  let stdout: string;
  try {
    stdout = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  } catch (error) {
    throw new Error(
      `Failed to query running Antigravity.exe processes: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!stdout) {
    return [];
  }

  const parsed = JSON.parse(stdout) as ProcessEntry | ProcessEntry[];
  return Array.isArray(parsed) ? parsed : [parsed];
}


function findMatchingPids(appDir: string): number[] {
  const expectedExe = normalizeWinPath(path.join(appDir, "Antigravity.exe"));
  const entries = queryAntigravityProcesses();
  const pids: number[] = [];

  for (const entry of entries) {
    if (typeof entry.ProcessId !== "number" || !entry.ExecutablePath) {
      continue;
    }

    if (normalizeWinPath(entry.ExecutablePath) === expectedExe) {
      pids.push(entry.ProcessId);
    }
  }

  return pids;
}


function runKillPids(pids: number[], force: boolean): void {
  if (process.platform !== "win32" || pids.length === 0) {
    return;
  }

  for (const pid of pids) {
    const args = force ? ["/F", "/PID", String(pid), "/T"] : ["/PID", String(pid), "/T"];
    try {
      execFileSync("taskkill", args, {
        stdio: ["ignore", "ignore", "ignore"]
      });
    } catch {
    }
  }
}


export function isAntigravityRunning(appDir: string): boolean {
  return findMatchingPids(appDir).length > 0;
}


export async function ensureAntigravityStopped(
  appDir: string,
  forceKill: boolean,
  actionName: string
): Promise<void> {
  let pids = findMatchingPids(appDir);
  if (pids.length === 0) {
    return;
  }

  if (!forceKill) {
    throw new Error(
      `Antigravity.exe under ${appDir} is currently running. Close it completely before ${actionName}, or rerun with --kill from an external terminal.`
    );
  }

  console.log(`Closing Antigravity.exe (${pids.length} process(es)) under ${appDir}...`);
  runKillPids(pids, false);

  for (let i = 0; i < 6; i += 1) {
    await sleepMs(300);
    pids = findMatchingPids(appDir);
    if (pids.length === 0) {
      await sleepMs(300);
      return;
    }
  }

  runKillPids(pids, true);
  for (let i = 0; i < 15; i += 1) {
    await sleepMs(300);
    pids = findMatchingPids(appDir);
    if (pids.length === 0) {
      await sleepMs(300);
      return;
    }
  }

  throw new Error(`Timed out waiting for Antigravity.exe under ${appDir} to exit.`);
}


export function relaunchAntigravity(appDir: string): void {
  if (process.platform !== "win32") {
    return;
  }

  const exePath = path.join(appDir, "Antigravity.exe");
  if (!fs.existsSync(exePath)) {
    return;
  }

  const child = spawn(exePath, [], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  console.log(`Launched ${exePath}`);
}
