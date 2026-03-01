# QA Suite Coding Agent

Automated coding agent service for the Fruition QA Suite initiative. Receives task assignments via webhook from n8n, runs Claude Code CLI headlessly to implement each task, and creates auto-merged PRs on GitHub.

## Architecture

```
n8n (orchestrator) → webhook → this service → Claude Code CLI → GitHub PRs
                                     ↕
                                  Linear API (status updates)
```

## Flow

1. **n8n triggers** when a Story moves to "To Do"
2. n8n sends a webhook with the story + all subtasks
3. This service processes each subtask sequentially:
   - Moves Story to "In Progress" (first task only)
   - Moves subtask to "In Progress"
   - Creates a git branch
   - Runs Claude Code to implement the task
   - Commits, pushes, creates PR, auto-merges
   - Moves subtask to "Review"
4. After all subtasks: moves Story to "Review"

## Deploy to Railway

1. Connect this repo to Railway
2. Set environment variables (see `.env.example`)
3. Railway auto-deploys from main branch

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for Claude Code CLI |
| `GITHUB_TOKEN` | Yes | GitHub PAT with `repo` scope |
| `LINEAR_API_KEY` | Yes | Linear API key (no Bearer prefix) |
| `WEBHOOK_SECRET` | No | Secret to verify n8n webhook requests |
| `REPO_OWNER` | No | GitHub repo owner (default: justabbygal) |
| `REPO_NAME` | No | GitHub repo name (default: qa-suite) |

## Webhook API

### `POST /run`

```json
{
  "storyId": "linear-issue-id",
  "storyTitle": "Story title",
  "projectName": "Project name",
  "context": "Cached initiative context from Notion",
  "tasks": [
    {
      "id": "linear-issue-id",
      "title": "Task title",
      "description": "Full task description with specs"
    }
  ]
}
```

### `GET /`

Health check. Returns `{ status: "ok" }`.
