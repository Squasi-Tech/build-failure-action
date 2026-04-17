import * as core from "@actions/core";
import * as github from "@actions/github";
import { HttpClient } from "@actions/http-client";

const MAX_LOG_BYTES = 50 * 1024; // 50 KB

interface IngestRequest {
  ai_provider: string;
  ai_key: string;
  ai_model?: string;
  ai_base_url?: string;
  github_token: string;
  repo: string;
  workflow: string;
  job: string;
  run_id: number;
  sha: string;
  pr_number?: number;
  logs: string;
}

interface IngestResponse {
  dashboard_url?: string;
  error?: string;
}

/**
 * Extract a ~50 KB window of log text centered on the first error-like line.
 * If no obvious error marker is found, return the last 50 KB (the tail is
 * usually most relevant for failures).
 */
function truncateLogs(raw: string): string {
  if (raw.length <= MAX_LOG_BYTES) {
    return raw;
  }

  const errorPatterns = [
    /\bERROR\b/i,
    /\bFAILED\b/i,
    /\bFATAL\b/i,
    /\bException\b/,
    /\bTraceback\b/,
    /\bpanic:/,
    /exit code [1-9]/i,
    /\bsignal:\s+killed\b/i,
    /\bOOMKilled\b/i,
    /\bCommand failed\b/i,
  ];

  let errorIndex = -1;
  for (const pattern of errorPatterns) {
    const match = raw.search(pattern);
    if (match !== -1) {
      errorIndex = match;
      break;
    }
  }

  if (errorIndex === -1) {
    // No recognizable error marker — return the tail of the log.
    return raw.slice(-MAX_LOG_BYTES);
  }

  // Center the window on the first error match.
  const halfWindow = Math.floor(MAX_LOG_BYTES / 2);
  let start = errorIndex - halfWindow;
  let end = errorIndex + halfWindow;

  if (start < 0) {
    end = Math.min(raw.length, end - start);
    start = 0;
  }
  if (end > raw.length) {
    start = Math.max(0, start - (end - raw.length));
    end = raw.length;
  }

  return raw.slice(start, end);
}

/**
 * Attempt to determine the PR number from the event payload or the workflow
 * run's pull_requests list.
 */
function resolvePrNumber(): number | undefined {
  const payload = github.context.payload;

  // pull_request / pull_request_target events
  if (payload.pull_request?.number) {
    return payload.pull_request.number as number;
  }

  // workflow_run event — may carry associated PRs
  if (
    payload.workflow_run?.pull_requests &&
    Array.isArray(payload.workflow_run.pull_requests) &&
    payload.workflow_run.pull_requests.length > 0
  ) {
    return payload.workflow_run.pull_requests[0].number as number;
  }

  return undefined;
}

/**
 * Download the combined logs for the current workflow run and locate the
 * section belonging to the current (failed) job.
 */
async function fetchFailedJobLogs(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  runId: number,
  jobName: string
): Promise<string> {
  // First try to find the specific job and download its logs.
  const { data: jobsData } = await octokit.rest.actions.listJobsForWorkflowRun(
    {
      owner,
      repo,
      run_id: runId,
      filter: "latest",
    }
  );

  // Match by job name. GitHub Actions uses the job key or the `name:` field.
  const failedJob = jobsData.jobs.find(
    (j) =>
      (j.name === jobName || j.name.startsWith(jobName)) &&
      j.conclusion === "failure"
  );

  if (failedJob) {
    try {
      const logsResp = await octokit.rest.actions.downloadJobLogsForWorkflowRun(
        {
          owner,
          repo,
          job_id: failedJob.id,
        }
      );
      // The response is a redirect-followed string body.
      if (typeof logsResp.data === "string") {
        return logsResp.data;
      }
      return String(logsResp.data);
    } catch (err) {
      core.warning(
        `Failed to download job-specific logs, falling back to run logs: ${err}`
      );
    }
  }

  // Fallback: download the full run log archive. The REST endpoint returns a
  // 302 redirect to a zip, but octokit follows it and returns the raw bytes.
  // Parsing zip in-action is heavy; instead we fall back to listing all failed
  // jobs and concatenating their step annotations.
  const annotations: string[] = [];
  for (const job of jobsData.jobs.filter((j) => j.conclusion === "failure")) {
    annotations.push(`=== Job: ${job.name} (id ${job.id}) ===`);
    if (job.steps) {
      for (const step of job.steps) {
        if (step.conclusion === "failure") {
          annotations.push(
            `  Step "${step.name}" (#${step.number}): ${step.status} / ${step.conclusion}`
          );
        }
      }
    }
  }

  if (annotations.length === 0) {
    return "(no failed job logs could be retrieved)";
  }

  return annotations.join("\n");
}

async function run(): Promise<void> {
  try {
    // ---- Inputs ----
    const repoKey = core.getInput("repo-key", { required: true });
    const aiProvider = core.getInput("ai-provider", { required: true });
    const aiKey = core.getInput("ai-key", { required: true });
    const aiModel = core.getInput("ai-model") || undefined;
    const aiBaseUrl = core.getInput("ai-base-url") || undefined;
    const endpoint = core.getInput("endpoint") || "https://app.gitflow-rca.com";

    const githubToken = core.getInput("github-token") || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
    if (!githubToken) {
      core.warning(
        "No GITHUB_TOKEN found. Add 'env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }' to your workflow step for full log access."
      );
    }

    // ---- Context ----
    const { owner, repo } = github.context.repo;
    const runId = github.context.runId;
    const sha = github.context.sha;
    const workflow =
      github.context.workflow || process.env.GITHUB_WORKFLOW || "unknown";
    const job = process.env.GITHUB_JOB || "unknown";
    const prNumber = resolvePrNumber();

    core.info(
      `Collecting failure logs for ${owner}/${repo} run=${runId} job=${job}`
    );

    // ---- Fetch logs ----
    let logs = "";
    if (githubToken) {
      const octokit = github.getOctokit(githubToken);
      const rawLogs = await fetchFailedJobLogs(
        octokit,
        owner,
        repo,
        runId,
        job
      );
      logs = truncateLogs(rawLogs);
    } else {
      logs = "(No GITHUB_TOKEN. Logs could not be fetched. Add GITHUB_TOKEN to your workflow step.)";
    }

    core.info(`Log payload size: ${logs.length} bytes`);

    // ---- Build payload ----
    const body: IngestRequest = {
      ai_provider: aiProvider,
      ai_key: aiKey,
      ai_model: aiModel,
      ai_base_url: aiBaseUrl,
      github_token: githubToken,
      repo: `${owner}/${repo}`,
      workflow,
      job,
      run_id: runId,
      sha,
      pr_number: prNumber,
      logs,
    };

    // ---- Send to backend ----
    const ingestUrl = `${endpoint.replace(/\/+$/, "")}/v1/rca/ingest`;
    core.info(`Posting RCA payload to ${ingestUrl}`);

    const http = new HttpClient("gitflow-rca-action", [], {
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
        `RCA ingest returned HTTP ${response.statusCode}: ${JSON.stringify(response.result)}`
      );
      return;
    }

    const dashboardUrl = response.result?.dashboard_url;
    if (dashboardUrl) {
      core.info(`Dashboard URL: ${dashboardUrl}`);

      // Write to step summary so it is visible in the Actions UI.
      await core.summary
        .addHeading("GitFlow RCA", 3)
        .addLink("View Root Cause Analysis", dashboardUrl)
        .write();
    } else {
      core.info("RCA ingested successfully (no dashboard URL returned).");
    }
  } catch (error) {
    // Never fail the workflow because of an RCA reporting issue.
    const message = error instanceof Error ? error.message : String(error);
    core.warning(`GitFlow RCA action encountered an error: ${message}`);
  }
}

run();
