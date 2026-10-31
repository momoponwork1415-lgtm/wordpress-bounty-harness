---
name: wbh-trace
description: Use when an agent has picked a request entry, a store or an effect from /workspace/research/recon-map.md and needs to follow a value between them through the pinned source. Follows the value forward from the entry, backward from the effect and across stores and deferred callbacks, records every hop with the checks and transformations on the way as a table under /workspace/research/traces, and leaves the file, function and line rows a Finding or Lead draft needs for its sourceTrace.
---

# wbh-trace v1

A route is a sequence of hops, and the hop that decides it is often the one a reader skips. A trace that jumps from an entry to an effect by name passes over the place where the value is checked, changed or dropped; a trace written hop by hop, each with the line that shows it, can be read again by another agent, by the root and by the later human review. This skill describes how to follow one value through the pinned source from where a request supplies it to where it takes effect, how to record what the code does to it on the way, and how to leave the record where other agents and the final report can use it. It does not say which routes matter or whether a route is in scope. The objective, the trust boundary and the output contract say that.

## Inputs

The pinned plugin source is at /workspace/main. Pinned WordPress core source, when supplied, is at /workspace/wordpress; other supplied plugin and library source is under /workspace/dependencies/<slug>. Read the supplied source instead of recalling what core, a framework or a library does. The research directory /workspace/research is writable and shared by every agent in the Trial. The map is /workspace/research/recon-map.md, with its Wrappers table, its shared gate functions, shared helpers, stores and effects, JavaScript boundary and Corrections section. When the listing from wbh-tools exists, /workspace/research/tools/hooks.tsv and /workspace/research/tools/sinks.tsv are there too. Traces go under /workspace/research/traces, one file per route.

## Step 1: start from a row of the map

Start from one row of the map: a request entry, a store, or an effect. Read the map's section for that subsystem, the Wrappers table and the Corrections section before opening the source. Create /workspace/research/traces/<subsystem>-<short-name>.md and write the starting row in it by file and line. If the place you start from has no row in the map, add it to the map's Corrections section first, so the next agent finds it.

## Step 2: forward from the entry

From the entry's registration, reach the handler through the wrapper rule the map records, and follow the parameter the handler reads. At each hop record the file, function and line, and what the value is at that point: the request field or argument it came from and its name in this scope. Follow calls into shared helpers, core functions and library code by reading their pinned source, not by their names. Where the value is written to a store rather than used, name the store and continue in Step 4. Where the handler returns data that the shipped JavaScript places into the page, the last hop is in the JavaScript file the map names beside that handler.

## Step 3: backward from the effect

When the starting row is an effect or a store, or when the forward trace reaches a helper that several subsystems call, go the other way. From the call that takes effect, list every caller that reaches it, using the map's shared helpers section and, when it exists, the matching lines of sinks.tsv, and follow each caller back to the entries that supply its arguments. Read the helper once and record what it does with each argument; then record each caller as its own route, in the same trace file or in one beside it that names this one. A listed line is a place to read, not a hop, until you have read it.

## Step 4: across stores and deferred work

A value written to a store is read again elsewhere, and the map's stores and effects section records where. Follow the value from the write to every read-back the map records, and from a scheduled event, a queued job or a callback registered for later to the place where it runs. Keep the trace in the same file with the store as the joining hop, and record the write and the read-back as separate rows, each with who reaches it as the map records it. A read-back the map does not record is a correction to the map.

## Step 5: the checks and transformations on the way

For each hop, record what the code does to the request or the value at that point, as the source shows it: capability, login and ownership checks; nonce or token checks; sanitizing and validation; escaping and query preparation, whether by core or by the plugin's own functions; and any serializing or other change to the value. Record each one where it sits, in the order the code runs, and which hops it covers: a check in a shared registration wrapper, a check inside one handler, and a check left to the handler are recorded as such. Read the body of each function in the pinned source rather than relying on its name, its comments or the option names around it.

## Step 6: write the table

In the trace file, write these parts in this order. Ends: the starting row and the last hop, each with file and line. Hops: one table with one row per hop in the order the value moves, with columns file, function, line, role (entry, through, store, read-back, effect), the value at that hop, and the checks and transformations at that hop. Reach: who reaches the entry, as the map records it, and any setting the route passes through, as the source shows it. Open: the hops not yet read or not settled, each with the reason. Mark any hop you inferred rather than read as inferred. A row without a file and a line is not a hop yet.

## Step 7: from the table to a draft

The rows of the Hops table, entry first and effect last, with the store and read-back rows between them, are the sourceTrace of a draft: each carries the file, function and line the output contract asks for. A table with no Open rows gives a Finding draft its route; a table with an Open row gives a Lead draft its route, with the missing hop named in the reporting agent's own words. Whether to report it, and as which, is decided under the objective and the output contract. Write the table either way: a route that exists only in an agent's context is lost.

## Step 8: hand-over

When a trace is handed to another agent or continued by a fresh one, name the trace file and its Open rows together with the map's section for the subsystem. The next agent reads the trace file, that section and the Corrections section before the source, and appends to the trace instead of rewriting it; a note on another agent's trace goes under it, dated. A trace that showed the map wrong, or found an entry, wrapper, store or read-back the map lacked, adds a dated correction to the map's Corrections section with the file and line that shows it. An agent that finishes writes which traces it wrote and which Open rows remain into its own research file, so that the next agent on the same unit continues instead of restarting.
