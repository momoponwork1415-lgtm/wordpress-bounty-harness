---
name: wbh-recon
description: Use at the start of exploring a WordPress plugin's pinned source, before forming hypotheses or starting other agents, and again when an agent is handed a part of the plugin it has not read. Builds a map of the plugin's subsystems, request entries, authorization gates, shared helpers, data stores and the JavaScript boundary, and writes it to /workspace/research/recon-map.md for every agent in the Trial to read.
---

# wbh-recon v1

A map of the plugin comes before any hypothesis. Reading the code with a question already in mind finds only what the question names; reading it to describe how it is built shows the parts the question would have skipped. This skill describes how to build that map from the pinned source alone and how to write it so that other agents can start from it instead of re-reading the plugin. It does not say what to look for afterwards. The objective and the output contract say that.

## Inputs

The pinned plugin source is at /workspace/main. Pinned WordPress core source, when supplied, is at /workspace/wordpress; other supplied plugin and library source is under /workspace/dependencies/<slug>. Read the supplied source instead of recalling what core, a framework or a library does. The research directory /workspace/research is writable and shared by every agent in the Trial; the map lives there.

## Step 1: shape

Read the main plugin file and whatever it loads, in load order, before anything else. Record how code reaches memory: an autoloader and its class-to-file rule, explicit require lists, a bundled framework's module loader, feature directories loaded on a condition such as another plugin being active or a setting being on. Record the top-level directories and what each holds, the namespaces or class prefixes, bundled libraries under vendor or similar, and where the shipped JavaScript and templates live. Note the size of each area in files, so a later split can be sized.

## Step 2: subsystems

Group the code into subsystems by the feature the user of the site sees, not by directory alone: the settings area, each public-facing feature, integrations with other plugins or external services, background jobs, import and export, upgrades and migrations. Five to fifteen groups is the usual range; a plugin that does one thing may have three. For each subsystem write its files, its main classes or function groups, and one sentence on what it does. A file that serves several subsystems is a shared helper and goes in Step 5.

## Step 3: request entries

For each subsystem list every place a request from outside the plugin's own code starts running it. Begin from how WordPress itself dispatches: action and filter hooks, AJAX handlers, REST routes, shortcodes and blocks, admin pages and their form handlers, scheduled events, rewrite rules and query variables, template redirects, files that can be requested directly, and callbacks that another plugin or an external service invokes. Then read how this plugin registers them. Many plugins wrap core registration in their own layer: a routes table, a controller base class, a module loader, an attribute or array of handlers, a hook manager. Find each wrapper by following the loader from Step 1, and record the rule that maps a wrapper entry to the core mechanism it ends in, with the file and line of the wrapper. A search for core function names alone misses everything behind a wrapper; a search for the wrapper's name finds the rest.

For each entry record the file and line of the registration, the mechanism, the handler it resolves to, and the parameters the handler reads.

## Step 4: who reaches an entry, and the gate

For each entry record who can reach it before any code of the handler runs: anyone, a logged-in account of a low role, or a higher role only, as the registration mechanism decides. Then record what the code checks on the way in: capability checks, nonce or token checks, login checks, ownership checks, and where each check sits. A check in a shared registration wrapper covers every entry behind the wrapper; a check inside one handler covers that handler only; a wrapper that leaves the check to the handler covers nothing by itself. Name the shared gate functions, the entries that pass through them, and the entries that do not. State what you read, not what the plugin's comments or option names claim.

## Step 5: shared helpers, stores and effects

List the helper layer the subsystems share: database access classes and query builders around the core database object, settings and option wrappers, file and upload helpers, template and rendering helpers, HTTP client wrappers, serialization helpers, and the plugin's own escaping or validation functions. For each helper record what it wraps in core or in a library, and which subsystems call it. Then list what the plugin stores and where: options, post and user meta, custom tables with their schema, transients, files under the uploads directory, and data sent to or fetched from external services. Record where stored values are read back out and rendered: admin screens, public templates, email, feeds, and responses that JavaScript renders.

## Step 6: the JavaScript boundary

Record how the shipped JavaScript talks to PHP and what it renders: data localized into the page, REST and AJAX calls and the handlers they reach, and views built in the browser from those responses, including any framework templates. A value that leaves PHP as data and is placed into the page by JavaScript has its last step in the JavaScript file, so the map names that file beside the PHP handler. Minified bundles with a readable source alongside are mapped from the source; a bundle with no source is noted as unread.

## Step 7: write the map

Write /workspace/research/recon-map.md with these sections, in this order: Shape; Subsystems; Entries, one table per subsystem with columns registration, mechanism, handler, parameters, who reaches it, gate; Wrappers, a table mapping each plugin-specific registration form to the core mechanism; Shared helpers; Stores and effects; JavaScript boundary; Unread, the files and bundles not yet read with a reason; Open questions, things the source did not settle. Every row carries a file and line. Keep claims to what the source shows; mark anything inferred as inferred.

Other agents overwrite nothing in this file. An agent that reads a part the map marked unread, or finds the map wrong, appends a dated correction under a Corrections section at the end with the file and line that shows it.

## Step 8: hand-over

When work is split among agents, split it along the map: a subsystem with its entries, its shared helpers and its stores is one unit. Each agent receives the map's section for its unit, the Wrappers table, and the list of shared gate functions, and reads the map before the source. An agent that finishes writes what it read and what it left unread into its own research file and the Corrections section, so that the next agent on the same unit continues instead of restarting.
