import type { LabCommandRule } from "../../../discovery/index.js";

/**
 * Which discovery command lines reached the WordPress Lab (ADR 0011): an HTTP
 * client naming the `wordpress` endpoint host, or a MySQL / MariaDB client
 * naming the `database` host. Only `observed.labRequests` / `dbQueries`
 * depend on it.
 */
export const wordPressLabCommandRule: LabCommandRule = {
  isLabRequest: (command) =>
    /(?:^|[\s;&|])(?:curl|wget|python|php)(?=\s|$)/.test(command) &&
    /\bwordpress\b/.test(command),
  isDatabaseQuery: (command) =>
    /(?:^|[\s;&|])(?:mysql|mariadb)(?=\s|$)/.test(command) &&
    /\bdatabase\b/.test(command),
};
