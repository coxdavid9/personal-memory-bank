# GitHub Repo Skill

## Purpose
Private Engineering repo operations for David's Personal Agent.

## Tools
- `github_repo_status` — safe repository metadata read.
- `github_open_pull_requests` — safe list of open PRs.
- `github_pr_status` — safe PR + GitHub Actions check status.
- `github_pull_request` — safe PR details.
- `github_issues` — safe issue list.
- `github_file` — safe file read.
- `github_create_pr` — ask tier; creates a branch, applies the proposed full-file patch, and opens a PR. Never merges.

## Rules
- Never merge.
- Never force-push.
- Never rewrite history.
- Never delete branches.
- Every write requires an explicit approval tap.
- CI is the verification sandbox; the agent reads results and reports them.
