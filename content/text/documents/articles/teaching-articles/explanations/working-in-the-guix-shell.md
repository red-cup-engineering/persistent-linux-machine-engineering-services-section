---
title: "Working in the Guix Shell"
aliases:
  - "Working in the Guix Shell"
date-created: 2026-08-30
description: "How a human or agent actually works on Bare Cedar Fog day to day: logging in wearing the manifest, adding a tool to the sheet, and running something in the pinned era."
tags: []
requires:
  - "./../../../../glossary/terms/guix-manifest.md"
  - "./../../../../glossary/terms/guix-shell.md"
  - "./../../../../glossary/terms/guix-channel-pin.md"
  - "./../../../../glossary/terms/pinned-runner.md"
teaches:
  - "logging into the Guix shell with a manifest"
  - "adding a tool to a manifest"
  - "running a command in the pinned era"
id: working-in-the-guix-shell
authors:
  - claude-sonnet-5
type: lesson
---

## Assumed audience

You have no programming background but you think in terms of characters,
sheets, and sessions — the vocabulary of a MUD. You want to know what
actually happens when someone works on Bare Cedar Fog, this laptop, using
Guix. The machine profile and the shared Guix runner live in machine-service
custody, not at the repository root.

## The one-sentence version

**The machine record's package list is a character sheet. `guix shell` over it is
logging in wearing it. For that session you have exactly the sheet's
tools, at fixed versions; logging out removes them; the machine underneath
never changes.**

Everything else in this article is that sentence, unpacked.

## What you get when you log in

From any directory in this checkout:

```sh
guix shell ripgrep pandoc ffmpeg librsvg zip unzip beancount
```

This opens a new shell session. Inside it, and only for as long as it
lasts, the commands named in the record's `:native-packages` — `ripgrep`, `pandoc`, `ffmpeg`,
and the rest of today's sheet — are on your command line, at the exact
versions the [channel pin](../../../../../../../../../../../../../../../../../science-services-section/services/information-science-services-section/services/computer-science-services-section/services/computer-systems-science-services-section/content/text/glossary/terms/guix-channel-pin.md)
currently names. Exit that shell (`exit`, or close the terminal) and those
commands are gone from your command line again. Nothing was installed.
Nothing on the machine was changed. If another agent, on another machine
entirely, wears the same sheet, they get the identical tool list at the
identical versions — that is the whole point of wearing a sheet instead of
just "having Guile installed."

This is the [Guix manifest](../../../../../../../../../../../../../../../../../science-services-section/services/information-science-services-section/services/computer-science-services-section/services/computer-systems-science-services-section/content/text/glossary/terms/guix-manifest.md)
and [guix shell](../../../../../../../../../../../../../../../../../science-services-section/services/information-science-services-section/services/computer-science-services-section/services/computer-systems-science-services-section/content/text/glossary/terms/guix-shell.md) reading in
practice, not just in theory.

## Sheets are files, not folders

The one piece of automatic behavior in this whole system: if you type
`guix shell` with no `-m` flag at all, Guix looks in the current directory
for a file literally named `manifest.scm` and, if it finds one and you've
authorized it once, uses it. That is the *only* directory magic here.

Every other filename has to be named explicitly:

```sh
guix shell -m some-other-sheet.scm
```

A single directory can hold several sheets side by side — nothing stops a
folder from containing `manifest.scm` and `manifest-heavy.scm` and
`manifest-minimal.scm` at once. And sheets can be worn together:

```sh
guix shell -m manifest.scm -m manifest-extra.scm
```

wears both — manifests **union**, they don't override each other. Wearing
two sheets gets you the tools from both.

## Adding a tool to the sheet

Bare Cedar Fog does not keep a `manifest.scm`. Its tools are the `:native-packages` of the machine record, `data/records/apps-records/lagoon-records/bare-cedar-fog.scm`, which LAGOON provides through `guix shell`. The package list there is the sheet:

```scheme
:native-packages ("ripgrep" "pandoc" "ffmpeg" "librsvg" "zip" "unzip" "beancount")
```

To add a tool, add its package name as another string in that list and
save the record. The next time anyone logs in with the pinned `guix shell -m`
command above, the new tool is on the sheet. There is
nothing else to register anywhere — the file *is* the sheet.

What the sheet is not: it is not an inventory of the repository. It names
the software environment needed to work on the repository, not the
repository's own documents, services, or people. Someone reading it should
expect a short, boring list of interpreters and libraries — not a map of
everything Bare Cedar Fog does.

## The bookmark: which era of the catalog

A manifest names tools by bare name — `"guile"`, not "guile 3.0.10 built
on such-and-such a day." What fixes the exact version is a separate file,
the [channel pin](../../../../../../../../../../../../../../../../../science-services-section/services/information-science-services-section/services/computer-science-services-section/services/computer-systems-science-services-section/content/text/glossary/terms/guix-channel-pin.md), in the
shared Guix machine service. It is the bookmark to
one exact moment of Guix's public software catalog — the era everyone
working on this repository plays in, regardless of which machine they are
on. This is the same job an npm lockfile does for a Node dependency tree:
the manifest chooses; the pin decides what the choices mean.

You do not normally edit the pin by hand day to day — it changes when the
organization deliberately moves to a newer catalog era, the same way a
lockfile changes when dependencies are deliberately upgraded.

## Running something in the pinned era

Use [the pinned runner](../../../../../../../../../../../../../../../../../science-services-section/services/information-science-services-section/services/computer-science-services-section/services/computer-systems-science-services-section/content/text/glossary/terms/pinned-runner.md):

```sh
guix time-machine -C <channel pin> -- <command>
```

This takes one authenticated `guix time-machine` hop through the shared
pin. The runner is common machine-composition machinery; it does not decide
where a service runs or replace operating recovery contracts.

## Per-project sheets, beside what they package

Not every `.scm` file in this repository is a manifest naming a shell's
tools. Some are package *definitions*: a recipe for how to build one
specific thing, filed beside the thing it builds. A live example is
`koios-news.scm`, which sits in the Koios News service's own directory and
packages that service's exact runtime. It is loadable two ways: through
the repository's channel machinery, or directly with
`guix build -f koios-news.scm`, run through
[the pinned runner](../../../../../../../../../../../../../../../../../science-services-section/services/information-science-services-section/services/computer-science-services-section/services/computer-systems-science-services-section/content/text/glossary/terms/pinned-runner.md) rather than
the ambient Guix, for the same
reason described above.

The industry parallel, if it helps: `manifest.scm` plays the role of
`shell.nix`; the channel pin plays the role of `flake.lock`; a
per-directory `.scm` beside what it packages (like `koios-news.scm`) plays
the role of a per-project `default.nix`; and `guix pack -f docker` is the
production-image path, the same shape Nix shops use for
`dockerTools.buildImage`. The fuller mapping, with production precedent,
is written up in the companion note "GNU Guix as Production Discipline"
(engineering-science-services-section / technology-science-services-section,
2026-08-30), which this article does not repeat.

## Where each file lives, today

| What | File | Role |
|---|---|---|
| Character sheet | `data/records/apps-records/lagoon-records/bare-cedar-fog.scm` (`:native-packages`) | names Bare Cedar Fog's tools |
| Era bookmark | `persistent-linux-machine-engineering-services-section/src/guix-bootstrap-channels.scm` | pins the exact catalog revision |
| Runner | `persistent-linux-machine-engineering-services-section/services/guix-machine-release-service/scripts/pinned-guix.scm` | reuses an installed Guix only when its channels equal the pin, otherwise uses `guix time-machine` |
| Per-project example | `koios-news/koios-news.scm` | a package definition beside its service |

None of these live at the repository root. Common Guix mechanics live in
the Guix machine service; a machine profile lives with that machine; a
service package remains beside its service.

## What this article does not cover

Guix realizes system-as-value in Guile: a package, a manifest, a channel,
a profile are all ordinary Guile values, not configuration files
interpreted by some other engine. qtOps extends that same move from the
built system to the running one; that extension is qtOps's own custody and
is not covered here.

## See also

- [Guix manifest (character sheet reading)](../../../../../../../../../../../../../../../../../science-services-section/services/information-science-services-section/services/computer-science-services-section/services/computer-systems-science-services-section/content/text/glossary/terms/guix-manifest.md)
- [guix shell (login reading)](../../../../../../../../../../../../../../../../../science-services-section/services/information-science-services-section/services/computer-science-services-section/services/computer-systems-science-services-section/content/text/glossary/terms/guix-shell.md)
- [Guix channel pin](../../../../../../../../../../../../../../../../../science-services-section/services/information-science-services-section/services/computer-science-services-section/services/computer-systems-science-services-section/content/text/glossary/terms/guix-channel-pin.md)
- [Pinned runner](../../../../../../../../../../../../../../../../../science-services-section/services/information-science-services-section/services/computer-science-services-section/services/computer-systems-science-services-section/content/text/glossary/terms/pinned-runner.md)
- In-house: "GNU Guix as Production Discipline"
  (engineering-science-services-section / technology-science-services-section,
  2026-08-30) and its companion, the April 2026 research note on
  Guix/Guile system composition (held in the computer-systems-engineering
  and 561-group sections).
