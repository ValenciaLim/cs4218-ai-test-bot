
# CS4218 AI Test Bot

This repository is an AI-driven helper that analyzes selected project files, generates Jest test templates and user stories via OpenAI, and can post user stories to the Trofos project board using Playwright.

## Prerequisites
- Node.js (LTS)
- `OPENAI_API_KEY` environment variable set for OpenAI API calls
- `AUTHOR` environment variable (your Trofos display name) for posting stories

## Setup
1. Install dependencies:

```bash
npm install
```

2. Create a Trofos session (if you plan to post stories interactively):

```bash
# Run the login helper and sign in with NUS as prompted
node login.js
```

This saves `trofos-session.json` in the repo root.

## Configuration
- `PROJECT_REPO`: path to the target project where generated tests should be written. Can be set in `.env` or exported in your shell. Example:

```bash
export PROJECT_REPO=/Users/you/Developer/cs4218-2520-ecom-project-cs4218-2520-team21
```

- `OPENAI_MODEL` (optional): override model used for completions (default: `gpt-4`).
- `OPENAI_CONCURRENCY` (optional): limit concurrent OpenAI requests (default: 3).

## How selected files & epics work
- Configuration of which files to process lives in `selectedFiles.json`.
- You can specify backend files and functions to target. You may also add an `epics` object in `selectedFiles.json` to map file paths to Trofos epics (the orchestrator will attach these to generated stories).

Example `selectedFiles.json` entries:

- `frontend`: array of frontend file paths to analyze.
- `backend`: object mapping backend file paths to arrays of function names.
- `epics`: object mapping file paths to epic names used when posting stories.

## Typical workflow

1. Run the orchestrator `index.js` which:
	- Generates a user story for each selected file using OpenAI.
	- Applies `epic` from `selectedFiles.json` (if present).
	- Posts the story to Trofos (requires `trofos-session.json`).
	- Generates unit-test templates and writes them into `PROJECT_REPO`.
	- Runs tests in `PROJECT_REPO` and generates an HTML report.

2. Inspect `unit-test-report.html` for results and generated test-file paths.

## Safety & troubleshooting
- Ensure `PROJECT_REPO` is the absolute path to the repository that should receive generated test files — the orchestrator writes tests into that path.
- If generated tests appear in the wrong repo, confirm the `PROJECT_REPO` value visible to Node:

```bash
node -e "require('dotenv').config(); console.log(process.env.PROJECT_REPO)"
```

- If OpenAI calls fail, check `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_CONCURRENCY` settings.
- If Playwright posting fails, ensure `trofos-session.json` exists (run `node login.js`).

## Notes
- `utils/fileUtils.js` uses an AST-based extractor (Acorn) to find functions; this is more accurate than regex but not perfect.
- The orchestrator now uses a concurrency-limited OpenAI queue and retries transient errors.
