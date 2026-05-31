# BuildFailure GitHub Action

Trigger an AI-powered root cause analysis on every CI/CD failure.

> **Free plan: 10 RCAs to try it out.** Paid plans start at $9/mo with 100–10,000 RCAs and team features. See [pricing](https://buildfailure.com/#pricing). You bring your own AI provider key — we never store it.

## Usage

Drop this step at the end of any job. It only runs when an earlier step fails.

```yaml
- name: BuildFailure RCA
  if: failure()
  uses: Squasi-Tech/build-failure-action@v2
  with:
    repo-key: ${{ secrets.RCA_AGENT_KEY }}
    ai-provider: gemini
    ai-key: ${{ secrets.RCA_AI_KEY }}
```

That's the whole integration. No `permissions:` block, no `GITHUB_TOKEN` plumbing — the BuildFailure backend fetches your failed job's logs server-side using the GitHub OAuth token from your buildfailure.com account.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `repo-key` | Yes | Your repository key from the BuildFailure dashboard (Repos → Connect). |
| `ai-provider` | Yes | One of: `anthropic`, `gemini`, `vertex`, `openrouter`, `openai_compat`. |
| `ai-key` | Yes | API key for your chosen AI provider. For `vertex`, pass `project_id:region`. |
| `ai-model` | No | Override the default model for your provider. |
| `ai-base-url` | No | Custom endpoint URL (required for `openai_compat`). |
| `endpoint` | No | BuildFailure backend URL. Defaults to `https://buildfailure.com`. Must be a `buildfailure.com` host or `localhost` — other endpoints are rejected. |

## Supported AI providers

| Provider | `ai-provider` value | Notes |
|----------|--------------------|-------|
| Google Gemini | `gemini` | Free tier available — fastest way to start. |
| Anthropic | `anthropic` | Excellent reasoning quality. |
| Google Vertex AI | `vertex` | Use your existing GCP project. `ai-key` is `project_id:region`. |
| OpenRouter | `openrouter` | One key, 100+ models including Claude, Gemini, Llama. |
| OpenAI-compatible | `openai_compat` | Bring your own endpoint (Ollama, vLLM, Together, etc.). |

## How it works

1. The action runs after a failing step and posts the workflow run metadata (`owner/repo`, `run_id`, `sha`, `job`) to the BuildFailure backend.
2. The backend polls the GitHub Actions API until the failed job finalises, then fetches the full job logs server-side using the GitHub OAuth token stored when you connected your repo on buildfailure.com.
3. Multiple AI expert agents analyse the logs, workflow config, repo context, and commit diff in parallel — using your AI provider key.
4. A validated root cause, a same-language remediation script, and a confidence score are posted to your dashboard (and to PR/Slack/Discord/email if configured).

The action itself never reads runner files or captures logs — that closes the door on payload-inflation and secret-exfiltration via the CI workflow.

## Security

- **No log content leaves your runner via this action.** Logs are fetched server-side from the GitHub API by the BuildFailure backend.
- Your AI key is forwarded once per request and never stored on our side.
- The `endpoint` input is allowlisted to `*.buildfailure.com` — it cannot be redirected to a third-party server.
- The action will never fail your workflow; reporting errors surface as warnings only.

## Setup

Full setup guide: <https://buildfailure.com/docs>
