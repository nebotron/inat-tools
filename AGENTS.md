## Cursor Cloud specific instructions

- **After every change** (each logical edit or batch of edits), **commit and push immediately to `main`**. Do not wait until the end of a long session, and **do not prompt** the user for confirmation before committing or pushing.
- Commit and push any code changes at the end of every prompt as well, if anything remains uncommitted. Do this **directly on `main`** without asking for confirmation first.
- Use `main` as the working branch: checkout `main`, pull, make edits, commit, push. Do not create feature branches or open pull requests unless the user explicitly asks for that workflow.
- **Merge and push to `main` without prompting** the user (no “should I merge?”). If work exists on another branch, merge it into `main` yourself and push when it is safe to do so.
- If you ever end up on a feature branch (e.g. leftover state), merge it into `main` (fast-forward or merge commit) and push `main` yourself. Do not wait on PR approval unless the user explicitly wants a PR-only workflow.
- Never open draft pull requests.
