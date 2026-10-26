import { describe, expect, it } from "vitest";

import { wordPressLabCommandRule } from "../../../src/profiles/wordpress/discovery/lab-commands.js";

// The counts recorded in `observed.labRequests` / `dbQueries` before the rule
// moved behind the profile (ADR 0011); a change here changes recorded receipts.
describe("WordPress Lab command rule", () => {
  it.each([
    ["curl http://wordpress/health", true],
    ["curl http://wordpress/health && mysql -h database -e SELECT", true],
    ["wget -qO- http://wordpress/wp-json/", true],
    ["python - <<'EOF' # http://wordpress/", true],
    ["php -r 'echo file_get_contents(\"http://wordpress/\");'", true],
    ["cd /tmp; curl http://wordpress/", true],
    ["curl http://example.test/", false],
    ["cat /workspace/wordpress/wp-load.php", false],
    ["curl http://WordPress/", false],
    ["mycurl http://wordpress/", false],
  ])("Lab request %j → %s", (command, expected) => {
    expect(wordPressLabCommandRule.isLabRequest(command)).toBe(expected);
  });

  it.each([
    ["mysql -h database -e SELECT", true],
    ["curl http://wordpress/health && mysql -h database -e SELECT", true],
    ["mariadb --host=database wordpress", true],
    ["mysql -h 127.0.0.1 -e SELECT", false],
    ["echo database", false],
    ["mysqldump -h database wordpress", false],
  ])("database query %j → %s", (command, expected) => {
    expect(wordPressLabCommandRule.isDatabaseQuery(command)).toBe(expected);
  });
});
