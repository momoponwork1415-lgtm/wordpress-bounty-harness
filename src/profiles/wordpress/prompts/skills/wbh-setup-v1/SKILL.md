---
name: wbh-setup
description: Use when the Trial has a Lab (the ## Lab section names a site and an administrator account), after the recon map exists and before any agent sends requests to the Lab. Reads the plugin's readme.txt and the recon map to list the features a site owner uses and the objects they create to use them, sets the plugin up in the Lab the way an ordinary site would, publishes one page per object, and records what was built in /workspace/research/lab-setup.md for every agent in the Trial.
---

# wbh-setup v1

A plugin that is only activated shows almost none of itself to a visitor. Its forms, galleries, tables, listings and the pages that hold them exist only after a site owner creates them, and a request that reaches a handler often reads an object the owner made first. A Lab in that state answers every request the same way, and an agent that tries the Lab against it learns nothing about the plugin as sites run it. This skill describes how to bring the Lab to the state of an ordinary site that uses the plugin, from the sources the Trial already has, and how to record that state so that every agent reads the same site and a reset rebuilds it. It does not say what to try against the site afterwards. The objective and the output contract say that.

## Inputs

The Trial's `## Lab` section names the site address, the administrator account and the low-privilege accounts, and the reset and observe commands with their budgets. The pinned plugin source is at /workspace/main, and the plugin's own readme.txt is in it: its Description, Installation, FAQ and Screenshots sections are the text the plugin's directory page shows, so no other source of that text is needed. The recon map is at /workspace/research/recon-map.md. The research directory /workspace/research is writable and shared by every agent in the Trial; the setup record lives there. The administrator account is for building the site; anything built with it that an ordinary site would not have is a precondition to state, not a fact about the plugin.

## Step 1: list the features and the objects behind them

Read readme.txt first: Description for what the plugin does for a site, Installation for the steps a site owner takes after activation, FAQ for the settings and objects it assumes, Screenshots captions for the screens the owner uses. Then read the map's Subsystems and Entries sections and the admin pages, shortcodes, blocks, widgets and routes they record. Write the list of features a visitor or a logged-in member of the site would see or use, and for each one the object the owner creates to make it exist: a form, a gallery, a table, a slider, a listing, an event, a booking resource, a membership level, a product, a feed source, a map, a popup, a template. A feature the readme describes but the map does not place is a reason to read the source again; a subsystem the map records but the readme never mentions is still a feature, and goes on the list. Mark features that need an external account or an outside service as such; they are not built here.

## Step 2: finish the plugin's own first-run flow with defaults

Log in as the administrator and open the plugin's menu. If the plugin shows an onboarding or setup wizard, a notice asking for a first step, or an import of sample content, complete it choosing the default or recommended option each time, and skip steps that connect to an outside service or ask for a key. Leave settings at their default values; turn on the features from Step 1 only where the plugin ships them off and its readme presents them as ordinary use. Do not change settings a typical site would leave alone. Every setting changed from its default is written down in Step 4, and a Finding or Lead whose route depends on it states it in `configurationPrecondition`.

## Step 3: create one of each object and publish it

For each object in the Step 1 list, create one instance through the plugin's own admin screens or its own REST routes as the administrator, with the content a demonstration site would carry: a few fields, a title, an image from the media library where the object takes one. Keep the plugin's defaults for every field it fills in itself. Then publish one page per object that holds it, through the plugin's shortcode or block as its readme or screens show, and give the page a title that names the object. Where the plugin adds its own public pages or archives on activation, record their addresses instead of making pages. Where a feature works on ordinary content, make the content it works on: a post with the plugin's block, a comment thread, a product in the cart, a profile with the plugin's fields. Where the ordinary flow has a visitor or a low-privilege member create data, create one item that way, logged in as the Lab's low-privilege account or not logged in, using the published page: one form submission, one comment, one booking, one registration. Every object and every piece of content has an author or an owner, as it would on a real site. Stop building an object when it needs an outside service, a paid add-on or a dependency the Lab does not have, and record what stopped it.

## Step 4: write the setup record

Write /workspace/research/lab-setup.md with these sections, in this order: Features, the Step 1 list with the readme section or map row each came from; Settings changed, every setting changed from its default with the screen it was changed on and the value, or the word "none" when nothing changed; Objects, a table with columns object, how it was created, its admin address, the published page that holds it and the page's address; Content, the items created as a visitor or a low-privilege member and which account made each; Not built, the features and objects from Step 1 that were not built and why; Verified, the published pages opened once with the Lab's observe command as a visitor, with the HTTP status each returned. Every address is a path on the Lab site. Other agents append under a Changes section at the end, dated, when they add to the site; they do not rewrite the sections above.

## Step 5: rebuild after a reset

A reset removes the whole site and provisions it again from the Harness's setup, which does not include anything this skill built. After a reset, repeat Steps 2 and 3 from the record, in the order of the Objects table, and append to the Changes section that the site was rebuilt and whether anything differed. An agent that needs a clean site weighs that cost against the reset budget the `## Lab` section states.

## Step 6: hand-over

When handing a subsystem to another agent, name the Objects rows and the published pages that belong to it, together with the Settings changed section, instead of describing the site in prose. A child that reads its rows of lab-setup.md and the matching section of the map knows which pages to open and which account to use before it sends its first request. An agent that finds the record wrong, or finds an object missing, fixes the site and appends the correction with the date.
