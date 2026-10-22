// Cua-backed Local VM: OMB owns only the sandbox boundary; desktop automation is Cua Driver's (`cua-driver mcp` in the container).
import { CUA_DRIVER_VERSION, BASE_IMAGE_DIGEST, BASE_IMAGE, IMAGE_LAYER_VERSION, IMAGE_LAYER_LABEL, IMAGE, CONTAINER, MANAGED_LABEL, DRIVER_LABEL, BASE_IMAGE_LABEL, WORKSPACE_LABEL, TARGET_LABEL, VM_BROWSER_PROFILES_DIR, VM_FIREFOX_PROFILE_DIR, FIREFOX_PROFILE_LAYER, DISPLAY, CUA_SOCKET, CUA_EXECUTABLE, RUNTIMES, type Runtime, type LifecycleAction, MEMORY_BYTES, type LocalVmTarget, SHARED_LOCAL_VM_TARGET, managedImageDockerfile, containerRunArgs, baseImagePullArgs } from "./container-definition.ts";
export { CUA_DRIVER_VERSION, BASE_IMAGE_REPOSITORY, BASE_IMAGE_DIGEST, BASE_IMAGE, IMAGE_REPOSITORY, IMAGE_LAYER_VERSION, IMAGE_LAYER_LABEL, IMAGE, CONTAINER, MANAGED_LABEL, DRIVER_LABEL, BASE_IMAGE_LABEL, WORKSPACE_LABEL, TARGET_LABEL, VM_WORKSPACE_DIR, VM_BROWSER_PROFILES_DIR, VM_FIREFOX_PROFILE_DIR, FIREFOX_PROFILE_LAYER, DISPLAY, CUA_SOCKET, CUA_EXECUTABLE, type Runtime, type LifecycleAction, type LocalVmTarget, SHARED_LOCAL_VM_TARGET, perBotLocalVmTarget, poolLocalVmTarget, managedImageDockerfile, hostTimeZone, containerRunArgs, setupCommands } from "./container-definition.ts";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { augmentedPath, resolveCliSpawn } from "./env-path.ts";

import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { VM_WORKSPACE_GUEST, dockerPortsAreLocal, dockerViewerPort, applePortsAreLocal, appleViewerPort, dockerWorkspaceMountIsSafe, appleWorkspaceMountIsSafe, dockerSecurityIsHardened, podmanSecurityIsHardened } from "./container-safety.ts";
export { VM_WORKSPACE_GUEST } from "./container-safety.ts";
export { dockerSecurityIsHardened, podmanSecurityIsHardened } from "./container-safety.ts";

const run = promisify(execFile);
const SCREENSHOT_STATUS_TTL_MS = 10_000;

export type CommandRunner = (
  command: string,
  args: string[],
  timeout?: number,
) => Promise<{ stdout: string }>;

/** Only provisioning creates this durable directory; idle shutdown keeps it. */
export function localVmWorkspaceExists(target: LocalVmTarget): boolean {
  try {
    return lstatSync(target.workspaceDir, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
}

async function sh(cmd: string, args: string[], timeout = 8000): Promise<{ stdout: string }> {
  const resolved = resolveCliSpawn(cmd, args);
  const { stdout } = await run(resolved.command, resolved.args, {
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: augmentedPath() },
  });
  return { stdout };
}

async function installed(
  cmd: string,
  runner: CommandRunner,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    await runner(platform === "win32" ? "where.exe" : "/usr/bin/which", [cmd], 10_000);
    return true;
  } catch {
    return false;
  }
}

/** Pause between transient retries; tests swap it for an instant one. */
let probeSleep = (ms: number) =>
  process.env.VITEST ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, ms));
export function setProbeSleepForTests(sleep: (ms: number) => Promise<void>): void {
  probeSleep = sleep;
}

/** A busy host answers runtime calls slowly: retry a read a few times with backoff before believing it failed. */
async function retryRead<T>(read: () => Promise<T>, attempts = 3, baseDelayMs = 1500): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await read();
    } catch (error) {
      last = error;
      if (error instanceof NotTransient) throw error;
      if (attempt < attempts - 1) await probeSleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw last;
}

/** Thrown only when the driver answered with a different version, never for a slow or failed exec. */
class NotTransient extends Error {}
class DriverVersionMismatch extends NotTransient {}

export const CUA_VERSION_PROBE_TIMEOUT_MS = 25_000;

/** Reads the driver version, retrying empty output, timeouts and exec errors; reports "expected" only on a real mismatch. */
async function probeDriverVersion(runner: CommandRunner, runtime: Runtime, containerName: string): Promise<void> {
  const expected = `cua-driver ${CUA_DRIVER_VERSION}`;
  try {
    await retryRead(async () => {
      const version = await runner(runtime, cuaExecArgs(["--version"], { container: containerName }), CUA_VERSION_PROBE_TIMEOUT_MS);
      const answer = version.stdout.trim();
      if (!answer) throw new Error("empty version answer");
      if (answer !== expected) throw new DriverVersionMismatch(`expected ${expected}, found ${answer.slice(0, 80)}`);
    });
  } catch (error) {
    if (error instanceof DriverVersionMismatch) throw error;
    throw new Error("Cua Driver did not answer the version check yet (the host may be busy)");
  }
}

export interface ContainerRuntimeStatus {
  runtime: Runtime | null;
  available: Runtime[];
  daemonUp: boolean;
}

/** Inspects only the host runtime: never opens a container, calls Cua, or reads a screenshot. */
export async function containerRuntimeStatus(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
): Promise<ContainerRuntimeStatus> {
  // Podman is the supported Windows VM lane and owns the pinned image; Docker-first would pick an unrelated image store.
  const candidates: Runtime[] = platform === "win32"
    ? ["podman", "docker"]
    : RUNTIMES.filter((runtime) => runtime !== "container" || platform === "darwin");
  const present = await Promise.all(candidates.map((runtime) => installed(runtime, runner, platform)));
  const available = candidates.filter((_, index) => present[index]);
  const healthy = await Promise.all(
    available.map(async (candidate) => {
      try {
        const infoArgs = candidate === "container"
          ? ["system", "status"]
          : candidate === "podman"
            ? ["info", "--format", "json"]
            : ["info", "--format", "{{.ServerVersion}}"];
        // a daemon still starting after a boot answers slowly: give it time
        await runner(
          candidate,
          infoArgs,
          30_000,
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
  const healthyIndex = healthy.indexOf(true);
  return {
    runtime: healthyIndex >= 0 ? available[healthyIndex] : (available[0] ?? null),
    available,
    daemonUp: healthyIndex >= 0,
  };
}

export interface ContainerComputerStatus {
  platform: NodeJS.Platform;
  runtime: Runtime | null;
  available: Runtime[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  desktop_error: string | null;
  stopped_at?: string | null;
  /** A stopped desktop whose only problem is that it is stopped. */
  resumable: boolean;
  create_supported: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  image_id: string | null;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  target_key: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_port: number | null;
  viewer_url: string;
}

function emptyStatus(platform: NodeJS.Platform, target: LocalVmTarget): ContainerComputerStatus {
  return {
    platform,
    runtime: null,
    available: [],
    daemonUp: false,
    image: false,
    imageMatches: false,
    managed: false,
    container: "missing",
    network: "unknown",
    security: "unknown",
    persistence: "unknown",
    desktopReady: false,
    desktop_error: null,
    create_supported: true,
    resumable: false,
    ready: false,
    problem: "Install a supported container runtime first",
    image_ref: IMAGE,
    image_id: null,
    base_image_ref: BASE_IMAGE,
    driver_version: CUA_DRIVER_VERSION,
    container_name: target.containerName,
    target_key: target.key,
    workspace_path: target.workspaceDir,
    workspace_guest_path: VM_WORKSPACE_GUEST,
    viewer_port: target.viewerPort,
    viewer_url: target.viewerPort ? `http://127.0.0.1:${target.viewerPort}/vnc.html` : "",
  };
}

export function localVmRecreatableOnDemand(
  status: ContainerComputerStatus,
): status is ContainerComputerStatus & { runtime: Runtime } {
  return Boolean(status.runtime)
    && status.daemonUp
    && status.image
    && status.container === "missing"
    && status.create_supported;
}

/** A Local VM the Mac's restart left stopped: our own container, with the
 * desktop image prepared — "cannot safely resume" is what stands between it
 * and a turn. Recreating it (remove, then run) is what the person would do;
 * the server may do it on its own (index.ts readyLocalVmForTurn). The new
 * container gets today's hardened run settings whatever the old one had
 * (a stopped container does not show its effective security anyway), and
 * its durable folder is a host mount, so the bot's files stay. */
export function localVmRecreatableAfterStop(status: ContainerComputerStatus): boolean {
  return Boolean(status.runtime)
    && status.daemonUp
    && status.image
    && status.container === "stopped"
    && status.managed
    && status.create_supported;
}

/** Fails closed on fields a partial inspect left "unknown", which `statusProblem` alone would let through. */
export function localVmResumable(
  status: ContainerComputerStatus,
): status is ContainerComputerStatus & { runtime: Runtime } {
  return Boolean(status.runtime) && status.daemonUp && status.image && status.container === "stopped"
    && existingContainerProblem(status) === null
    && status.network === "loopback" && status.security === "hardened" && status.persistence === "durable";
}

export function localVmWakeAction(status: ContainerComputerStatus): "run" | "start" | null {
  if (localVmRecreatableOnDemand(status)) return "run";
  if (localVmResumable(status)) return "start";
  return null;
}

/** Auto attaches without a person only when ready, startable or recreatable; anything else stays the person's call. */
export function autoLocalVmAttachable(status: ContainerComputerStatus): boolean {
  return status.ready === true || localVmWakeAction(status) !== null;
}

function statusProblem(status: ContainerComputerStatus): string | null {
  if (!status.runtime) return "Install a supported container runtime first";
  if (!status.daemonUp) return `Start ${status.runtime} first`;
  if (!status.image) return `Prepare the Cua desktop image with Driver ${CUA_DRIVER_VERSION}`;
  if (status.container === "missing" && !status.create_supported) {
    return "Per-bot Local VMs require Docker or Podman because Apple container requires a fixed host port";
  }
  if (status.container === "missing") return "Create the Local VM";
  const existing = existingContainerProblem(status);
  if (existing) return existing;
  if (status.container === "stopped") return "The Local VM is stopped; start it to continue";
  if (status.desktop_error) return `The Local VM desktop failed to start: ${status.desktop_error}`;
  if (!status.desktopReady) return "The Local VM started, but Cua Driver is not ready yet";
  return null;
}

function existingContainerProblem(status: ContainerComputerStatus): string | null {
  if (!status.imageMatches) return "The existing Local VM uses an older desktop or Cua Driver; recreate it";
  if (!status.managed) return "The existing container was not created by OpenMausBot; recreate it";
  if (status.network === "unsafe") return "The existing Local VM exposes its viewer publicly; recreate it";
  if (status.security === "unsafe") return "The existing Local VM is missing safety limits; recreate it";
  if (status.persistence === "unsafe") return "The existing Local VM is missing its durable folder; recreate it";
  return null;
}

export function imageLabelsMatch(labels: Record<string, string> | undefined): boolean {
  return (
    labels?.[MANAGED_LABEL] === "1" &&
    labels?.[DRIVER_LABEL] === CUA_DRIVER_VERSION &&
    labels?.[BASE_IMAGE_LABEL] === BASE_IMAGE_DIGEST &&
    labels?.[IMAGE_LAYER_LABEL] === IMAGE_LAYER_VERSION
  );
}

/** Ownership ignores image/driver versions, so an older OMB container stays removable. */
function containerOwnershipLabelsMatch(
  labels: Record<string, string> | undefined,
  target: LocalVmTarget,
): boolean {
  return (
    labels?.[MANAGED_LABEL] === "1" &&
    labels?.[WORKSPACE_LABEL] === "1" &&
    (target.key === SHARED_LOCAL_VM_TARGET.key
      ? labels?.[TARGET_LABEL] === undefined || labels?.[TARGET_LABEL] === target.label
      : labels?.[TARGET_LABEL] === target.label)
  );
}

function normalizeImageId(id: string | undefined): string | null {
  return id?.trim().replace(/^sha256:/, "") || null;
}

function inspectedImage(stdout: string, runtime: Runtime): {
  labels: Record<string, string> | undefined;
  id: string | null;
} {
  const parsed = JSON.parse(stdout) as Array<{
    Id?: string;
    id?: string;
    Config?: { Labels?: Record<string, string> };
    config?: { Labels?: Record<string, string>; labels?: Record<string, string> };
    configuration?: { labels?: Record<string, string>; descriptor?: { digest?: string } };
    variants?: Array<{
      platform?: { os?: string; architecture?: string };
      config?: { config?: { Labels?: Record<string, string> } };
    }>;
  }>;
  const image = parsed[0];
  // Apple container puts image labels inside each platform variant; never accept another platform's or guess between several.
  const variants = runtime === "container" && Array.isArray(image?.variants)
    ? image.variants.filter(variant => variant?.platform?.os === "linux" && variant.platform.architecture === "arm64")
    : [];
  return {
    labels: runtime === "container"
      ? (variants.length === 1 ? variants[0]?.config?.config?.Labels : undefined)
      : image?.Config?.Labels ?? image?.config?.Labels ?? image?.config?.labels ?? image?.configuration?.labels,
    id: normalizeImageId(image?.Id ?? image?.id ?? image?.configuration?.descriptor?.digest),
  };
}

function viewerPassword(env: string[] | Record<string, string> | undefined): string | null {
  if (Array.isArray(env)) {
    return env.find((entry) => entry.startsWith("VNC_PW="))?.slice("VNC_PW=".length) || null;
  }
  return env?.VNC_PW || null;
}

function viewerUrl(password: string | null, port: number | null): string {
  if (!port) return "";
  const base = `http://127.0.0.1:${port}/vnc.html`;
  if (!password) return base;
  const fragment = new URLSearchParams({ autoconnect: "true", resize: "scale", password });
  return `${base}#${fragment.toString()}`;
}

export function cuaExecArgs(
  args: string[],
  options: { container?: string; interactive?: boolean } = {},
): string[] {
  return [
    "exec",
    ...(options.interactive ? ["-i"] : []),
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    "-e",
    `DISPLAY=${DISPLAY}`,
    "-e",
    "CUA_DRIVER_INSTALL_CHANNEL=python_package",
    "-e",
    "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
    options.container ?? CONTAINER,
    CUA_EXECUTABLE,
    ...args,
  ];
}

export async function containerComputerStatus(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
  options: { probeDesktop?: boolean } = {},
): Promise<ContainerComputerStatus> {
  const status = emptyStatus(platform, target);
  const runtimeStatus = await containerRuntimeStatus(runner, platform);
  status.available = runtimeStatus.available;
  status.runtime = runtimeStatus.runtime;
  status.daemonUp = runtimeStatus.daemonUp;
  status.create_supported = target.key === SHARED_LOCAL_VM_TARGET.key || status.runtime !== "container";
  if (!status.runtime || !status.daemonUp) {
    status.problem = statusProblem(status);
    return status;
  }

  try {
    const runtime = status.runtime;
    const { stdout } = await retryRead(() => runner(runtime, ["image", "inspect", IMAGE], 20_000));
    const image = inspectedImage(stdout, status.runtime);
    status.image = imageLabelsMatch(image.labels);
    status.image_id = image.id;
  } catch {
  }

  try {
    const runtime = status.runtime;
    const { stdout } = await retryRead(async () => {
      try {
        return await runner(runtime, ["inspect", target.containerName], 20_000);
      } catch (error) {
        // a missing container answers at once with "no such": that is the answer, not a slow host
        if (/no such|not found/i.test(String((error as { stderr?: unknown })?.stderr ?? (error as Error)?.message ?? ""))) {
          throw new NotTransient("missing");
        }
        throw error;
      }
    });
    if (status.runtime === "container") {
      const inspected = JSON.parse(stdout) as Array<{
        configuration?: {
          image?: string | { reference?: string; descriptor?: { digest?: string } };
          imageReference?: string;
          resources?: { cpus?: number; memoryInBytes?: number };
          publishedPorts?: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }>;
          environment?: string[] | Record<string, string>;
          labels?: Record<string, string>;
          mounts?: Array<{ source?: string; destination?: string; options?: string[] }>;
        };
        status?: { state?: string };
      }>;
      const detail = inspected[0];
      status.container = detail?.status?.state === "running" ? "running" : "stopped";
      status.network = applePortsAreLocal(detail?.configuration?.publishedPorts) ? "loopback" : "unsafe";
      status.viewer_port = appleViewerPort(detail?.configuration?.publishedPorts, target.viewerPort);
      const appleImage =
        typeof detail?.configuration?.image === "string"
          ? detail.configuration.image
          : detail?.configuration?.image?.reference ?? detail?.configuration?.imageReference;
      const appleImageId =
        typeof detail?.configuration?.image === "object"
          ? normalizeImageId(detail.configuration.image.descriptor?.digest)
          : null;
      status.imageMatches =
        appleImage === IMAGE && status.image_id !== null && appleImageId === status.image_id;
      status.managed = containerOwnershipLabelsMatch(detail?.configuration?.labels, target);
      status.persistence = appleWorkspaceMountIsSafe(detail?.configuration?.mounts, platform, target.workspaceDir)
        ? "durable"
        : "unsafe";
      const resources = detail?.configuration?.resources;
      status.security =
        (resources?.memoryInBytes ?? 0) >= MEMORY_BYTES && resources?.cpus === 2 ? "hardened" : "unsafe";
      status.viewer_url = viewerUrl(viewerPassword(detail?.configuration?.environment), status.viewer_port);
    } else {
      const inspected = JSON.parse(stdout) as Array<{
        Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
        HostConfig?: DockerHardeningConfig & {
          PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
        };
        NetworkSettings?: {
          Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
        };
        Mounts?: Array<{
          Type?: string;
          Source?: string;
          Destination?: string;
          RW?: boolean;
        }>;
        EffectiveCaps?: string[];
        BoundingCaps?: string[];
        State?: { Running?: boolean; FinishedAt?: string };
        Image?: string;
      }>;
      const detail = inspected[0];
      status.container = detail?.State?.Running ? "running" : "stopped";
      status.stopped_at = status.container === "stopped" ? detail?.State?.FinishedAt ?? null : null;
      status.network = dockerPortsAreLocal(detail?.HostConfig?.PortBindings) ? "loopback" : "unsafe";
      status.viewer_port = dockerViewerPort(detail?.NetworkSettings?.Ports, target.viewerPort);
      status.imageMatches =
        detail?.Config?.Image === IMAGE &&
        imageLabelsMatch(detail?.Config?.Labels) &&
        status.image_id !== null &&
        normalizeImageId(detail?.Image) === status.image_id;
      status.managed = containerOwnershipLabelsMatch(detail?.Config?.Labels, target);
      status.persistence = dockerWorkspaceMountIsSafe(
        detail?.Mounts,
        platform,
        target.workspaceDir,
        status.runtime,
      ) ? "durable" : "unsafe";
      status.security = (
        status.runtime === "podman"
          ? podmanSecurityIsHardened(detail?.HostConfig, detail?.EffectiveCaps, detail?.BoundingCaps)
          : dockerSecurityIsHardened(detail?.HostConfig)
      ) ? "hardened" : "unsafe";
      status.viewer_url = viewerUrl(viewerPassword(detail?.Config?.Env), status.viewer_port);
    }
  } catch {
  }

  const canProbe = options.probeDesktop !== false &&
    status.container === "running" &&
    status.imageMatches &&
    status.managed &&
    status.network === "loopback" &&
    status.security === "hardened" &&
    status.persistence === "durable";
  if (canProbe) {
    try {
      await probeDriverVersion(runner, status.runtime, target.containerName);
      await runner(status.runtime, cuaExecArgs(["status", "--socket", CUA_SOCKET], { container: target.containerName }), 8000);
      const health = await runner(
        status.runtime,
        cuaExecArgs(["call", "health_report", "{}", "--socket", CUA_SOCKET], { container: target.containerName }),
        15_000,
      );
      const report = JSON.parse(health.stdout) as { schema_version?: string; overall?: string; checks?: unknown[] };
      if (
        report.schema_version !== "1" ||
        !Array.isArray(report.checks) ||
        (report.overall !== "ok" && report.overall !== "degraded")
      ) {
        throw new Error(`Cua health report is ${report.overall ?? "invalid"}`);
      }
      const readinessShot = "/tmp/openmausbot-readiness.png";
      await runner(
        status.runtime,
        cuaExecArgs([
          "call",
          "get_desktop_state",
          "{}",
          "--socket",
          CUA_SOCKET,
          "--screenshot-out-file",
          readinessShot,
        ], { container: target.containerName }),
        20_000,
      );
      const captured = await runner(
        status.runtime,
        ["exec", target.containerName, "base64", "-w0", readinessShot],
        20_000,
      );
      if (!wholeScreenshot(Buffer.from(captured.stdout.trim(), "base64")).ok) {
        throw new Error("Cua Driver returned an incomplete readiness screenshot");
      }
      status.desktopReady = true;
    } catch (error) {
      status.desktop_error = error instanceof Error ? error.message.slice(0, 320) : null;
      try {
        const errorLog = await runner(
          status.runtime,
          ["exec", target.containerName, "tail", "-n", "4", "/var/log/supervisor/cua-driver.error.log"],
          4000,
        );
        status.desktop_error =
          errorLog.stdout.replace(/\s+/g, " ").trim().slice(0, 320) ||
          status.desktop_error;
      } catch {
      }
    }
  }

  status.problem = statusProblem(status);
  status.ready = status.problem === null;
  status.resumable = localVmResumable(status);
  return status;
}

export interface DockerHardeningConfig {
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
  PidsLimit?: number | null;
  CapDrop?: string[] | null;
  CapAdd?: string[] | null;
  Privileged?: boolean;
  PidMode?: string;
  IpcMode?: string;
  UTSMode?: string;
  ShmSize?: number;
  Devices?: unknown[] | null;
  DeviceRequests?: unknown[] | null;
  SecurityOpt?: string[] | null;
  UsernsMode?: string;
  CgroupnsMode?: string;
  OomKillDisable?: boolean | null;
  AutoRemove?: boolean;
  RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
}

async function ensureVmWorkspace(platform: NodeJS.Platform, target: LocalVmTarget): Promise<void> {
  await mkdir(target.workspaceDir, { recursive: true, mode: 0o700 });
  if (platform !== "win32") await chmod(target.workspaceDir, 0o700);
}

async function prepareManagedImage(runtime: Runtime, runner: CommandRunner): Promise<void> {
  await runner(runtime, baseImagePullArgs(runtime), 10 * 60_000);
  const context = await mkdtemp(join(tmpdir(), "openmausbot-cua-image-"));
  try {
    await writeFile(join(context, "Dockerfile"), managedImageDockerfile(), { mode: 0o600 });
    await runner(runtime, ["build", "-t", IMAGE, context], 10 * 60_000);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

export type FirefoxProfileRescue =
  | { kind: "copied" }
  | { kind: "skipped"; reason: "current-layer" | "already-durable" | "no-profile" | "unsupported-runtime" };

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0;
  } catch {
    return false;
  }
}

function containerLayer(stdout: string, runtime: Runtime): number | null {
  try {
    const parsed = JSON.parse(stdout) as Array<{
      Config?: { Labels?: Record<string, string> };
      configuration?: { labels?: Record<string, string> };
    }>;
    const labels = runtime === "container" ? parsed[0]?.configuration?.labels : parsed[0]?.Config?.Labels;
    const value = Number.parseInt(labels?.[IMAGE_LAYER_LABEL] ?? "", 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function missingInContainer(error: unknown): boolean {
  const failure = error as { stderr?: unknown; message?: unknown };
  const text = `${typeof failure?.stderr === "string" ? failure.stderr : ""} ${typeof failure?.message === "string" ? failure.message : ""}`;
  return /could not find the file|no such file or directory|no such container:path/i.test(text);
}

/**
 * Before layer 6, Firefox kept its profile (and so every signed-in session) in the container's own ~/.mozilla, which a
 * remove would destroy. Copy it into the durable folder first, through a staging directory renamed into place, but only
 * when the durable Firefox profile is still empty: a profile already there (or one a bot made beside it, such as
 * firefox-qa) is never overwritten. Nothing secret is read: the files are copied byte for byte by the runtime.
 */
export async function rescueFirefoxProfile(
  runtime: Runtime,
  target: LocalVmTarget,
  runner: CommandRunner = sh,
  running = false,
): Promise<FirefoxProfileRescue> {
  if (runtime === "container") return { kind: "skipped", reason: "unsupported-runtime" };
  const { stdout } = await runner(runtime, ["inspect", target.containerName], 8_000);
  const layer = containerLayer(stdout, runtime);
  if (layer !== null && layer >= FIREFOX_PROFILE_LAYER) return { kind: "skipped", reason: "current-layer" };
  const profiles = join(target.workspaceDir, VM_BROWSER_PROFILES_DIR);
  const durable = join(profiles, VM_FIREFOX_PROFILE_DIR);
  if (await directoryHasEntries(durable)) return { kind: "skipped", reason: "already-durable" };
  if (running) {
    // Let Firefox write its session and cookies out before the copy; the container is about to go anyway.
    await runner(runtime, [
      "exec", "-u", "cua", target.containerName, "sh", "-c",
      "pkill -TERM -x firefox-esr 2>/dev/null || pkill -TERM -x firefox 2>/dev/null || true; " +
        "for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -x firefox-esr >/dev/null 2>&1 || pgrep -x firefox >/dev/null 2>&1 || break; sleep 0.5; done",
    ], 15_000).catch(() => null);
  }
  await mkdir(profiles, { recursive: true, mode: 0o700 });
  const staging = join(profiles, `.mozilla-rescue-${randomBytes(6).toString("hex")}`);
  try {
    try {
      await runner(runtime, ["cp", `${target.containerName}:/home/cua/.mozilla/.`, staging], 5 * 60_000);
    } catch (error) {
      if (missingInContainer(error)) return { kind: "skipped", reason: "no-profile" };
      throw error;
    }
    if (!(await directoryHasEntries(staging))) return { kind: "skipped", reason: "no-profile" };
    // A durable profile may have appeared meanwhile (another action); never replace it.
    if (await directoryHasEntries(durable)) return { kind: "skipped", reason: "already-durable" };
    await rmdir(durable).catch(() => undefined);
    await rename(staging, durable);
    await chmod(durable, 0o700).catch(() => undefined);
    return { kind: "copied" };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function containerComputerAction(
  action: LifecycleAction,
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
  options: { preserveBrowserProfile?: boolean } = {},
): Promise<ContainerComputerStatus> {
  if (runner === sh && platform === process.platform) screenshotStatusCache.delete(target.key);
  const before = await containerComputerStatus(runner, platform, target);
  const runtime = before.runtime;
  if (!runtime) throw Object.assign(new Error(before.problem ?? "No container runtime is installed"), { status: 409 });
  if (!before.daemonUp) throw Object.assign(new Error(before.problem ?? `${runtime} is not running`), { status: 409 });

  if (action === "run" && before.container !== "missing") {
    throw Object.assign(new Error("A Local VM already exists; remove it before creating a replacement"), { status: 409 });
  }
  if (action === "run" && !before.image) {
    throw Object.assign(new Error("Prepare the Cua desktop image before creating the Local VM"), { status: 409 });
  }
  if (action === "run" && !before.create_supported) {
    throw Object.assign(new Error(before.problem ?? "This runtime cannot create a per-bot Local VM"), { status: 409 });
  }
  if (action === "start" && !localVmResumable(before)) {
    throw Object.assign(new Error(before.problem ?? "The Local VM is not stopped"), { status: 409 });
  }
  if (action === "stop" && before.container !== "running") {
    throw Object.assign(new Error("The Local VM is not running"), { status: 409 });
  }
  if (action === "remove" && before.container === "missing") return before;
  if (action === "remove" && !before.managed) {
    throw Object.assign(
      new Error(
        `The existing container named ${target.containerName} was not created by OpenMausBot; remove it manually in ${runtime}`,
      ),
      { status: 409 },
    );
  }

  if (action === "remove" && before.managed && options.preserveBrowserProfile !== false) {
    try {
      const rescued = await rescueFirefoxProfile(runtime, target, runner, before.container === "running");
      if (rescued.kind === "copied") console.log(`[local-vm] ${target.key}: saved the Firefox profile into the durable folder before removing`);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw Object.assign(
        new Error(`Could not save this Local VM's Firefox profile (its signed-in sessions) before removing it, so nothing was removed: ${why.slice(0, 200)}`),
        { status: 409 },
      );
    }
  }

  if (action === "pull") {
    await prepareManagedImage(runtime, runner);
  } else {
    if (action === "run") await ensureVmWorkspace(platform, target);
    const args =
      action === "run"
        ? containerRunArgs(runtime, randomBytes(6).toString("base64url"), target)
        : action === "remove"
          ? ["rm", runtime === "container" ? "--force" : "-f", target.containerName]
          : [action, target.containerName];
    await runner(runtime, args, 2 * 60_000);
  }
  return containerComputerStatus(runner, platform, target);
}

export async function containerComputerExists(
  runtime: Runtime,
  target: LocalVmTarget,
  runner: CommandRunner = sh,
): Promise<boolean> {
  try {
    await runner(runtime, ["inspect", target.containerName], 8_000);
    return true;
  } catch {
    return false;
  }
}

export type ScreenshotCheck = { ok: boolean; mime: "image/png" | "image/jpeg" };

/** A truncated base64 transfer must never become a "successful" preview frame. */
export function wholeScreenshot(bytes: Buffer): ScreenshotCheck {
  if (bytes.length < 512) return { ok: false, mime: "image/png" };
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (png) {
    return {
      ok: bytes.subarray(Math.max(0, bytes.length - 12)).includes(Buffer.from("IEND", "ascii")),
      mime: "image/png",
    };
  }
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  return {
    ok: jpeg && bytes.subarray(Math.max(0, bytes.length - 32)).includes(Buffer.from([0xff, 0xd9])),
    mime: "image/jpeg",
  };
}

export async function containerComputerFrame(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<{ png: string; format: "png" | "jpeg" }> {
  const cacheable = runner === sh && platform === process.platform;
  const now = Date.now();
  const cached = screenshotStatusCache.get(target.key);
  const status =
    cacheable && cached && cached.expiresAt > now
      ? cached.status
      : await containerComputerStatus(runner, platform, target);
  if (!status.ready || !status.runtime) {
    if (cacheable) screenshotStatusCache.delete(target.key);
    throw Object.assign(new Error(status.problem ?? "The Local VM is not ready"), { status: 409 });
  }
  if (cacheable) screenshotStatusCache.set(target.key, { status, expiresAt: now + SCREENSHOT_STATUS_TTL_MS });
  try {
    const screenshot = "/tmp/openmausbot-preview.png";
    await runner(
      status.runtime,
      cuaExecArgs([
        "call",
        "get_desktop_state",
        "{}",
        "--socket",
        CUA_SOCKET,
        "--screenshot-out-file",
        screenshot,
      ], { container: target.containerName }),
      30_000,
    );
    const { stdout } = await runner(
      status.runtime,
      ["exec", target.containerName, "base64", "-w0", screenshot],
      30_000,
    );
    const data = stdout.trim();
    const checked = wholeScreenshot(Buffer.from(data, "base64"));
    if (!checked.ok) {
      throw Object.assign(new Error("Cua Driver returned an incomplete screenshot"), { status: 502 });
    }
    return { png: data, format: checked.mime === "image/jpeg" ? "jpeg" : "png" };
  } catch (error) {
    if (cacheable) screenshotStatusCache.delete(target.key);
    throw error;
  }
}

export async function containerComputerScreenshot(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<string> {
  const { png, format } = await containerComputerFrame(runner, platform, target);
  return `data:image/${format};base64,${png}`;
}

const screenshotStatusCache = new Map<
  string,
  { status: ContainerComputerStatus; expiresAt: number }
>();

const containerMcpPath = SPAWNED_PROXIES.containerMcp;

export interface ContainerExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

type ContainerExecRunner = (
  command: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

const EXEC_DEFAULT_SECONDS = 60;
const EXEC_MAX_SECONDS = 300;
const EXEC_OUTPUT_LIMIT = 20_000;

export function clipExecOutput(text: string, limit = EXEC_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit / 5);
  return `${text.slice(0, head)}\n… ${text.length - limit} characters omitted …\n${text.slice(text.length - (limit - head))}`;
}

const defaultExecRunner: ContainerExecRunner = async (command, args, options) => {
  const resolved = resolveCliSpawn(command, args);
  try {
    const { stdout, stderr } = await run(resolved.command, resolved.args, {
      timeout: options.timeout,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PATH: augmentedPath() },
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: unknown; killed?: boolean; message?: string };
    if (typeof failure.code === "number") {
      return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code };
    }
    throw Object.assign(new Error(failure.killed ? "the command client timed out" : failure.message ?? "could not run the command"), { status: 502 });
  }
};

/** The limit is enforced inside the container, so a runaway process is really stopped. */
export async function containerExec(
  target: LocalVmTarget,
  command: string,
  options: { timeoutSeconds?: number; runtime?: Runtime; exec?: ContainerExecRunner } = {},
): Promise<ContainerExecResult> {
  if (!command.trim()) throw Object.assign(new Error("command is required"), { status: 400 });
  if (command.length > 20_000) throw Object.assign(new Error("command is too long"), { status: 400 });
  if (options.timeoutSeconds !== undefined && !Number.isFinite(options.timeoutSeconds)) {
    throw Object.assign(new Error("timeout_seconds must be finite"), { status: 400 });
  }
  const runtime = options.runtime ?? (await containerRuntimeStatus()).runtime;
  if (!runtime) throw Object.assign(new Error("No container runtime is available for the Local VM"), { status: 409 });
  const seconds = Math.min(Math.max(Math.floor(options.timeoutSeconds ?? EXEC_DEFAULT_SECONDS), 1), EXEC_MAX_SECONDS);
  const result = await (options.exec ?? defaultExecRunner)(
    runtime,
    [
      "exec",
      "-u", "cua",
      "-w", VM_WORKSPACE_GUEST,
      "-e", "HOME=/home/cua",
      "-e", `DISPLAY=${DISPLAY}`,
      target.containerName,
      "timeout", "-k", "5", String(seconds),
      "sh", "-lc", command,
    ],
    { timeout: (seconds + 20) * 1000 },
  );
  const timedOut = result.code === 124 || result.code === 137;
  return { exitCode: result.code, stdout: clipExecOutput(result.stdout), stderr: clipExecOutput(result.stderr), timedOut };
}

type ContainerMcpLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function containerComputerMcp(
  runtime: Runtime,
  control?: { url: string; token: string },
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): ContainerMcpLaunch {
  return {
    command: process.execPath,
    args: [containerMcpPath, runtime, target.containerName, CUA_SOCKET],
    // The control pair rides in env, not argv, which `ps` shows for the bridge's whole life.
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(control ? { OMB_CONTROL_URL: control.url, OMB_CONTROL_TOKEN: control.token } : {}),
    },
  };
}
