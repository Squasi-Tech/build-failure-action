# gitflow-rca GitHub Action

Automatically capture deployment failure logs and trigger AI-powered root cause analysis.

## Usage

```yaml
name: RCA on failure
on:
  workflow_run:
    workflows: ["CI", "Deploy"]
    types: [completed]

jobs:
  rca:
    if: ${{ github.event.workflow_run.conclusion == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - uses: milgelren/gitflow-rca-action@v1
        with:
          repo-key: ${{ secrets.RCA_AGENT_KEY }}
          ai-provider: anthropic
          ai-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `repo-key` | Yes | Your repository key from the gitflow-rca dashboard |
| `ai-provider` | Yes | AI provider: `anthropic`, `gemini`, `vertex`, `openrouter`, `openai_compat` |
| `ai-key` | Yes | API key for your chosen AI provider |
| `ai-model` | No | Override the default model for your provider |
| `ai-base-url` | No | Custom endpoint URL (required for `openai_compat`) |
| `endpoint` | No | gitflow-rca backend URL (defaults to hosted service) |

## Supported AI Providers

| Provider | `ai-provider` value | Default model |
|----------|-------------------|---------------|
| Anthropic | `anthropic` | claude-sonnet-4-20250514 |
| Google Gemini | `gemini` | gemini-2.0-flash |
| Google Vertex AI | `vertex` | claude-sonnet-4@20250514 |
| OpenRouter | `openrouter` | anthropic/claude-sonnet-4 |
| Custom (OpenAI-compatible) | `openai_compat` | (set via `ai-model`) |

## How it works

1. Detects the failed job in the current workflow run
2. Downloads the failure logs via the GitHub API
3. Truncates to ~50KB centered on the first error
4. Sends logs to the gitflow-rca backend for analysis
5. Prints the RCA dashboard link in the step summary

## Security

- Your AI key is passed per-request and never stored
- Only failed job logs are sent, not your source code
- Communication is encrypted via HTTPS
- The action never fails your workflow (errors are warnings only)

## Setup

Full setup guide: [docs](https://gitflow-rca.dev/docs)
