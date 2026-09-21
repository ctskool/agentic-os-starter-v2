# Vault Cleanup — review manifest

Ported from the vault's cleanup rubric. This initial workflow is an inspection and a proposed manifest. It does not authorize moving, renaming or deleting files, including temporary files. Return the manifest as the complete final answer; the bridge records it.

## Eligible scope

- Inspect projects/, inbox/, and content/blog/, content/linkedin/, content/twitter/ for files with an actual modification age greater than seven days. Use filesystem metadata, not a guessed age from a filename.
- Skip wiki/, people/, daily-notes/, system/, .obsidian/, all hidden folders, demo-assets/, existing archive/ and _archive-vault/ trees, and inbox report collections. Skip index files, source scripts and active/in-progress/blocked projects.
- For generated GitHub trending snapshots, use a fourteen-day threshold and retain the newest snapshot. Configuration and .py/.ps1 scripts are never cleanup candidates.
- Propose an archive/ destination within the same eligible top-level content folder. Preserve the basename. Resolve each source and proposed destination against the selected vault, including symlinks/junctions, and skip anything resolving outside it or colliding with another destination.
- Ordinary `[[note-name]]` links resolve a unique filename across the vault, so keeping that unique basename usually lets an archive move retain those links. Do not suppress a candidate simply because it has basename-only wiki links. Path-qualified wiki links, relative Markdown links, duplicate basenames, aliases/heading references and linked assets need their actual targets checked. List a specific ambiguity for review rather than declaring all archive moves unsafe or all links guaranteed safe. Obsidian's shortest-unique, relative and vault-absolute link formats differ; automatic link updating depends on settings and using an Obsidian-aware operation, not an arbitrary filesystem move. See [internal links](https://obsidian.md/help/links) and [file/link settings](https://obsidian.md/help/settings).
- Group `.md` notes with same-basename `.excalidraw` and `.png` assets and other verified attachments. Preserve grouping in the manifest; identify a missing or ambiguous companion rather than silently separating it.

## Temporary artifacts — separate deletion proposal

Inspect `content/temp/` separately for actual content-cascade build artifacts such as payload JSON, VTT captions and raw transcripts. These were delete candidates in the original workflow, not archive candidates. Include **Temp Files to Delete** with IDs, exact paths, artifact type, modified time, bytes and reason; list uncertain files under Review needed. Do not apply the ordinary archive threshold as permission to delete, and do not delete anything during this initial run. A later request must explicitly select the temporary-file IDs for deletion, with fresh path/content/metadata checks. Permission to archive other rows does not authorize deleting temporary files. No other folder is a deletion target.

## Manifest

Return # Vault Cleanup Preview with scan time and threshold, candidate count, and a table: **ID | Source | Proposed destination | Modified at | Age | Bytes | Reason | Links/assets**. Include exact vault-relative paths and recorded modification time/size for follow-up revalidation; a hash is useful for ambiguous files. Follow with **Skipped files and reasons** and **Review needed**. Explicitly state that no source files were moved or deleted.

After producing the manifest, stop. A later user request can select specific manifest IDs for moves. Before such a move, re-read the selected source and its metadata, re-resolve both paths inside the vault, verify links and destination nonexistence, and show a revised proposal for any changed or ambiguous item. Never overwrite a destination; deletion is limited to separately selected and revalidated `content/temp/` rows. Do not interpret the initial cleanup button, a preview, or silence as approval to execute moves or deletion.
