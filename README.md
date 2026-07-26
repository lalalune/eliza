# Local recovery archive — 2026-07-26

This branch consolidates the temporary recovery, history, stash, and reflog backup branches created during the July 26 local-loss audit.
Every former branch tip is a parent of this archive commit. RECOVERY-MANIFEST.tsv maps each deleted branch name to its exact commit SHA.
Restore any item with: git branch <new-name> <commit-sha>
