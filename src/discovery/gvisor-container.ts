import { isAbsolute } from "node:path";
import { isIP } from "node:net";

import {
  runNativeModelProcess,
  type NativeModelProcessResult,
} from "../infrastructure/native-model-process.js";
import type { ProviderCredentialEgressGrant } from "./provider-credential-egress-broker.js";
import { BROKER_TLS_HOSTNAME } from "./provider-credential-proxy.js";

/**
 * Invariant 2 for every discovery runtime, in one place: the `docker run`
 * admission of an agent container. Each runtime's sandbox passes only what
 * differs (image, entrypoint, mounts, environment, memory, CPUs); the runsc
 * runtime, the non-root user, the read-only root, the dropped capabilities,
 * the network (none, or the grant's internal network), the Lab host names and
 * the broker endpoint are decided here. There is no weaker fallback.
 */

/** Runs the docker client; `hostEnvironment` values reach the client by name, never argv. */
export type DockerRun = (
  args: readonly string[],
  stdin: string | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
  hostEnvironment?: Readonly<Record<string, string>>,
) => Promise<NativeModelProcessResult>;

/** The docker client sees only these variables of the host, plus `hostEnvironment`. */
export function gvisorDockerClient(options: {
  readonly dockerExecutablePath: string;
  readonly workingDirectory: string;
  readonly maxOutputBytes: number;
  /** Redacted from the client's output. */
  readonly secret?: string;
}): DockerRun {
  const { secret } = options;
  return (args, stdin, timeoutMs, signal, hostEnvironment) =>
    runNativeModelProcess({
      executablePath: options.dockerExecutablePath,
      args,
      ...(stdin === undefined ? {} : { stdin }),
      workingDirectory: options.workingDirectory,
      environment: {
        PATH: process.env.PATH,
        LANG: "C",
        LC_ALL: "C",
        TZ: "UTC",
        ...hostEnvironment,
      },
      timeoutMs,
      ...(signal === undefined ? {} : { signal }),
      maxOutputBytes: options.maxOutputBytes,
      redact: (text) =>
        secret === undefined ? text : text.split(secret).join("[REDACTED]"),
    });
}

/** What every sandbox reports; the runtimes refuse any other value. */
export const GVISOR_ISOLATION = {
  backend: "gvisor",
  runtime: "runsc",
  fallbackUsed: false,
} as const;

export function isGvisorIsolation(isolation: {
  readonly backend: string;
  readonly runtime: string;
  readonly fallbackUsed: boolean;
}): boolean {
  return (
    isolation.backend === GVISOR_ISOLATION.backend &&
    isolation.runtime === GVISOR_ISOLATION.runtime &&
    isolation.fallbackUsed === GVISOR_ISOLATION.fallbackUsed
  );
}

/** `uid:gid` of this process; `sandbox` names the caller in the error. */
export function nonRootContainerUser(sandbox: string): string {
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    process.getuid() <= 0 ||
    process.getgid() <= 0
  )
    throw new Error(`A non-root host user is required for the ${sandbox}`);
  return `${process.getuid()}:${process.getgid()}`;
}

export type ContainerHost = { readonly name: string; readonly ipv4: string };

/** The Lab endpoints a container may resolve besides the broker. */
export interface LabHosts {
  readonly labHost?: ContainerHost;
  readonly databaseHost?: ContainerHost;
  /** The exploration Lab's control endpoint (ADR 0003, 2026-10-25 addendum). */
  readonly controlHost?: ContainerHost;
}

const hostName = /^[a-z0-9][a-z0-9-]{0,62}$/;
const dockerName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

function admittedHost(host: ContainerHost): boolean {
  return hostName.test(host.name) && isIP(host.ipv4) === 4;
}

/**
 * The database and control hosts come only with a Lab host, and the three
 * names are distinct, so no name can shadow the site the agent attacks.
 */
export function admittedLabHosts(hosts: LabHosts): boolean {
  const { labHost, databaseHost, controlHost } = hosts;
  return (
    (labHost === undefined || admittedHost(labHost)) &&
    (databaseHost === undefined ||
      (labHost !== undefined &&
        admittedHost(databaseHost) &&
        databaseHost.name !== labHost.name)) &&
    (controlHost === undefined ||
      (labHost !== undefined &&
        admittedHost(controlHost) &&
        controlHost.name !== labHost.name &&
        controlHost.name !== databaseHost?.name))
  );
}

/** A docker network or container name. */
export function admittedDockerName(name: string): boolean {
  return dockerName.test(name);
}

/**
 * Why a grant cannot be used from a container, or undefined. The broker is
 * plain HTTP on an IPv4 address at port 8080, or the pinned TLS name with its
 * address and CA; the container holds only a Trial-scoped bearer token.
 */
export function brokerGrantFault(
  grant: ProviderCredentialEgressGrant,
): "address" | "authorization" | undefined {
  const { tls } = grant;
  if (
    tls === undefined
      ? !/^http:\/\/(?:\d{1,3}\.){3}\d{1,3}:8080$/.test(grant.baseUrl)
      : tls.hostname !== BROKER_TLS_HOSTNAME ||
        grant.baseUrl !== `https://${BROKER_TLS_HOSTNAME}:8080` ||
        isIP(tls.address) !== 4 ||
        !/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+-----END CERTIFICATE-----\n$/.test(
          tls.caPem,
        )
  )
    return "address";
  if (!/^Bearer [A-Za-z0-9_-]{32,}$/.test(grant.authorization))
    return "authorization";
  return undefined;
}

/** One runtime-specific option, rendered in the order given. */
export type ContainerOption =
  | {
      readonly mount: {
        readonly source: string;
        readonly target: string;
        readonly readonly: boolean;
      };
    }
  | { readonly workdir: string }
  /** Without `value`, the docker client passes its own variable on by name. */
  | { readonly env: string; readonly value?: string }
  /** A host outside the Lab, such as the broker's TLS name; dotted names allowed. */
  | { readonly host: ContainerHost };

/** A bind mount shared by both runtimes; admission remains in `gvisorRunArgs`. */
export function containerMount(
  source: string,
  target: string,
  readonly: boolean,
): ContainerOption {
  return { mount: { source, target, readonly } };
}

export interface GvisorContainer {
  readonly user: string;
  readonly memoryMiB: number;
  /** Per runtime: Codex 1, Claude 2 (the values before candidate 9). */
  readonly cpus: number;
  readonly image: string;
  readonly entrypoint: string;
  readonly command: readonly string[];
  /** Absent: a probe with `--network=none` and nothing mounted. */
  readonly agent?: {
    readonly name: string;
    readonly network: string;
    readonly hosts: LabHosts;
    readonly options: readonly ContainerOption[];
  };
}

const unsafeMountPath = /[,:\n\0]/;

function renderOption(option: ContainerOption): string {
  if ("mount" in option) {
    const { source, target, readonly } = option.mount;
    for (const [kind, path] of [
      ["source", source],
      ["target", target],
    ] as const)
      if (!isAbsolute(path) || unsafeMountPath.test(path))
        throw new Error(
          `gVisor container mount ${kind} ${JSON.stringify(path)} is not admitted`,
        );
    return `--mount=type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;
  }
  if ("workdir" in option) {
    if (!isAbsolute(option.workdir) || /[\n\0]/.test(option.workdir))
      throw new Error("gVisor container workdir is not admitted");
    return `--workdir=${option.workdir}`;
  }
  if ("env" in option) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(option.env) ||
      (option.value !== undefined && /[\n\0]/.test(option.value))
    )
      throw new Error("gVisor container environment is not admitted");
    return option.value === undefined
      ? `--env=${option.env}`
      : `--env=${option.env}=${option.value}`;
  }
  return renderHost(option.host);
}

function renderHost(host: ContainerHost): string {
  if (
    !/^[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62})*$/.test(
      host.name,
    ) ||
    isIP(host.ipv4) !== 4
  )
    throw new Error("gVisor container host is not admitted");
  return `--add-host=${host.name}:${host.ipv4}`;
}

/** The complete `docker run` argument list; throws on anything outside invariant 2. */
export function gvisorRunArgs(container: GvisorContainer): string[] {
  if (
    !/^[1-9]\d*:[1-9]\d*$/.test(container.user) ||
    !Number.isSafeInteger(container.memoryMiB) ||
    container.memoryMiB <= 0 ||
    !Number.isSafeInteger(container.cpus) ||
    container.cpus <= 0 ||
    !/^[a-z][a-z0-9-]*$/.test(container.entrypoint) ||
    !/^(?:sha256:[a-f0-9]{64}|[^\s@]+@sha256:[a-f0-9]{64})$/.test(
      container.image,
    )
  )
    throw new Error("gVisor container is not admitted");
  const base = [
    "run",
    "--rm",
    "--pull=never",
    "--runtime=runsc",
    `--user=${container.user}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=256",
    `--memory=${container.memoryMiB}m`,
    `--cpus=${container.cpus}`,
    "--tmpfs=/tmp:rw,nosuid,nodev,size=256m",
  ];
  const tail = [
    `--entrypoint=${container.entrypoint}`,
    container.image,
    ...container.command,
  ];
  const { agent } = container;
  if (agent === undefined) return [...base, "--network=none", ...tail];
  if (
    !admittedDockerName(agent.name) ||
    !admittedDockerName(agent.network) ||
    !admittedLabHosts(agent.hosts)
  )
    throw new Error("gVisor container is not admitted");
  const { labHost, databaseHost, controlHost } = agent.hosts;
  return [
    ...base,
    `--name=${agent.name}`,
    // The prompt arrives on stdin.
    "--interactive",
    `--network=${agent.network}`,
    ...[labHost, databaseHost, controlHost].flatMap((host) =>
      host === undefined ? [] : [renderHost(host)],
    ),
    ...agent.options.map(renderOption),
    ...tail,
  ];
}
