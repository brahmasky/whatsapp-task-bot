/**
 * /dev Task
 *
 * Handles two kinds of requests:
 *
 *   Q&A  — "how does X work?", "why does Y do Z?"
 *     Claude Code reads the codebase and answers directly. No confirmation needed.
 *
 *   Build — "add X", "fix Y", "refactor Z"
 *     Phase 1: Claude Code reads the codebase and outputs a plan (no file writes).
 *              User can confirm, give feedback to revise, or discard.
 *     Phase 2: Claude Code executes the confirmed plan in a git worktree under /tmp/.
 *              User reviews the diff and confirms or discards.
 *
 *   confirm (diff) → git merge → nodemon restarts with new code
 *   discard        → worktree + branch deleted, main tree unchanged
 *
 * Intent detection: the planning prompt asks Claude Code to end its response with
 * [ANSWER] (Q&A) or [PLAN] (build task). The bot branches on this marker.
 */

import { spawn, execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../../utils/logger.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per phase

// ─── Git helper ───────────────────────────────────────────────────────────────

function git(args, cwd = PROJECT_ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

// ─── Find claude binary ───────────────────────────────────────────────────────

function findClaudeBin() {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code');
  }
}

/**
 * Build a clean env for Claude Code subprocess.
 * Strip ANTHROPIC_API_KEY so Claude Code uses its own ~/.claude/ Pro subscription
 * credentials instead of the bot's direct API key.
 */
function claudeEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

// ─── Phase 1: Planning (--output-format json, no file writes) ────────────────

const PLAN_PROMPT_TEMPLATE = (instruction, feedback) => {
  const feedbackSection = feedback
    ? `\n\nUser feedback on the previous response:\n${feedback}`
    : '';

  return (
    `You are helping with a WhatsApp bot codebase. Read the request below and decide if it is ` +
    `a question/investigation or a build task requiring code changes.\n\n` +
    `Request: "${instruction}"${feedbackSection}\n\n` +
    `━━━ If this is a QUESTION or investigation (no code changes needed) ━━━\n` +
    `Answer it directly and thoroughly. Read whatever files you need.\n` +
    `End your response with exactly: [ANSWER]\n\n` +
    `━━━ If this requires CODE CHANGES ━━━\n` +
    `Read relevant files, then output a plan with:\n` +
    `1. Files to create or modify (with a brief description of each change)\n` +
    `2. Key implementation decisions\n` +
    `3. Any potential issues or edge cases\n` +
    `End your response with exactly: [PLAN]\n\n` +
    `Do NOT write, create, or modify any files. Output text only.`
  );
};

/**
 * Run Claude Code in planning mode: reads files, outputs a plan, writes nothing.
 * Uses --output-format json so we get a clean result field.
 * onProgress() is called every 60 s while the process is running.
 */
function runPlanningPhase(instruction, worktreePath, feedback = null, onProgress = null) {
  const claudeBin = findClaudeBin();
  const prompt = PLAN_PROMPT_TEMPLATE(instruction, feedback);

  return new Promise((resolve, reject) => {
    logger.info(`/dev: spawning Claude Code (planning) in ${worktreePath}`);

    const proc = spawn(
      claudeBin,
      ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text'],
      { cwd: worktreePath, env: claudeEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let rawOutput = '';
    let stderrBuf = '';
    let timedOut = false;

    const progressTimer = onProgress
      ? setInterval(() => { onProgress().catch(err => logger.warn(`/dev: progress ping failed: ${err.message}`)); }, 60_000)
      : null;

    const cleanup = () => { if (progressTimer) clearInterval(progressTimer); };

    proc.stdout.on('data', chunk => { rawOutput += chunk.toString(); });
    proc.stderr.on('data', chunk => {
      const s = chunk.toString();
      stderrBuf += s;
      logger.debug(`/dev plan stderr: ${s.trimEnd().slice(0, 200)}`);
    });
    proc.on('error', err => {
      cleanup();
      const detail = stderrBuf ? `\nStderr: ${stderrBuf.slice(-500)}` : '';
      reject(new Error(err.message + detail));
    });
    proc.on('close', code => {
      cleanup();
      if (timedOut) return;
      logger.info(`/dev: Claude Code (planning) exited with code ${code}`);
      if (code !== 0 && code !== null) {
        const detail = stderrBuf ? `\nStderr: ${stderrBuf.slice(-500)}` : '';
        reject(new Error(`Claude Code (planning) exited with code ${code}${detail}`));
        return;
      }
      resolve(rawOutput.trim());
    });

    setTimeout(() => {
      timedOut = true;
      cleanup();
      proc.kill();
      reject(new Error('Planning phase timed out after 5 minutes'));
    }, TIMEOUT_MS);
  });
}

// ─── Phase 2: Implementation (--output-format stream-json, writes allowed) ───

/**
 * Run Claude Code in implementation mode: executes the plan, writes files.
 * Streams events so we can send periodic progress pings to the user.
 */
function runImplementationPhase(instruction, plan, worktreePath, onProgress) {
  const claudeBin = findClaudeBin();
  const prompt =
    `Implement the following task exactly as described in the approved plan below.\n\n` +
    `Task: "${instruction}"\n\n` +
    `Approved plan:\n${plan}`;

  return new Promise((resolve, reject) => {
    const proc = spawn(
      claudeBin,
      ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose'],
      { cwd: worktreePath, env: claudeEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let fullOutput = '';
    let lineBuffer = '';
    let stderrBuf = '';
    let filesRead = 0;
    let filesWritten = 0;
    let lastAction = '';
    let timedOut = false;

    const progressTimer = setInterval(() => {
      if (filesRead + filesWritten > 0) {
        onProgress({ filesRead, filesWritten, lastAction }).catch(err => logger.warn(`/dev: progress ping failed: ${err.message}`));
      }
    }, 60_000);

    proc.stdout.on('data', chunk => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        fullOutput += line + '\n';
        try {
          const event = JSON.parse(line);
          const toolName = event?.event?.name ?? event?.tool_name ?? '';
          if (['Read', 'Glob', 'Grep'].includes(toolName)) {
            filesRead++;
          } else if (['Write', 'Edit'].includes(toolName)) {
            filesWritten++;
            lastAction = event?.event?.input?.file_path ?? toolName;
          }
        } catch { /* non-JSON line */ }
      }
    });

    proc.stderr.on('data', chunk => {
      const s = chunk.toString();
      stderrBuf += s;
      logger.debug(`/dev impl stderr: ${s.slice(0, 200)}`);
    });
    proc.on('error', err => {
      clearInterval(progressTimer);
      const detail = stderrBuf ? `\nStderr: ${stderrBuf.slice(-500)}` : '';
      reject(new Error(err.message + detail));
    });
    proc.on('close', code => {
      clearInterval(progressTimer);
      if (timedOut) return;
      if (code !== 0 && code !== null) {
        const detail = stderrBuf ? `\nStderr: ${stderrBuf.slice(-500)}` : '';
        reject(new Error(`Claude Code (implementation) exited with code ${code}${detail}`));
      } else {
        resolve(fullOutput);
      }
    });

    setTimeout(() => {
      timedOut = true;
      proc.kill();
      clearInterval(progressTimer);
      reject(new Error('Implementation phase timed out after 5 minutes'));
    }, TIMEOUT_MS);
  });
}

// ─── Worktree helpers ─────────────────────────────────────────────────────────

function removeWorktree(worktreePath) {
  try { git(['worktree', 'remove', '--force', worktreePath]); } catch {}
}

function deleteBranch(branchName) {
  try { git(['branch', '-D', branchName]); } catch {}
}

function cleanupWorktree({ worktreePath, branchName } = {}) {
  if (worktreePath) removeWorktree(worktreePath);
  if (branchName) deleteBranch(branchName);
}

// ─── Implementation runner (called after plan confirmed) ──────────────────────

async function executeImplementation(ctx, { instruction, plan, worktreePath, branchName }) {
  await ctx.reply('⚙️ Implementing... (progress updates every 60 s if active)');

  try {
    await runImplementationPhase(instruction, plan, worktreePath, async ({ filesRead, filesWritten, lastAction }) => {
      const parts = [`Still working... (read ${filesRead} file${filesRead !== 1 ? 's' : ''}`];
      if (filesWritten > 0) {
        parts.push(`, wrote ${filesWritten}`);
        if (lastAction) parts.push(` incl. ${path.basename(lastAction)}`);
      }
      parts.push(')');
      await ctx.reply(parts.join(''));
    });
  } catch (err) {
    logger.error(`/dev: implementation failed: ${err.message}`);
    cleanupWorktree({ worktreePath, branchName });
    await ctx.reply(`❌ Implementation failed: ${err.message}`);
    ctx.completeTask();
    return;
  }

  // Check for actual file changes
  let porcelain = '';
  try { porcelain = git(['status', '--porcelain'], worktreePath); } catch {}

  if (!porcelain) {
    cleanupWorktree({ worktreePath, branchName });
    await ctx.reply('Claude Code ran but made no file changes.');
    ctx.completeTask();
    return;
  }

  // Commit in the worktree
  try {
    git(['add', '-A'], worktreePath);
    git(['commit', '-m', `dev: ${instruction.slice(0, 60)}`], worktreePath);
  } catch (err) {
    logger.error(`/dev: commit failed: ${err.message}`);
    cleanupWorktree({ worktreePath, branchName });
    await ctx.reply(`❌ Failed to commit changes: ${err.message}`);
    ctx.completeTask();
    return;
  }

  // Diff stat vs main HEAD
  let diffStat = '(could not compute diff)';
  try { diffStat = git(['diff', `HEAD..${branchName}`, '--stat']); } catch {}

  ctx.updateTask('awaiting_confirmation', { worktreePath, branchName, instruction });
  await ctx.reply(
    `✅ Done.\n\nChanges:\n${diffStat}\n\n` +
    `Reply \`confirm\` to apply + commit, or \`discard\` to cancel.`
  );
}

// ─── Task definition ──────────────────────────────────────────────────────────

const devTask = {
  command: '/dev',
  description: 'Ask Claude Code a question or delegate a code change. Usage: /dev <question or instruction>',

  async start(ctx, args) {
    const instruction = (args ?? []).join(' ').trim();

    if (!instruction) {
      await ctx.reply(
        'Usage: /dev <question or instruction>\n\n' +
        'Questions (answered immediately):\n' +
        '  /dev how does the market scheduler work?\n' +
        '  /dev why does /research fall back to FMP?\n\n' +
        'Build tasks (plan → confirm → implement):\n' +
        '  /dev add a /weather command using wttr.in'
      );
      ctx.completeTask();
      return;
    }

    const timestamp = Date.now();
    const branchName = `dev-${timestamp}`;
    const worktreePath = `/tmp/whatsapp-bot-${branchName}`;

    try {
      git(['worktree', 'add', '-b', branchName, worktreePath, 'HEAD']);
    } catch (err) {
      logger.error(`/dev: failed to create worktree: ${err.message}`);
      await ctx.reply(`❌ Failed to create git worktree: ${err.message}`);
      ctx.completeTask();
      return;
    }

    await ctx.reply('🔍 Analyzing...');

    let response;
    try {
      response = await runPlanningPhase(instruction, worktreePath, null, async () => {
        await ctx.reply('Still analyzing...');
      });
    } catch (err) {
      logger.error(`/dev: analysis failed: ${err.message}`);
      cleanupWorktree({ worktreePath, branchName });
      await ctx.reply(`❌ Analysis failed: ${err.message}`);
      ctx.completeTask();
      return;
    }

    // Detect intent from self-classification marker
    const isAnswer = response.includes('[ANSWER]');
    const cleanResponse = response.replace(/\[(ANSWER|PLAN)\]\s*$/i, '').trim();

    if (isAnswer) {
      // Q&A — answer immediately, no confirmation loop needed
      cleanupWorktree({ worktreePath, branchName });
      await ctx.reply(cleanResponse);
      ctx.completeTask();
      return;
    }

    // Build task — show plan and wait for confirmation
    ctx.updateTask('awaiting_plan_confirmation', { instruction, plan: cleanResponse, worktreePath, branchName });
    await ctx.reply(
      `📋 *Plan:*\n\n${cleanResponse}\n\n` +
      `Reply:\n` +
      `• \`confirm\` — proceed with this plan\n` +
      `• \`update: <feedback>\` — revise the plan\n` +
      `• \`discard\` — cancel`
    );
  },

  async onMessage(ctx, text) {
    const taskState = ctx.getState()?.taskState;
    const data = ctx.getTaskData() ?? {};
    const cmd = text.trim().toLowerCase();

    // ── Phase 1 confirmation ─────────────────────────────────────────────────
    if (taskState === 'awaiting_plan_confirmation') {
      const { instruction, plan, worktreePath, branchName } = data;

      if (cmd === 'confirm') {
        await executeImplementation(ctx, { instruction, plan, worktreePath, branchName });
        return;
      }

      if (cmd === 'discard') {
        cleanupWorktree({ worktreePath, branchName });
        await ctx.reply('Cancelled. No changes applied.');
        ctx.completeTask();
        return;
      }

      // update: <feedback>
      const feedbackMatch = text.match(/^update[:\s]+(.+)/si);
      if (feedbackMatch) {
        const feedback = feedbackMatch[1].trim();
        await ctx.reply('🔍 Revising...');
        let revisedPlan;
        try {
          revisedPlan = await runPlanningPhase(instruction, worktreePath, feedback, async () => {
            await ctx.reply('Still analyzing...');
          });
        } catch (err) {
          logger.error(`/dev: plan revision failed: ${err.message}`);
          await ctx.reply(`❌ Plan revision failed: ${err.message}\n\nPrevious plan still active. Reply \`confirm\`, \`update: <feedback>\`, or \`discard\`.`);
          return;
        }
        ctx.updateTask('awaiting_plan_confirmation', { ...data, plan: revisedPlan });
        await ctx.reply(
          `📋 *Revised plan:*\n\n${revisedPlan}\n\n` +
          `Reply \`confirm\`, \`update: <feedback>\`, or \`discard\`.`
        );
        return;
      }

      await ctx.reply(
        'Reply:\n' +
        '• `confirm` — proceed with this plan\n' +
        '• `update: <feedback>` — revise the plan\n' +
        '• `discard` — cancel'
      );
      return;
    }

    // ── Phase 2 confirmation (apply diff) ────────────────────────────────────
    if (taskState === 'awaiting_confirmation') {
      const { worktreePath, branchName } = data;

      if (cmd === 'confirm') {
        try {
          git(['merge', branchName, '--no-edit', '-m', `Apply /dev changes: ${branchName}`]);
        } catch (err) {
          logger.error(`/dev: merge failed: ${err.message}`);
          await ctx.reply(
            `❌ Merge failed: ${err.message}\n\n` +
            `Worktree preserved at ${worktreePath} for manual inspection.\n` +
            `Branch: ${branchName}`
          );
          ctx.completeTask();
          return;
        }
        cleanupWorktree({ worktreePath, branchName });
        await ctx.reply('✅ Changes applied and committed.\nBot restarting (nodemon detects file changes)...');
        ctx.completeTask();
        return;
      }

      if (cmd === 'discard') {
        cleanupWorktree({ worktreePath, branchName });
        await ctx.reply('Cancelled. No changes applied.');
        ctx.completeTask();
        return;
      }

      await ctx.reply('Reply `confirm` to apply the changes, or `discard` to cancel.');
      return;
    }

    await ctx.reply('No active /dev session. Use /dev <instruction> to start one.');
  },

  cleanup(ctx) {
    cleanupWorktree(ctx.getTaskData() ?? {});
  },
};

export default devTask;
