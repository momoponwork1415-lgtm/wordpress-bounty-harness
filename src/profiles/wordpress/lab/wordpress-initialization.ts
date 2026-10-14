import type {
  DockerResult,
  ParsedWordPressLabSetup,
  Resources,
} from "./index.js";
import { SQL_CANARY_TABLE } from "./canary-placement.js";
import {
  DOWNLOAD_MONITOR_SCENARIO_ID,
  downloadMonitorOrdinarySetupScript,
} from "./download-monitor-adapter.js";
import {
  DOWNLOAD_MANAGER_SCENARIO_ID,
  downloadManagerOrdinarySetupScript,
} from "./download-manager-adapter.js";
import {
  scenarioBookingPage,
  scenarioBuilderPage,
  scenarioFileAttachmentForm,
  scenarioContent,
  scenarioSearchableComment,
  scenarioTranslationSeedScript,
  translatePressLocaleSetupScript,
  type WordPressScenario,
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

type WordPressCommand = (
  resource: Resources,
  args: readonly string[],
  environment?: readonly string[],
) => Promise<DockerResult>;
type RequireDocker = (
  args: readonly string[],
  timeoutMs?: number,
) => Promise<DockerResult>;

export const DATABASE_NAME = "wordpress";
export const READ_ONLY_DATABASE_USER = "wbh_reader";

type Account = { readonly username: string; readonly password: string };
export interface WordPressInitialization {
  readonly resource: Resources;
  readonly setup: ParsedWordPressLabSetup;
  readonly scenario: WordPressScenario | undefined;
  readonly coreVersion: string | undefined;
  readonly target: { readonly slug: string; readonly directory: string };
  readonly dependencies: readonly {
    readonly slug: string;
    readonly directory: string;
  }[];
  readonly subscriber: Account;
  readonly customer?: Account;
  readonly victimSubscriber?: Account;
  readonly victimCustomer?: Account;
  readonly wp: WordPressCommand;
  readonly requireDocker: RequireDocker;
}

async function installCore(input: WordPressInitialization): Promise<void> {
  const { resource, wp, setup, coreVersion } = input;
  if (coreVersion !== undefined) {
    const running = await wp(resource, ["core", "version"]);
    if (running.stdout.trim() !== coreVersion)
      throw new Error("The Lab image runs another WordPress version");
  }
  await wp(resource, [
    "core",
    "install",
    "--url=http://wordpress",
    `--title=${setup.siteTitle}`,
    "--admin_user=harness-admin",
    `--admin_password=${resource.adminPassword}`,
    "--admin_email=harness-admin@example.invalid",
    "--skip-email",
  ]);
}

async function installPlugins(input: WordPressInitialization): Promise<void> {
  const { resource, wp, requireDocker, dependencies, target } = input;
  for (const source of [...dependencies, target]) {
    await requireDocker([
      "exec",
      resource.wordpress,
      "mkdir",
      "-p",
      `/var/www/html/wp-content/plugins/${source.slug}`,
    ]);
    await requireDocker([
      "cp",
      `${source.directory}/.`,
      `${resource.wordpress}:/var/www/html/wp-content/plugins/${source.slug}`,
    ]);
    // Docker cp preserves modes from the host tree. A restrictive host umask
    // can leave the public plugin unreadable to WP-CLI's UID 33.
    await requireDocker([
      "exec",
      "--user=root",
      resource.wordpress,
      "chmod",
      "-R",
      "a+rX",
      `/var/www/html/wp-content/plugins/${source.slug}`,
    ]);
    await wp(resource, ["plugin", "activate", source.slug]);
  }
}

async function configureSecondaryLocale(
  input: WordPressInitialization,
): Promise<void> {
  const locale = input.resource.administratorSecondaryLocale;
  if (locale !== undefined)
    await input.wp(input.resource, [
      "eval",
      translatePressLocaleSetupScript(locale),
    ]);
}

async function createAccounts(input: WordPressInitialization): Promise<void> {
  const {
    resource,
    wp,
    subscriber,
    customer,
    victimSubscriber,
    victimCustomer,
  } = input;
  await wp(resource, [
    "user",
    "create",
    subscriber.username,
    `${subscriber.username}@example.invalid`,
    "--role=subscriber",
    `--user_pass=${subscriber.password}`,
  ]);
  if (customer !== undefined)
    await wp(resource, [
      "user",
      "create",
      customer.username,
      `${customer.username}@example.invalid`,
      "--role=customer",
      `--user_pass=${customer.password}`,
    ]);
  if (victimSubscriber !== undefined)
    await wp(resource, [
      "user",
      "create",
      victimSubscriber.username,
      `${victimSubscriber.username}@example.invalid`,
      "--role=subscriber",
      `--user_pass=${victimSubscriber.password}`,
    ]);
  if (victimCustomer !== undefined)
    await wp(resource, [
      "user",
      "create",
      victimCustomer.username,
      `${victimCustomer.username}@example.invalid`,
      "--role=customer",
      `--user_pass=${victimCustomer.password}`,
    ]);
}

async function seedInitialPosts(
  input: WordPressInitialization,
): Promise<string | undefined> {
  const { resource, wp, setup, scenario } = input;
  let approvedCommentPostId: string | undefined;
  for (const [index, title] of setup.initialPosts.entries()) {
    const approvedComment =
      index === 0 &&
      (setup.initialApprovedComment === true || scenario?.approvedComment);
    const created = await wp(resource, [
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
    await wp(resource, [
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

async function seedScenarioContent(
  input: WordPressInitialization,
): Promise<void> {
  const content = scenarioContent(input.scenario);
  if (content === undefined) return;
  const created = await input.wp(input.resource, [
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

async function seedScenarioTranslation(
  input: WordPressInitialization,
): Promise<void> {
  const script = scenarioTranslationSeedScript(input.scenario);
  if (script !== undefined) await input.wp(input.resource, ["eval", script]);
}

async function seedScenarioRegistration(
  input: WordPressInitialization,
): Promise<void> {
  if (
    input.scenario?.id === USER_REGISTRATION_SCENARIO_ID ||
    input.scenario?.id === USER_REGISTRATION_MEMBERSHIP_SCENARIO_ID ||
    input.scenario?.id === USER_REGISTRATION_UNJOINED_MEMBERSHIP_SCENARIO_ID
  )
    await input.wp(input.resource, [
      "eval",
      userRegistrationOrdinarySetupScript(),
    ]);
}

async function seedScenarioMembership(
  input: WordPressInitialization,
): Promise<void> {
  if (
    input.scenario?.id !== USER_REGISTRATION_MEMBERSHIP_SCENARIO_ID &&
    input.scenario?.id !== USER_REGISTRATION_UNJOINED_MEMBERSHIP_SCENARIO_ID
  )
    return;
  await input.wp(input.resource, [
    "eval",
    userRegistrationMembershipInstallScript(),
  ]);
  // Module classes are loaded at bootstrap, after the installer's option write.
  await input.wp(input.resource, [
    "eval",
    input.scenario.id === USER_REGISTRATION_MEMBERSHIP_SCENARIO_ID
      ? userRegistrationMembershipEnrollmentScript(input.subscriber.username)
      : userRegistrationMembershipUnjoinedScript(input.subscriber.username),
  ]);
}

async function seedScenarioCommentForm(
  input: WordPressInitialization,
): Promise<void> {
  if (input.scenario?.id === WPDISCUZ_COMMENT_SCENARIO_ID)
    await input.wp(input.resource, ["eval", wpDiscuzOrdinarySetupScript()]);
}

async function seedScenarioMemberPost(
  input: WordPressInitialization,
): Promise<void> {
  if (input.scenario?.id === WP_MEMBERS_SCENARIO_ID)
    await input.wp(input.resource, ["eval", wpMembersOrdinarySetupScript()]);
}

async function seedScenarioDownloads(
  input: WordPressInitialization,
): Promise<void> {
  if (input.scenario?.id !== DOWNLOAD_MANAGER_SCENARIO_ID) return;
  const uploads = "/var/www/html/wp-content/uploads";
  await input.requireDocker([
    "exec",
    "--user=root",
    input.resource.wordpress,
    "mkdir",
    "-p",
    uploads,
  ]);
  await input.requireDocker([
    "exec",
    "--user=root",
    input.resource.wordpress,
    "chown",
    "-R",
    "www-data:www-data",
    uploads,
  ]);
  await input.requireDocker(
    [
      "exec",
      "--user=www-data",
      input.resource.wordpress,
      "php",
      "-r",
      downloadManagerOrdinarySetupScript(),
    ],
    120_000,
  );
}

async function seedScenarioPublicDownload(
  input: WordPressInitialization,
): Promise<void> {
  if (input.scenario?.id !== DOWNLOAD_MONITOR_SCENARIO_ID) return;
  await input.requireDocker(
    [
      "exec",
      "--user=www-data",
      input.resource.wordpress,
      "php",
      "-r",
      downloadMonitorOrdinarySetupScript(),
    ],
    120_000,
  );
}

/** Initialize the isolated WordPress site after all containers are healthy. */
export async function initializeWordPress(
  input: WordPressInitialization,
): Promise<void> {
  await installCore(input);
  await installPlugins(input);
  await configureSecondaryLocale(input);
  await createAccounts(input);
  const approvedCommentPostId = await seedInitialPosts(input);
  await seedScenarioContent(input);
  await seedScenarioTranslation(input);
  await buildSearchableCommentIndex({
    scenario: input.scenario,
    targetSlug: input.target.slug,
    postId: approvedCommentPostId,
    resource: input.resource,
    wp: input.wp,
  });
  await seedSimplyScheduleBooking({
    bookingPage: scenarioBookingPage(input.scenario),
    targetSlug: input.target.slug,
    resource: input.resource,
    wp: input.wp,
  });
  await seedBrizyBuilderPage({
    builderPage: scenarioBuilderPage(input.scenario),
    targetSlug: input.target.slug,
    resource: input.resource,
    wp: input.wp,
  });
  await seedBrizyFileAttachmentForm({
    fileAttachmentForm: scenarioFileAttachmentForm(input.scenario),
    targetSlug: input.target.slug,
    resource: input.resource,
    wp: input.wp,
  });
  await seedScenarioRegistration(input);
  await seedScenarioMembership(input);
  await seedScenarioCommentForm(input);
  await seedScenarioMemberPost(input);
  await seedScenarioDownloads(input);
  await seedScenarioPublicDownload(input);
}

/** Grant SELECT on the tables present at provision time, before canary placement. */
export async function grantReadOnlyDatabaseAccess(
  resource: Resources,
  requireDocker: RequireDocker,
): Promise<void> {
  const tables = (
    await requireDocker([
      "exec",
      resource.database,
      "mariadb",
      "--user=root",
      `--password=${resource.databasePassword}`,
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
  await requireDocker([
    "exec",
    resource.database,
    "mariadb",
    "--user=root",
    `--password=${resource.databasePassword}`,
    "--execute",
    [
      `CREATE USER '${READ_ONLY_DATABASE_USER}'@'%' IDENTIFIED BY '${resource.readerPassword}'`,
      ...tables.map(
        (table) =>
          `GRANT SELECT ON ${DATABASE_NAME}.${table} TO '${READ_ONLY_DATABASE_USER}'@'%'`,
      ),
      "FLUSH PRIVILEGES",
    ].join("; "),
  ]);
}
