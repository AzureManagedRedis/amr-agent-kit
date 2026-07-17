# Retained Run Report

This directory is copied with its enclosing `run-template` to
`eval-runs/<run-id>/`. Keep the report and index inside that run root so every
manifest path is relative and never uses `..`.

`report.md` links to the run manifest, both comparison transcripts, build and
optional redacted live results, the `reference-good` and `bad` trees, each
patch, `hashes.json`, and `reproduce.ps1`.
