import {
  DATABASE_NAME,
  READ_ONLY_DATABASE_USER,
  type WordPressLabSession,
} from "./lab-session.js";
import type { PreparedWordPressLab } from "./provision-input.js";
import {
  applyWordPressLabBaseline,
  readBackWordPressLabBaseline,
  removeBundledPlugins,
  WordPressLabBaselineMismatch,
} from "./baseline.js";

interface WordPressInitialization {
  readonly lab: WordPressLabSession;
  readonly prepared: PreparedWordPressLab;
}

async function installCore({
  lab,
  prepared,
}: WordPressInitialization): Promise<void> {
  if (prepared.coreVersion !== undefined) {
    const running = await lab.wp(["core", "version"]);
    if (running.stdout.trim() !== prepared.coreVersion)
      throw new Error("The Lab image runs another WordPress version");
  }
  await lab.wp([
    "core",
    "install",
    "--url=http://wordpress",
    `--title=${prepared.setup.siteTitle}`,
    "--admin_user=harness-admin",
    `--admin_password=${lab.adminPassword}`,
    "--admin_email=harness-admin@example.invalid",
    "--skip-email",
  ]);
}

async function installPlugins({
  lab,
  prepared,
}: WordPressInitialization): Promise<void> {
  for (const source of [...prepared.dependencies, prepared.target]) {
    await lab.requireDocker([
      "exec",
      lab.wordpress,
      "mkdir",
      "-p",
      `/var/www/html/wp-content/plugins/${source.slug}`,
    ]);
    await lab.requireDocker([
      "cp",
      `${source.directory}/.`,
      `${lab.wordpress}:/var/www/html/wp-content/plugins/${source.slug}`,
    ]);
    // Docker cp preserves modes from the host tree. A restrictive host umask
    // can leave the public plugin unreadable to WP-CLI's UID 33.
    await lab.requireDocker([
      "exec",
      "--user=root",
      lab.wordpress,
      "chmod",
      "-R",
      "a+rX",
      `/var/www/html/wp-content/plugins/${source.slug}`,
    ]);
    await lab.wp(["plugin", "activate", source.slug]);
  }
}

async function createAccounts({ lab }: WordPressInitialization): Promise<void> {
  const { subscriber, customer } = lab.attackerAccounts;
  const { subscriber: victimSubscriber, customer: victimCustomer } =
    lab.victimAccounts;
  await lab.wp([
    "user",
    "create",
    subscriber.username,
    `${subscriber.username}@example.invalid`,
    "--role=subscriber",
    `--user_pass=${subscriber.password}`,
  ]);
  if (customer !== undefined)
    await lab.wp([
      "user",
      "create",
      customer.username,
      `${customer.username}@example.invalid`,
      "--role=customer",
      `--user_pass=${customer.password}`,
    ]);
  if (victimSubscriber !== undefined)
    await lab.wp([
      "user",
      "create",
      victimSubscriber.username,
      `${victimSubscriber.username}@example.invalid`,
      "--role=subscriber",
      `--user_pass=${victimSubscriber.password}`,
    ]);
  if (victimCustomer !== undefined)
    await lab.wp([
      "user",
      "create",
      victimCustomer.username,
      `${victimCustomer.username}@example.invalid`,
      "--role=customer",
      `--user_pass=${victimCustomer.password}`,
    ]);
}

async function seedInitialPosts({
  lab,
  prepared,
}: WordPressInitialization): Promise<void> {
  const { setup } = prepared;
  if (setup.initialPosts.length === 0) return;
  // #718: an ordinary site has no author-less posts; seed them as the admin.
  const authorId = (
    await lab.wp(["user", "get", "harness-admin", "--field=ID"])
  ).stdout.trim();
  if (!/^[1-9][0-9]*$/.test(authorId))
    throw new Error("Lab administrator ID is unavailable for seed posts");
  for (const title of setup.initialPosts)
    await lab.wp([
      "post",
      "create",
      "--post_status=publish",
      `--post_title=${title}`,
      `--post_author=${authorId}`,
    ]);
}

/** Any failure while applying or reading back the baseline is the Lab's seed stage. */
async function asBaselineFailure(step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    if (error instanceof WordPressLabBaselineMismatch) throw error;
    throw new WordPressLabBaselineMismatch([
      `apply:${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        200,
      ),
    ]);
  }
}

/** Initialize the isolated WordPress site after all containers are healthy. */
export async function initializeWordPress(
  lab: WordPressLabSession,
  prepared: PreparedWordPressLab,
): Promise<void> {
  const input: WordPressInitialization = { lab, prepared };
  await installCore(input);
  const { baseline } = prepared;
  if (baseline !== undefined)
    await asBaselineFailure(() => removeBundledPlugins(lab, baseline));
  await installPlugins(input);
  // #699: the base environment goes on after the plugins and must read back.
  if (baseline !== undefined)
    await asBaselineFailure(async () => {
      await applyWordPressLabBaseline(lab, baseline);
      await readBackWordPressLabBaseline(lab, baseline, [
        ...prepared.dependencies.map((source) => source.slug),
        prepared.target.slug,
      ]);
    });
  await createAccounts(input);
  await seedInitialPosts(input);
}

/**
 * Grant SELECT on the whole site database (ADR 0049): a database-level grant
 * covers tables a plugin creates later in the Trial, which a per-table grant
 * at provision time would hide from `find` and `sql`. Still read-only.
 */
export async function grantReadOnlyDatabaseAccess(
  lab: WordPressLabSession,
): Promise<void> {
  await lab.requireDocker([
    "exec",
    lab.database,
    "mariadb",
    "--user=root",
    `--password=${lab.databasePassword}`,
    "--execute",
    [
      `CREATE USER '${READ_ONLY_DATABASE_USER}'@'%' IDENTIFIED BY '${lab.readerPassword}'`,
      `GRANT SELECT ON ${DATABASE_NAME}.* TO '${READ_ONLY_DATABASE_USER}'@'%'`,
      "FLUSH PRIVILEGES",
    ].join("; "),
  ]);
}
