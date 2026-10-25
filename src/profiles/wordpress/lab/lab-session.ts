import { randomBytes, randomUUID } from "node:crypto";

import type { WordPressLabHandle } from "./contract.js";
import type {
  DockerResult,
  LabDocker,
  RequireDocker,
  RunDocker,
  WordPressCommand,
} from "./lab-docker.js";

export const DATABASE_NAME = "wordpress";
export const READ_ONLY_DATABASE_USER = "wbh_reader";

export interface LabImages {
  readonly database: string;
  readonly wordpress: string;
  readonly wordpressCli: string;
  /** Playwright Chromium, used only by the Lab's own observer visits. */
  readonly browser: string;
  readonly recorder: string;
}

type Account = { readonly username: string; readonly password: string };
/** Docker objects the session creates, in the order `cleanup` removes containers. */
const CONTAINERS = ["wordpress", "database", "receiver", "recorder"] as const;
type CreatedResource = (typeof CONTAINERS)[number] | "volume" | "network";

/**
 * One provisioned Lab: its Docker object names, secrets, accounts and the
 * command runners bound to its network.
 * Everything a sibling module needs about a Lab comes from this object;
 * `index.ts` maps a `WordPressLabHandle` to its session and nothing else
 * holds Lab state.
 */
export class WordPressLabSession {
  readonly id: string;
  readonly network: string;
  readonly volume: string;
  readonly database: string;
  readonly wordpress: string;
  readonly recorder: string;
  /** Beacon receiver container; only the Lab reads what it logged. */
  readonly receiver: string;
  readonly databasePassword: string;
  readonly readerPassword: string;
  /** Rotated when handoff setup ends (#430); the Lab browser reads the current one. */
  adminPassword: string;
  readonly attackerAccounts: Readonly<{
    subscriber: Account;
    customer?: Account;
  }>;
  /** Verification-only browser accounts, never included in the attacker handle. */
  readonly victimAccounts: Readonly<{
    subscriber?: Account;
    customer?: Account;
  }>;
  readonly administratorSecondaryLocale?: string;
  readonly images: LabImages;
  readonly docker: RunDocker;
  readonly requireDocker: RequireDocker;
  /** Docker objects created so far; `cleanup` removes only these. */
  readonly created = new Set<CreatedResource>();
  receiverIp?: string;
  /** gVisor containers cannot use Docker's name resolution, so WordPress gets this address. */
  databaseIp?: string;
  #handle?: WordPressLabHandle;

  constructor(input: {
    readonly docker: LabDocker;
    readonly images: LabImages;
    readonly customerRole: boolean;
    readonly forVerification: boolean;
    readonly secondaryLocale?: string;
  }) {
    const id = randomUUID();
    const prefix = `wbh-${id}`;
    const subscriber = {
      username: `wbh-subscriber-${id.slice(0, 8)}`,
      password: randomUUID(),
    };
    const customer = input.customerRole
      ? { username: `wbh-customer-${id.slice(0, 8)}`, password: randomUUID() }
      : undefined;
    const victimSubscriber = input.forVerification
      ? {
          username: `wbh-victim-subscriber-${id.slice(0, 8)}`,
          password: randomUUID(),
        }
      : undefined;
    const victimCustomer =
      input.forVerification && input.customerRole
        ? {
            username: `wbh-victim-customer-${id.slice(0, 8)}`,
            password: randomUUID(),
          }
        : undefined;
    this.id = id;
    this.network = `${prefix}-net`;
    this.volume = `${prefix}-site`;
    this.database = `${prefix}-db`;
    this.wordpress = `${prefix}-wp`;
    this.recorder = `${prefix}-proxy`;
    this.receiver = `${prefix}-canary`;
    this.databasePassword = randomUUID();
    this.readerPassword = randomBytes(32).toString("hex");
    this.adminPassword = randomUUID();
    this.attackerAccounts = {
      subscriber,
      ...(customer === undefined ? {} : { customer }),
    };
    this.victimAccounts = {
      ...(victimSubscriber === undefined
        ? {}
        : { subscriber: victimSubscriber }),
      ...(victimCustomer === undefined ? {} : { customer: victimCustomer }),
    };
    if (input.secondaryLocale !== undefined)
      this.administratorSecondaryLocale = input.secondaryLocale;
    this.images = input.images;
    this.docker = input.docker.run;
    this.requireDocker = input.docker.require;
  }

  /** The handle issued for this Lab; set once by `bind` after provisioning. */
  get handle(): WordPressLabHandle {
    if (this.#handle === undefined)
      throw new Error("The Lab handle has not been issued");
    return this.#handle;
  }

  bind(handle: WordPressLabHandle): void {
    this.#handle = handle;
  }

  /** True only for the exact handle object this session issued. */
  owns(handle: WordPressLabHandle): boolean {
    return this.#handle === handle;
  }

  databaseAddress(): string {
    if (this.databaseIp === undefined)
      throw new Error("Lab database address is unavailable");
    return this.databaseIp;
  }

  wpCommand(
    args: readonly string[],
    environment: readonly string[] = [],
  ): readonly string[] {
    return [
      "run",
      "--rm",
      "--runtime=runsc",
      "--network",
      this.network,
      "--security-opt=no-new-privileges",
      // The Apache image owns the shared WordPress volume as UID/GID 33;
      // the CLI image's www-data is UID/GID 82 and cannot create uploads.
      "--user=33:33",
      ...environment.flatMap((entry) => ["--env", entry]),
      "--env",
      `WORDPRESS_DB_HOST=${this.databaseAddress()}`,
      "--env",
      "WORDPRESS_DB_NAME=wordpress",
      "--env",
      "WORDPRESS_DB_USER=root",
      "--env",
      `WORDPRESS_DB_PASSWORD=${this.databasePassword}`,
      "--volume",
      `${this.volume}:/var/www/html`,
      this.images.wordpressCli,
      "wp",
      ...args,
    ];
  }

  readonly wp: WordPressCommand = (
    args: readonly string[],
    environment: readonly string[] = [],
  ): Promise<DockerResult> =>
    this.requireDocker(this.wpCommand(args, environment));

  /** Removes what this session created; true when every removal succeeded. */
  async cleanup(): Promise<boolean> {
    const containers = CONTAINERS.filter((kind) => this.created.has(kind)).map(
      (kind) => this[kind],
    );
    let okay = true;
    for (const args of [
      ...(containers.length > 0 ? [["rm", "--force", ...containers]] : []),
      ...(this.created.has("volume")
        ? [["volume", "rm", "--force", this.volume]]
        : []),
      ...(this.created.has("network") ? [["network", "rm", this.network]] : []),
    ]) {
      try {
        if ((await this.docker(args)).exitCode !== 0) okay = false;
      } catch {
        okay = false;
      }
    }
    return okay;
  }
}
