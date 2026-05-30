import * as core from "@actions/core";
import * as github from "@actions/github";
import { HttpClient } from "@actions/http-client";

/**
 * BuildFailure GitHub Action — v2.
 *
 * The action is now a thin metadata-only ping: when a job fails, post the
 * workflow run identifiers to the BuildFailure backend. The backend uses its
 * stored GitHub OAuth token to fetch the failed job's logs authoritatively.
 *
 * The action deliberately does NOT capture or forward log content. Doing so
 * would let a workflow author inflate payloads, exfiltrate runner secrets,
 * or poison the RCA with synthetic input. Anything the LLM sees is fetched
 * server-side from the GitHub API the BuildFailure backend already trusts.
 */

interface IngestRequest {
  ai_provider: string;
  ai_key: string;
  ai_model?: string;
  ai_base_url?: string;
  repo: string;
  workflow: string;
  job: string;
  run_id: number;
  sha: string;
  pr_number?: number;
}

interface IngestResponse {
  dashboard_url?: string;
  error?: string;
}

// Only allow posting to buildfailure.com (any subdomain), or localhost for
// dev. Prevents workflow authors from redirecting RCA data to third-party
// servers via the `endpoint` input.
const ENDPOINT_ALLOWLIST =
  /^https:\/\/([a-zA-Z0-9.-]+\.)?buildfailure\.com(:\d+)?\/?$|^https?:\/\/localhost(:\d+)?\/?$/;

function validateEndpoint(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  if (!ENDPOINT_ALLOWLIST.test(trimmed + "/")) {
    throw new Error(
      `endpoint ${trimmed} is not allowed. Must be https://*.buildfailure.com or http(s)://localhost.`
    );
  }
  return trimmed;
}

function resolvePrNumber(): number | undefined {
  const payload = github.context.payload;

  if (payload.pull_request?.number) {
    return payload.pull_request.number as number;
  }
  if (
    payload.workflow_run?.pull_requests &&
    Array.isArray(payload.workflow_run.pull_requests) &&
    payload.workflow_run.pull_requests.length > 0
  ) {
    return payload.workflow_run.pull_requests[0].number as number;
  }
  return undefined;
}

async function run(): Promise<void> {
  try {
    const repoKey = core.getInput("repo-key", { required: true });
    const aiProvider = core.getInput("ai-provider", { required: true });
    const aiKey = core.getInput("ai-key", { required: true });
    const aiModel = core.getInput("ai-model") || undefined;
    const aiBaseUrl = core.getInput("ai-base-url") || undefined;
    const endpoint = validateEndpoint(
      core.getInput("endpoint") || "https://buildfailure.com"
    );

    // Context from GitHub Actions runtime. No log scraping happens here.
    const { owner, repo } = github.context.repo;
    const runId = github.context.runId;
    const sha = github.context.sha;
    const workflow =
      github.context.workflow || process.env.GITHUB_WORKFLOW || "unknown";
    const job = process.env.GITHUB_JOB || "unknown";
    const prNumber = resolvePrNumber();

    core.info(
      `BuildFailure: pinging backend for ${owner}/${repo} run=${runId} job=${job}`
    );

    const body: IngestRequest = {
      ai_provider: aiProvider,
      ai_key: aiKey,
      ai_model: aiModel,
      ai_base_url: aiBaseUrl,
      repo: `${owner}/${repo}`,
      workflow,
      job,
      run_id: runId,
      sha,
      pr_number: prNumber,
    };

    const ingestUrl = `${endpoint}/v1/rca/ingest`;
    const http = new HttpClient("build-failure-action", [], {
      headers: {
        "Content-Type": "application/json",
        "X-RCA-Repo-Key": repoKey,
      },
    });

    const response = await http.postJson<IngestResponse>(
      ingestUrl,
      body as unknown as Record<string, unknown>
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      core.warning(
        `BuildFailure ingest returned HTTP ${response.statusCode}: ${JSON.stringify(response.result)}`
      );
      return;
    }

    const dashboardUrl = response.result?.dashboard_url;
    if (dashboardUrl) {
      core.info(`Dashboard URL: ${dashboardUrl}`);
      await core.summary
        .addHeading("BuildFailure", 3)
        .addLink("View Root Cause Analysis", dashboardUrl)
        .write();
    } else {
      core.info("RCA ingested successfully (no dashboard URL returned).");
    }
  } catch (error) {
    // Never fail the workflow because of an RCA reporting issue.
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`BuildFailure action encountered an error: ${message}`);
  }
}

run();
