import {
  DATABASE_NAME,
  READ_ONLY_DATABASE_USER,
  type WordPressLabSession,
} from "./lab-session.js";
import type { PreparedWordPressLab } from "./provision-input.js";

/** Profile-owned TranslatePress locale setup (`lab.translatePress`). Lab setup data, never discovery input. */
function translatePressLocaleSetupScript(locale: string): string {
  return `$settings=get_option("trp_settings"); if(!is_array($settings)) exit(1); $base=$settings["default-language"] ?? "en_US"; $secondary="${locale}"; $settings["translation-languages"]=array_values(array_unique([$base,$secondary])); $settings["publish-languages"]=array_values(array_unique([$base,$secondary])); $settings["url-slugs"][$secondary]=strtolower(substr($secondary,0,2)); update_option("trp_settings",$settings); TRP_Translate_Press::get_trp_instance()->get_component("query")->check_table($base,$secondary); $admin=get_user_by("login","harness-admin"); if(!$admin) exit(2); update_user_meta($admin->ID,"locale",$secondary); if(get_user_locale($admin->ID)!==$secondary) exit(3);`;
}

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

async function configureSecondaryLocale({
  lab,
}: WordPressInitialization): Promise<void> {
  const locale = lab.administratorSecondaryLocale;
  if (locale !== undefined)
    await lab.wp(["eval", translatePressLocaleSetupScript(locale)]);
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
  for (const [index, title] of setup.initialPosts.entries()) {
    const approvedComment =
      index === 0 && setup.initialApprovedComment === true;
    const created = await lab.wp([
      "post",
      "create",
      "--post_status=publish",
      `--post_title=${title}`,
      ...(approvedComment ? ["--porcelain"] : []),
    ]);
    if (!approvedComment) continue;
    const postId = created.stdout.trim();
    if (!/^[1-9][0-9]*$/.test(postId))
      throw new Error("Seed post ID is unavailable");
    await lab.wp([
      "comment",
      "create",
      `--comment_post_ID=${postId}`,
      "--comment_content=Thanks for the useful post.",
      "--comment_author=Lab Reader",
      "--comment_author_email=lab-reader@example.invalid",
      "--comment_type=comment",
      "--comment_approved=1",
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
  await installPlugins(input);
  await configureSecondaryLocale(input);
  await createAccounts(input);
  await seedInitialPosts(input);
}

/** Grant SELECT on the tables present at provision time. */
export async function grantReadOnlyDatabaseAccess(
  lab: WordPressLabSession,
): Promise<void> {
  const tables = (
    await lab.requireDocker([
      "exec",
      lab.database,
      "mariadb",
      "--user=root",
      `--password=${lab.databasePassword}`,
      "--skip-column-names",
      "--batch",
      "--execute",
      `SHOW TABLES FROM ${DATABASE_NAME}`,
    ])
  ).stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z0-9_]{1,64}$/.test(line));
  if (tables.length === 0) throw new Error("No tables to expose");
  await lab.requireDocker([
    "exec",
    lab.database,
    "mariadb",
    "--user=root",
    `--password=${lab.databasePassword}`,
    "--execute",
    [
      `CREATE USER '${READ_ONLY_DATABASE_USER}'@'%' IDENTIFIED BY '${lab.readerPassword}'`,
      ...tables.map(
        (table) =>
          `GRANT SELECT ON ${DATABASE_NAME}.${table} TO '${READ_ONLY_DATABASE_USER}'@'%'`,
      ),
      "FLUSH PRIVILEGES",
    ].join("; "),
  ]);
}
