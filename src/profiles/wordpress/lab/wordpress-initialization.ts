import { SQL_CANARY_TABLE } from "./canary-placement.js";
import {
  DATABASE_NAME,
  READ_ONLY_DATABASE_USER,
  type WordPressLabSession,
} from "./lab-session.js";
import type { PreparedWordPressLab } from "./provision-input.js";
import {
  scenarioBookingPage,
  scenarioBuilderPage,
  scenarioFileAttachmentForm,
  scenarioContent,
  scenarioSearchableComment,
  scenarioTranslationSeedScript,
  translatePressLocaleSetupScript,
} from "./scenarios.js";
import { buildSearchableCommentIndex } from "./relevanssi-search-index.js";
import { seedSimplyScheduleBooking } from "./simply-schedule-booking.js";
import { seedBrizyBuilderPage } from "./brizy-builder-page.js";
import { seedBrizyFileAttachmentForm } from "./brizy-file-attachment-form.js";
import {
  USER_REGISTRATION_SCENARIO_ID,
  userRegistrationOrdinarySetupScript,
} from "./user-registration-adapter.js";
import {
  USER_REGISTRATION_MEMBERSHIP_SCENARIO_ID,
  USER_REGISTRATION_UNJOINED_MEMBERSHIP_SCENARIO_ID,
  userRegistrationMembershipEnrollmentScript,
  userRegistrationMembershipInstallScript,
  userRegistrationMembershipUnjoinedScript,
} from "./user-registration-membership-adapter.js";
import {
  WPDISCUZ_COMMENT_SCENARIO_ID,
  wpDiscuzOrdinarySetupScript,
} from "./wpdiscuz-adapter.js";
import {
  WP_MEMBERS_SCENARIO_ID,
  wpMembersOrdinarySetupScript,
} from "./wp-members-adapter.js";

interface WordPressInitialization {
  readonly lab: WordPressLabSession;
  readonly prepared: PreparedWordPressLab;
}

/** The plugin adapters removed in #353 still take the Lab and a two-argument command. */
const adapterCommand = (lab: WordPressLabSession, args: readonly string[]) =>
  lab.wp(args);

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
}: WordPressInitialization): Promise<string | undefined> {
  const { setup, scenario } = prepared;
  let approvedCommentPostId: string | undefined;
  for (const [index, title] of setup.initialPosts.entries()) {
    const approvedComment =
      index === 0 &&
      (setup.initialApprovedComment === true || scenario?.approvedComment);
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
    approvedCommentPostId = postId;
    await lab.wp([
      "comment",
      "create",
      `--comment_post_ID=${postId}`,
      `--comment_content=${scenarioSearchableComment(scenario)?.body ?? "Thanks for the useful post."}`,
      "--comment_author=Lab Reader",
      "--comment_author_email=lab-reader@example.invalid",
      "--comment_type=comment",
      "--comment_approved=1",
    ]);
  }
  return approvedCommentPostId;
}

async function seedScenarioContent({
  lab,
  prepared,
}: WordPressInitialization): Promise<void> {
  const content = scenarioContent(prepared.scenario);
  if (content === undefined) return;
  const created = await lab.wp([
    "post",
    "create",
    `--post_type=${content.type}`,
    `--post_status=${content.status}`,
    `--post_name=${content.slug}`,
    `--post_title=${content.title}`,
    `--post_content=${content.body}`,
    "--porcelain",
  ]);
  if (!/^[1-9][0-9]*$/.test(created.stdout.trim()))
    throw new Error("Scenario content ID is unavailable");
}

async function seedScenarioTranslation({
  lab,
  prepared,
}: WordPressInitialization): Promise<void> {
  const script = scenarioTranslationSeedScript(prepared.scenario);
  if (script !== undefined) await lab.wp(["eval", script]);
}

async function seedScenarioRegistration({
  lab,
  prepared,
}: WordPressInitialization): Promise<void> {
  const id = prepared.scenario?.id;
  if (
    id === USER_REGISTRATION_SCENARIO_ID ||
    id === USER_REGISTRATION_MEMBERSHIP_SCENARIO_ID ||
    id === USER_REGISTRATION_UNJOINED_MEMBERSHIP_SCENARIO_ID
  )
    await lab.wp(["eval", userRegistrationOrdinarySetupScript()]);
}

async function seedScenarioMembership({
  lab,
  prepared,
}: WordPressInitialization): Promise<void> {
  const id = prepared.scenario?.id;
  if (
    id !== USER_REGISTRATION_MEMBERSHIP_SCENARIO_ID &&
    id !== USER_REGISTRATION_UNJOINED_MEMBERSHIP_SCENARIO_ID
  )
    return;
  await lab.wp(["eval", userRegistrationMembershipInstallScript()]);
  // Module classes are loaded at bootstrap, after the installer's option write.
  const subscriber = lab.attackerAccounts.subscriber.username;
  await lab.wp([
    "eval",
    id === USER_REGISTRATION_MEMBERSHIP_SCENARIO_ID
      ? userRegistrationMembershipEnrollmentScript(subscriber)
      : userRegistrationMembershipUnjoinedScript(subscriber),
  ]);
}

async function seedScenarioCommentForm({
  lab,
  prepared,
}: WordPressInitialization): Promise<void> {
  if (prepared.scenario?.id === WPDISCUZ_COMMENT_SCENARIO_ID)
    await lab.wp(["eval", wpDiscuzOrdinarySetupScript()]);
}

async function seedScenarioMemberPost({
  lab,
  prepared,
}: WordPressInitialization): Promise<void> {
  if (prepared.scenario?.id === WP_MEMBERS_SCENARIO_ID)
    await lab.wp(["eval", wpMembersOrdinarySetupScript()]);
}

/** Initialize the isolated WordPress site after all containers are healthy. */
export async function initializeWordPress(
  lab: WordPressLabSession,
  prepared: PreparedWordPressLab,
): Promise<void> {
  const input: WordPressInitialization = { lab, prepared };
  const { scenario, target } = prepared;
  await installCore(input);
  await installPlugins(input);
  await configureSecondaryLocale(input);
  await createAccounts(input);
  const approvedCommentPostId = await seedInitialPosts(input);
  await seedScenarioContent(input);
  await seedScenarioTranslation(input);
  await buildSearchableCommentIndex({
    scenario,
    targetSlug: target.slug,
    postId: approvedCommentPostId,
    resource: lab,
    wp: adapterCommand,
  });
  await seedSimplyScheduleBooking({
    bookingPage: scenarioBookingPage(scenario),
    targetSlug: target.slug,
    resource: lab,
    wp: adapterCommand,
  });
  await seedBrizyBuilderPage({
    builderPage: scenarioBuilderPage(scenario),
    targetSlug: target.slug,
    resource: lab,
    wp: adapterCommand,
  });
  await seedBrizyFileAttachmentForm({
    fileAttachmentForm: scenarioFileAttachmentForm(scenario),
    targetSlug: target.slug,
    resource: lab,
    wp: adapterCommand,
  });
  await seedScenarioRegistration(input);
  await seedScenarioMembership(input);
  await seedScenarioCommentForm(input);
  await seedScenarioMemberPost(input);
}

/** Grant SELECT on the tables present at provision time, before canary placement. */
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
    .filter(
      (line) => /^[A-Za-z0-9_]{1,64}$/.test(line) && line !== SQL_CANARY_TABLE,
    );
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
