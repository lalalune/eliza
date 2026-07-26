#!/usr/bin/env bash
# Enumerates the source and unit-test files a pull request actually changed, in
# the GITHUB_OUTPUT heredoc format the coverage-gate workflow consumes. It is
# invoked by .github/workflows/coverage-gate.yml as
# `coverage-changed-files.sh "$BASE" "$HEAD" >> "$GITHUB_OUTPUT"`, and lives as a
# standalone script (rather than inline YAML) so its path/diff boundary rules are
# regression-tested by coverage-changed-files.self-test.mjs against a real git
# repo.
#
# The diff is three-dot: it walks from `git merge-base BASE HEAD` to HEAD, so
# only files the branch itself touched enter the lane. A plain two-dot
# `BASE..HEAD` diff would count develop-side files the branch never touched as
# "changed" whenever the branch trails develop, dragging unrelated tests into the
# gate (issue #15845). Test files are bucketed into a Bun-native lane and a
# Vitest lane by which runner they import. Nonstandard guarded tests are emitted
# separately so the workflow fails explicitly instead of treating a path
# allowlist as proof that another lane ran them; canonical e2e/live suites and
# Android specs remain outside this fast unit lane.
set -euo pipefail

BASE=$1
HEAD=$2
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
NODE_SELF_TEST_MANIFEST="$SCRIPT_DIR/coverage-node-self-tests.txt"
SUBPROCESS_SOURCE_MANIFEST=${COVERAGE_SUBPROCESS_SOURCE_MANIFEST:-"$SCRIPT_DIR/coverage-subprocess-sources.txt"}
NONSTANDARD_LIVE_TEST_MANIFEST=${COVERAGE_NONSTANDARD_LIVE_TEST_MANIFEST:-"$SCRIPT_DIR/coverage-nonstandard-live-tests.txt"}

if [ ! -f "$NONSTANDARD_LIVE_TEST_MANIFEST" ]; then
  echo "coverage-changed-files: missing nonstandard live-test manifest: $NONSTANDARD_LIVE_TEST_MANIFEST" >&2
  exit 1
fi

# Fail fast: an empty merge-base means the two commits share no history (bad
# fetch depth / wrong refs), which would otherwise silently diff the entire tree.
MERGE_BASE=$(git merge-base "$BASE" "$HEAD")
if [ -z "$MERGE_BASE" ]; then
  echo "coverage-changed-files: no merge-base between $BASE and $HEAD" >&2
  exit 1
fi

REPO_ROOT=$(git rev-parse --show-toplevel)
NONSTANDARD_LIVE_TEST_REPO_PATH=$(
  git -C "$REPO_ROOT" ls-files --full-name -- "$NONSTANDARD_LIVE_TEST_MANIFEST"
)
if [ -z "$NONSTANDARD_LIVE_TEST_REPO_PATH" ]; then
  echo "coverage-changed-files: nonstandard live-test manifest must be tracked inside the repository" >&2
  exit 1
fi
if ! git cat-file -e "$HEAD:$NONSTANDARD_LIVE_TEST_REPO_PATH" 2>/dev/null; then
  echo "coverage-changed-files: nonstandard live-test manifest is absent from HEAD" >&2
  exit 1
fi

HEAD_GUARDED_TESTS=$(git show "$HEAD:$NONSTANDARD_LIVE_TEST_REPO_PATH")
if git cat-file -e "$MERGE_BASE:$NONSTANDARD_LIVE_TEST_REPO_PATH" 2>/dev/null; then
  BASE_HAS_GUARDED_TEST_MANIFEST=1
  BASE_GUARDED_TESTS=$(git show "$MERGE_BASE:$NONSTANDARD_LIVE_TEST_REPO_PATH")
else
  # The branch that introduces this contract has no predecessor to protect.
  # Every later edit is sealed and emitted as a failing contract change.
  BASE_HAS_GUARDED_TEST_MANIFEST=0
  BASE_GUARDED_TESTS=
fi

# Historical guarded names cannot silently disappear from the unit lanes. The
# union of the merge-base and HEAD manifests prevents a same-PR removal or
# rename from erasing the old guarded path before classification.
is_guarded_test() {
  if printf '%s\n' "$HEAD_GUARDED_TESTS" | grep -Fxq -- "$1"; then
    return 0
  fi
  if [ "$BASE_HAS_GUARDED_TEST_MANIFEST" -eq 1 ] && \
    printf '%s\n' "$BASE_GUARDED_TESTS" | grep -Fxq -- "$1"; then
    return 0
  fi
  return 1
}

# Excluded from both unit lanes: canonical e2e/live suites (by filename and by
# a `test/e2e/` directory segment) and Android specs. These run in dedicated
# lanes and pull in heavy harnesses that the changed-file coverage gate must not.
is_excluded_test() {
  case "$1" in
    *.e2e.test.*|*.live.test.*|*.real.test.*|*.real.e2e.test.*|packages/app/test/android/*.android.spec.*) return 0 ;;
    packages/test/cloud-e2e/tests/*.spec.*) return 0 ;;
    */test/e2e/*|test/e2e/*|*/tests/e2e/*|tests/e2e/*|*/e2e/*.test.*|e2e/*.test.*) return 0 ;;
  esac
  return 1
}

changed_source() {
  {
    git diff --name-only --diff-filter=ACMRT "$MERGE_BASE" "$HEAD" -- \
      '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.mts' '*.cts' \
      | grep -vE '(^|/)(__tests__|__e2e__|test|tests|generated)/|([.-]e2e|[.]generated|[.]test|[.]spec|[.]stories)[.](ts|tsx|js|jsx|mjs|cjs|mts|cts)$|(^|/)(vite|vitest)([.][^./]+)?[.]config([.][^.]+)?[.](ts|js|mts|mjs|cts|cjs)$|(^|/)scripts/playwright[^/]*[.](ts|js|mts|mjs|cts|cjs)$' || true
  } \
    | while IFS= read -r file; do
        [ -f "$file" ] || continue
        grep -Fxq "$file" "$NODE_SELF_TEST_MANIFEST" && continue
        grep -Fxq "$file" "$SUBPROCESS_SOURCE_MANIFEST" && continue
        echo "$file"
      done \
    | node --no-warnings "$SCRIPT_DIR/coverage-source-classifier.mjs" --base "$MERGE_BASE"
}

changed_subprocess_sources() {
  git diff --name-only --diff-filter=ACMRT "$MERGE_BASE" "$HEAD" \
    | while IFS= read -r file; do
        [ -f "$file" ] || continue
        if grep -Fxq "$file" "$SUBPROCESS_SOURCE_MANIFEST"; then
          echo "$file"
        fi
      done
}

changed_tests() {
  git diff --name-status -M -z "$MERGE_BASE" "$HEAD" -- \
    '*.test.ts' '*.test.tsx' '*.test.js' '*.test.jsx' '*.test.mjs' \
    '*.test.cjs' '*.test.mts' '*.test.cts' \
    '*.spec.ts' '*.spec.tsx' '*.spec.js' '*.spec.jsx' '*.spec.mjs' \
    '*.spec.cjs' '*.spec.mts' '*.spec.cts' \
    | while IFS= read -r -d '' status; do
        case "$status" in
          R*|C*)
            IFS= read -r -d '' old_path
            IFS= read -r -d '' new_path
            printf '%s\n%s\n' "$old_path" "$new_path"
            ;;
          *)
            IFS= read -r -d '' changed_path
            printf '%s\n' "$changed_path"
            ;;
        esac
      done \
    | LC_ALL=C sort -u
}

changed_node_self_tests() {
  git diff --name-only --diff-filter=ACMRT "$MERGE_BASE" "$HEAD" \
    | while IFS= read -r file; do
        [ -f "$file" ] || continue
        if grep -Fxq "$file" "$NODE_SELF_TEST_MANIFEST"; then
          echo "$file"
        fi
      done
}

changed_guarded_tests() {
  changed_tests | while IFS= read -r file; do
    # Keep deleted/renamed entries visible: a stale manifest entry is still a
    # guarded-test contract change and must fail rather than vanish behind -f.
    if is_guarded_test "$file"; then
      echo "$file"
    fi
  done
}

changed_guarded_manifest() {
  # Bootstrap is the sole exception: there is no merge-base contract to
  # preserve when this manifest is first introduced.
  if [ "$BASE_HAS_GUARDED_TEST_MANIFEST" -eq 1 ] && \
    ! git diff --quiet "$MERGE_BASE" "$HEAD" -- "$NONSTANDARD_LIVE_TEST_REPO_PATH"; then
    echo "$NONSTANDARD_LIVE_TEST_REPO_PATH"
  fi
}

echo 'files<<EOF'
changed_source
echo 'EOF'

echo 'subprocess_files<<EOF'
changed_subprocess_sources
echo 'EOF'

echo 'node_tests<<EOF'
changed_node_self_tests
echo 'EOF'

echo 'guarded_tests<<EOF'
changed_guarded_tests
echo 'EOF'

echo 'guarded_manifest_changes<<EOF'
changed_guarded_manifest
echo 'EOF'

echo 'bun_tests<<EOF'
changed_tests | while IFS= read -r file; do
  [ -f "$file" ] || continue
  is_guarded_test "$file" && continue
  is_excluded_test "$file" && continue
  if grep -Eq "from ['\"]vitest['\"]|require\\(['\"]vitest['\"]\\)" "$file"; then
    continue
  fi
  if grep -Eq "from ['\"]@?playwright/test['\"]|require\\(['\"]@?playwright/test['\"]\\)" "$file"; then
    continue
  fi
  echo "$file"
done
echo 'EOF'

echo 'vitest_tests<<EOF'
changed_tests | while IFS= read -r file; do
  [ -f "$file" ] || continue
  is_guarded_test "$file" && continue
  is_excluded_test "$file" && continue
  if grep -Eq "from ['\"]@?playwright/test['\"]|require\\(['\"]@?playwright/test['\"]\\)" "$file"; then
    continue
  fi
  if grep -Eq "from ['\"]vitest['\"]|require\\(['\"]vitest['\"]\\)" "$file"; then
    echo "$file"
  fi
done
echo 'EOF'
