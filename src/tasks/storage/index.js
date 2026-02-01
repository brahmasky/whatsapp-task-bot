import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

function formatSize(kb) {
  if (kb >= 1048576) return (kb / 1048576).toFixed(1) + ' TB';
  if (kb >= 1024) return (kb / 1024).toFixed(1) + ' GB';
  return kb + ' MB';
}

export default {
  command: '/storage',
  description: 'Check local disk storage usage',

  async start(ctx) {
    try {
      const { stdout } = await execAsync('df -k /');
      const parts = stdout.trim().split('\n')[1].split(/\s+/);

      const total = parseInt(parts[1]);
      const used = parseInt(parts[2]);
      const available = parseInt(parts[3]);
      const percent = parts[4];

      await ctx.reply(
        '*Storage Report*\n\n' +
        `Total:     ${formatSize(total)}\n` +
        `Used:      ${formatSize(used)}\n` +
        `Available: ${formatSize(available)}\n` +
        `Usage:     ${percent}`
      );
    } catch (error) {
      await ctx.reply(`Error checking storage: ${error.message}`);
    }

    ctx.completeTask();
  },

  async onMessage(ctx) {
    await ctx.reply('Use /storage to run a new check.');
    ctx.completeTask();
  },
};
