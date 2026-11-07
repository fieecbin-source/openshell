# Task 6 gpt S08 package scan

Baseline: `9b05523777b38d5f1e1653abf9b57449f88c18cc`. Only `scripts/check-package.mjs` and `scripts/check-package.test.mjs` changed.

Root cause: the recursive regex string tokenizer treats quotes inside JavaScript regular expressions as string boundaries. It then scans synthetic fragments crossing state initialization/object code as secret assignments. A safe synthetic bundle reproduces the false positive. A separate synthetic regression exposes escaped-key false negatives.

Fix: reuse the existing declared frontend TypeScript parser, with `createRequire(frontend/package.json)`, to identify real identifier/string nodes and literal start positions following `:` or `=`. Decode strings through the parser before recursively inspecting serialized content. Include the exact `api-key` binary expression used by plain YAML and recursively inspect real leading/trailing comment ranges, preserving secrets in comments and non-JS textual carriers. The existing 16-character literal threshold, forbidden-content rules, forbidden paths and private fingerprints remain. No dependency or lock file changed; no code-shaped value allowlist added.

| Command/check | Exit | Evidence |
|---|---:|---|
| `node --test scripts/check-package.test.mjs` before source fix | 1 | `package-red.log`: original 4 tests pass, new safe-JS and escaped-key regressions fail |
| Same command after initial source fix | 0 | `package-green.log`: 6 tests pass, 0 fail, 0 skipped |
| Same command with review regressions before follow-up fix | 1 | `package-review-red-with-comments.log`: 5 pass, 2 fail; bare/multiline/serialized hyphen keys and comment detection need preserving |
| Same command after final review fix | 0 | `package-review-green.log`: 7 tests pass, 0 fail, 0 skipped |
| `node scripts/check-package.mjs frontend/dist` after final review fix | 0 | `package-review-dist.log`: actual current dist, 35 files scanned |
| `node --check scripts/check-package.mjs` | 0 | Syntax verified |
| `node --check scripts/check-package.test.mjs` | 0 | Syntax verified |
| `git diff --check -- scripts/check-package.mjs scripts/check-package.test.mjs` | 0 | No whitespace errors |

The real-dist scan used `APPDATA`, `HOME` and `USERPROFILE` all set to `audit/remediation-task6/gpt/package-profile`, with empty `OPENSHELL_PRIVATE_MARKERS`. No real user database was read. Logs show file names and failure categories, never suspicious candidate values; synthetic fixture values are explicitly synthetic.

The added regressions cover regex quotes/state/object fragments, true secret values resembling code, Unicode-escaped keys/values, nested JSON serialization, direct property assignment, bare/quoted/hyphenated data keys (including multiline and serialized YAML), line/block/trailing/serialized comments, RSA/EC private-key headers and binary private fingerprints. The original four tests and their assertions remain. A synthetic old/new differential also confirms hash comments, HTML comments, Markdown code fences and doc comments remain detected.

Independent commit group: the two script files together, no source/API/schema dependency. The checker now requires frontend development dependencies installed (TypeScript is already part of the normal build/CI environment). Not checked: installer artifacts, rebuilt dist, compressed payload extraction, arbitrary obfuscation/expression evaluation. No frontend rebuild, commit or push performed.
