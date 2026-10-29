---
name: wbh-tools
description: Use after the recon map exists, or whenever an agent needs a list of the literal hook registrations and the literal effect calls across the pinned plugin source. Runs the two enumeration scripts shipped in this skill's directory, saves their output under /workspace/research/tools for every agent in the Trial, reads the fixed reference of core features, and cross-checks all three against /workspace/research/recon-map.md. The lists are hints to read from, not findings.
---

# wbh-tools v1

Reading a plugin by hand finds what the reader happens to open. A mechanical listing of where core resolves requests into plugin code, and where plugin code hands a value to core for an effect, finds the same kinds of places in every file at once, including files nobody opened. The listing is cheap and blind: it matches text, so it misses everything the plugin reaches through its own wrapper, a variable, or a bundled framework. This skill describes how to run the listing once per Trial, how to keep its output where every agent can read it, and how to turn the gaps between the listing and the map into work rather than into false confidence. It does not say what the listed places mean. The objective and the output contract say that.

## Inputs

The pinned plugin source is at /workspace/main; pinned WordPress core, when supplied, is at /workspace/wordpress, and other supplied plugin and library source is under /workspace/dependencies/<slug>. The research directory /workspace/research is writable and shared by every agent in the Trial. The directory that holds this SKILL.md also holds three files: enumerate-hooks-v1.sh, enumerate-sinks-v2.sh and core-fixed-list-v1.md. The scripts take the source root as their first argument and print tab-separated lines of kind, file, line and the matched text, with paths relative to that root. The reference is the same for every plugin and names none.

## Step 1: run the scripts once and keep the output

Run each script with sh, with /workspace/main as the argument, and save the output to /workspace/research/tools/hooks.tsv and /workspace/research/tools/sinks.tsv. Do this once per Trial; later agents read the saved files instead of running the scripts again. A script that exits without output or with an error is itself a fact to record: write what happened to /workspace/research/tools/README.md and continue by hand. If a dependency plugin or a library under /workspace/dependencies is part of the surface you are reading, run the scripts a second time against that directory and save the output under its own name beside the first.

## Step 2: read the fixed reference as a checklist

Read core-fixed-list-v1.md. It lists the core features that act on a value a plugin hands them, and the core features that resolve a request into plugin code, each with the core functions involved. Use it as a checklist of effect kinds and dispatch kinds to look for in this plugin, not as a list of what is wrong. The counts in its last columns describe the history mirror as a whole and say nothing about this plugin; do not let them order your reading of this plugin.

## Step 3: cross-check the hooks list against the map

Open /workspace/research/recon-map.md. For each request entry the map records, find its line in hooks.tsv. An entry the map has and the list lacks is behind a wrapper, a variable name or a framework dispatcher; record the wrapper and the rule in the map's Corrections section if it is not already there. A line the list has and the map lacks is an entry the map missed; read it and add it to the map's subsystem and entry tables with its handler and parameters. Treat the registrations the list cannot see, which the reference names below its tables, as a separate pass: search for the plugin's own names for them, by following the loader and wrapper rules the map records.

## Step 4: cross-check the sinks list against the map

For each subsystem in the map, read the sinks.tsv lines under its files and compare them with the stores and effects the map records in its shared helpers section. A call the list shows and the map lacks is an effect the map missed; add it. An effect the map records that the list does not show is reached through a plugin-defined method, a variable function name or a bundled framework; record the wrapper by file and line so a later reader can search for it by its own name. Output lines are grouped by function with the first match and a count of the rest; a function with a large count is a template or a renderer, and the map should say which values flow into it rather than listing every line.

## Step 5: record what the lists missed

Write a short section to /workspace/research/tools/README.md that says which script outputs exist, which directories they cover, and which wrappers and dispatchers the map records that the scripts cannot see. Later agents read this before they trust a search of the lists as complete. A match in either list is a place to read, not a conclusion; a line's absence is a reason to search for the plugin's own name for the same mechanism, not evidence that it does not exist.

## Step 6: hand-over

When handing a subsystem to another agent, name the saved output files and the lines in them that belong to that subsystem, together with the map's section for it, instead of asking the other agent to run the scripts again. A child that reads only its lines of hooks.tsv and sinks.tsv, the matching part of the map, and the Corrections section starts with the same picture its parent had.
