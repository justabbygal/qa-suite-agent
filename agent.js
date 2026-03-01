const { execSync, spawn } = require('child_process');
const { Octokit } = require('octokit');
const path = require('path');
const fs = require('fs');

const REPO_OWNER = process.env.REPO_OWNER || 'justabbygal';
const REPO_NAME = process.env.REPO_NAME || 'qa-suite';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Linear status IDs
const STATUS = {
  IN_PROGRESS: 'e548a1e0-408e-457d-b67b-baa43a571c59',
  REVIEW: 'aafb80ea-4981-4e5c-9031-e3cea7122077'
};

const WORK_DIR = '/tmp/qa-suite-workdir';
const REPO_DIR = path.join(WORK_DIR, REPO_NAME);

// ============================================================
// GITHUB HELPERS
// ============================================================

function getOctokit() {
  return new Octokit({ auth: GITHUB_TOKEN });
}

function gitExec(cmd, cwd) {
  console.log(`  [git] ${cmd}`);
  try {
    return execSync(cmd, {
      cwd: cwd || REPO_DIR,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'QA Suite Agent',
        GIT_AUTHOR_EMAIL: 'agent@qa-suite.dev',
        GIT_COMMITTER_NAME: 'QA Suite Agent',
        GIT_COMMITTER_EMAIL: 'agent@qa-suite.dev'
      },
      timeout: 60000
    }).trim();
  } catch (error) {
    console.error(`  [git] ERROR: ${error.message}`);
    throw error;
  }
}

async function ensureRepo() {
  if (!fs.existsSync(WORK_DIR)) {
    fs.mkdirSync(WORK_DIR, { recursive: true });
  }

  const repoUrl = `https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_OWNER}/${REPO_NAME}.git`;

  if (fs.existsSync(REPO_DIR)) {
    console.log('  Pulling latest from main...');
    gitExec('git checkout main');
    gitExec('git pull origin main');
  } else {
    console.log('  Cloning repo...');
    execSync(`git clone ${repoUrl} ${REPO_NAME}`, {
      cwd: WORK_DIR,
      encoding: 'utf8',
      timeout: 120000
    });
  }
}

function createBranch(branchName) {
  gitExec('git checkout main');
  gitExec('git pull origin main');
  try {
    gitExec(`git branch -D ${branchName}`);
  } catch (e) {
    // Branch doesn't exist locally, that's fine
  }
  gitExec(`git checkout -b ${branchName}`);
}

function commitAndPush(branchName, commitMessage) {
  gitExec('git add -A');

  // Check if there are changes to commit
  try {
    gitExec('git diff --cached --quiet');
    console.log('  No changes to commit');
    return false;
  } catch (e) {
    // Exit code 1 means there ARE changes - this is what we want
  }

  gitExec(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`);
  gitExec(`git push origin ${branchName} --force`);
  return true;
}

async function createAndMergePR(branchName, title, body) {
  const octokit = getOctokit();

  console.log(`  Creating PR: ${title}`);
  const { data: pr } = await octokit.rest.pulls.create({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: title,
    body: body,
    head: branchName,
    base: 'main'
  });

  console.log(`  PR created: #${pr.number} - ${pr.html_url}`);

  // Auto-merge
  console.log(`  Auto-merging PR #${pr.number}...`);
  try {
    await octokit.rest.pulls.merge({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      pull_number: pr.number,
      merge_method: 'squash'
    });
    console.log(`  PR #${pr.number} merged successfully`);
  } catch (error) {
    console.error(`  Failed to auto-merge PR #${pr.number}: ${error.message}`);
    throw error;
  }

  // Clean up remote branch
  try {
    await octokit.rest.git.deleteRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `heads/${branchName}`
    });
  } catch (e) {
    // Not critical if branch cleanup fails
  }

  return pr;
}

// ============================================================
// LINEAR HELPERS
// ============================================================

async function updateLinearStatus(issueId, stateId) {
  console.log(`  Updating Linear issue ${issueId} to state ${stateId}`);
  const query = `mutation { issueUpdate(id: "${issueId}", input: { stateId: "${stateId}" }) { success } }`;

  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': LINEAR_API_KEY
    },
    body: JSON.stringify({ query })
  });

  const result = await response.json();
  if (result.errors) {
    console.error('  Linear API error:', JSON.stringify(result.errors));
  }
  return result;
}

async function addLinearComment(issueId, body) {
  const query = `mutation { commentCreate(input: { issueId: "${issueId}", body: "${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" }) { success } }`;

  await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': LINEAR_API_KEY
    },
    body: JSON.stringify({ query })
  });
}

// ============================================================
// CLAUDE CODE RUNNER
// ============================================================

function runClaudeCode(prompt) {
  return new Promise((resolve, reject) => {
    console.log('  Running Claude Code...');
    console.log(`  Prompt length: ${prompt.length} chars`);

    const startTime = Date.now();

    const claude = spawn('claude', [
      '-p', prompt,
      '--allowedTools', 'Edit,Write,Bash',
      '--output-format', 'text'
    ], {
      cwd: REPO_DIR,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: ANTHROPIC_API_KEY
      },
      timeout: 600000  // 10 minute timeout per task
    });

    let stdout = '';
    let stderr = '';

    claude.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    claude.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    claude.on('close', (code) => {
      const duration = Math.round((Date.now() - startTime) / 1000);
      console.log(`  Claude Code finished in ${duration}s (exit code: ${code})`);

      if (code !== 0 && code !== null) {
        console.error(`  Claude Code stderr: ${stderr.substring(0, 500)}`);
        reject(new Error(`Claude Code exited with code ${code}: ${stderr.substring(0, 500)}`));
      } else {
        resolve(stdout);
      }
    });

    claude.on('error', (error) => {
      reject(error);
    });
  });
}

// ============================================================
// MAIN ORCHESTRATOR
// ============================================================

async function processStory({ storyId, storyTitle, projectName, tasks, context }) {
  console.log(`\nProcessing story: ${storyTitle} (${tasks.length} tasks)`);

  // Step 1: Ensure repo is cloned and up to date
  console.log('\n[1/4] Setting up repository...');
  await ensureRepo();

  // Step 2: Process each task sequentially
  let isFirstTask = true;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const taskNum = i + 1;
    console.log(`\n[Task ${taskNum}/${tasks.length}] ${task.title}`);

    try {
      // Move story to In Progress on first task
      if (isFirstTask) {
        console.log('  Moving Story to In Progress...');
        await updateLinearStatus(storyId, STATUS.IN_PROGRESS);
        isFirstTask = false;
      }

      // Move task to In Progress
      console.log('  Moving Task to In Progress...');
      await updateLinearStatus(task.id, STATUS.IN_PROGRESS);

      // Create branch
      var safeBranchName = 'task/' + task.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 50);
      console.log(`  Branch: ${safeBranchName}`);
      createBranch(safeBranchName);

      // Build the prompt for Claude Code
      var claudePrompt = buildTaskPrompt(task, storyTitle, projectName, context);

      // Run Claude Code
      var output = await runClaudeCode(claudePrompt);
      console.log(`  Claude output: ${output.substring(0, 200)}...`);

      // Commit and push
      var commitMsg = `${task.title}\n\nTask: ${task.id}\nStory: ${storyTitle}`;
      var hasChanges = commitAndPush(safeBranchName, commitMsg);

      if (hasChanges) {
        // Create PR and auto-merge
        var prBody = `## Task\n${task.title}\n\n## Story\n${storyTitle}\n\n## Changes\nAuto-generated by QA Suite Coding Agent\n\n## Task Description\n${task.description.substring(0, 2000)}`;
        var pr = await createAndMergePR(safeBranchName, task.title, prBody);

        // Comment on Linear task with PR link
        await addLinearComment(task.id, `Coding Agent completed this task. PR: ${pr.html_url} (auto-merged)`);
      } else {
        await addLinearComment(task.id, 'Coding Agent ran but produced no file changes for this task.');
      }

      // Move task to Review
      console.log('  Moving Task to Review...');
      await updateLinearStatus(task.id, STATUS.REVIEW);

      // Pull latest main for next task (includes the merge we just did)
      gitExec('git checkout main');
      gitExec('git pull origin main');

      console.log(`  Task ${taskNum} COMPLETE`);

    } catch (error) {
      console.error(`  Task ${taskNum} FAILED: ${error.message}`);

      // Comment the error on the Linear task
      await addLinearComment(
        task.id,
        `Coding Agent encountered an error on this task:\n\n\`\`\`\n${error.message.substring(0, 500)}\n\`\`\`\n\nManual intervention may be needed.`
      );

      // Don't stop the whole story - continue to next task
      // But try to get back to main
      try {
        gitExec('git checkout main');
        gitExec('git pull origin main');
      } catch (e) {
        // If we can't even get back to main, re-clone
        console.log('  Repo in bad state, re-cloning...');
        fs.rmSync(REPO_DIR, { recursive: true, force: true });
        await ensureRepo();
      }
    }
  }

  // Step 3: Move story to Review
  console.log('\nAll tasks processed. Moving Story to Review...');
  await updateLinearStatus(storyId, STATUS.REVIEW);
  await addLinearComment(storyId, `Coding Agent has processed all ${tasks.length} tasks for this story.`);

  console.log(`\n========================================`);
  console.log(`COMPLETE: Story "${storyTitle}"`);
  console.log(`========================================\n`);
}

// ============================================================
// PROMPT BUILDER
// ============================================================

function buildTaskPrompt(task, storyTitle, projectName, context) {
  var prompt = '';

  prompt += 'You are a coding agent for the Fruition QA Suite project. ';
  prompt += 'You are working inside the qa-suite repository. ';
  prompt += 'Your job is to implement the task described below.\n\n';

  prompt += 'IMPORTANT RULES:\n';
  prompt += '- Write clean, production-quality code\n';
  prompt += '- Follow existing patterns in the codebase\n';
  prompt += '- Use the tech stack: Next.js (App Router), Supabase, shadcn/ui, Tailwind CSS, TypeScript\n';
  prompt += '- Create any necessary files and directories\n';
  prompt += '- If this is an early task and the project structure does not exist yet, create it\n';
  prompt += '- Do NOT modify package.json unless the task specifically requires new dependencies\n';
  prompt += '- Do NOT run npm install or start dev servers\n';
  prompt += '- Focus only on the specific task - do not implement other tasks\n\n';

  if (context) {
    prompt += '## Initiative Context\n';
    prompt += context.substring(0, 4000);
    prompt += '\n\n';
  }

  prompt += '## Current Story: ' + storyTitle + '\n';
  prompt += '## Project: ' + (projectName || 'QA Suite') + '\n\n';

  prompt += '## YOUR TASK\n';
  prompt += '### ' + task.title + '\n\n';
  prompt += task.description + '\n\n';

  prompt += 'Implement this task now. Create and edit the necessary files.';

  return prompt;
}

module.exports = { processStory };
