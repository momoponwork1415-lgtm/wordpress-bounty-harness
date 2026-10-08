# WordPress file assignment rules v1

1. Enumerate externally reachable entry points from the frozen target source. Make each hook callback, registered route, or AJAX action a work unit. Include its registration site and the files reachable from that entry point. Identify the unit by entry point kind, registered name, and registration file / line.
2. Keep a complete entry-to-effect path in one unit. A file shared by several units may be read by each assigned run. Record overlapping file sets; do not infer that overlap is a second finding.
3. Put files without an identified entry point in separate file-based units. An assigned run may follow a source-grounded call into another unit's file and must record that extension. The assignment is a starting focus, not a claim of complete coverage.
4. Use only paths from the frozen source manifest. Sort units by kind, name, and path for stable scheduling. Record each run's exact unit IDs and file set with its snapshot digest.
5. Report examined and unexamined areas. Do not mark a unit complete merely because its files were assigned or opened.
