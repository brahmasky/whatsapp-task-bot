import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);

function formatSize(kb) {
  // Input is in KB (from df -k)
  // 1 GB = 1024 MB = 1024*1024 KB = 1,048,576 KB
  // 1 TB = 1024 GB = 1024*1024*1024 KB = 1,073,741,824 KB
  if (kb >= 1073741824) return (kb / 1073741824).toFixed(1) + ' TB';
  if (kb >= 1048576) return (kb / 1048576).toFixed(1) + ' GB';
  if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB';
  return kb + ' KB';
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

async function getStorageInfo() {
  const { stdout } = await execAsync('df -k /');
  const parts = stdout.trim().split('\n')[1].split(/\s+/);
  return {
    total: parseInt(parts[1]),
    used: parseInt(parts[2]),
    available: parseInt(parts[3]),
    percent: parts[4],
  };
}

async function getCpuUsage() {
  // Get CPU usage via top (macOS)
  const { stdout } = await execAsync("top -l 1 -n 0 | grep 'CPU usage'");
  const match = stdout.match(/(\d+\.\d+)% user.*?(\d+\.\d+)% sys.*?(\d+\.\d+)% idle/);
  if (match) {
    return {
      user: parseFloat(match[1]),
      system: parseFloat(match[2]),
      idle: parseFloat(match[3]),
    };
  }
  return null;
}

async function getTopProcesses() {
  // Get top 5 processes by CPU
  const { stdout } = await execAsync("ps -Ao comm,pcpu,pmem -r | head -6 | tail -5");
  return stdout.trim().split('\n').map(line => {
    const parts = line.trim().split(/\s+/);
    const mem = parts.pop();
    const cpu = parts.pop();
    const name = parts.join(' ').slice(0, 15);
    return { name, cpu, mem };
  });
}

async function getLoadAverage() {
  const { stdout } = await execAsync('sysctl -n vm.loadavg');
  const match = stdout.match(/(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)/);
  if (match) {
    return { '1m': match[1], '5m': match[2], '15m': match[3] };
  }
  return null;
}

async function getCurrentSessions() {
  // Get current logged in sessions
  const { stdout } = await execAsync('who');
  return stdout.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/);
    const user = parts[0];
    const tty = parts[1];
    const date = parts.slice(2, 5).join(' ');
    const host = parts[5]?.replace(/[()]/g, '') || 'local';
    return { user, tty, date, host };
  });
}

async function getRecentLogins() {
  // Get recent logins (last 10, filter to remote only)
  const { stdout } = await execAsync('last -10');
  const lines = stdout.trim().split('\n').filter(Boolean);
  const logins = [];

  for (const line of lines) {
    if (line.startsWith('wtmp') || line.trim() === '') continue;
    const parts = line.trim().split(/\s+/);
    const user = parts[0];
    const tty = parts[1];
    const host = parts[2];

    // Check if host looks like an IP or hostname (not empty/local)
    if (host && /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const dateStr = parts.slice(3, 7).join(' ');
      logins.push({ user, tty, host, date: dateStr });
    }
  }

  return logins.slice(0, 5); // Return last 5 remote logins
}

async function getCpuTemperature() {
  try {
    const { stdout } = await execAsync('osx-cpu-temp 2>/dev/null');
    const match = stdout.match(/([\d.]+)°C/);
    if (match) {
      return parseFloat(match[1]);
    }
  } catch {
    // Tool not installed or failed
  }
  return null;
}

async function getLastActiveTime() {
  // Get the last time display was turned on (wake/unlock)
  try {
    const { stdout } = await execAsync('pmset -g log | grep -E "Display is turned on" | tail -1');
    if (stdout.trim()) {
      // Format: 2026-02-15 20:39:42 +1100 Notification    Display is turned on
      const match = stdout.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (match) {
        return match[1];
      }
    }
  } catch {
    // Ignore errors
  }
  return null;
}

export default {
  command: '/system',
  description: 'Check Mac Mini system status (CPU, memory, storage)',

  async start(ctx) {
    try {
      // Gather all stats in parallel
      const [storage, cpuUsage, topProcs, loadAvg, sessions, recentLogins, lastActive, cpuTemp] = await Promise.all([
        getStorageInfo(),
        getCpuUsage(),
        getTopProcesses(),
        getLoadAverage(),
        getCurrentSessions(),
        getRecentLogins(),
        getLastActiveTime(),
        getCpuTemperature(),
      ]);

      // Memory from Node's os module
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memPercent = ((usedMem / totalMem) * 100).toFixed(1);

      // System info
      const uptime = os.uptime();
      const cpuCount = os.cpus().length;
      const hostname = os.hostname();

      // Build report
      let report = `*${hostname} Status*\n`;
      report += `Uptime: ${formatUptime(uptime)}\n`;
      if (lastActive) {
        report += `Last active: ${lastActive}\n`;
      }
      report += '\n';

      // CPU
      report += `*CPU* (${cpuCount} cores)\n`;
      if (cpuUsage) {
        const used = (cpuUsage.user + cpuUsage.system).toFixed(1);
        report += `Usage: ${used}% (${cpuUsage.user}% user, ${cpuUsage.system}% sys)\n`;
      }
      if (loadAvg) {
        report += `Load:  ${loadAvg['1m']} / ${loadAvg['5m']} / ${loadAvg['15m']}\n`;
      }
      if (cpuTemp !== null) {
        report += `Temp:  ${cpuTemp}°C\n`;
      }
      report += '\n';

      // Memory
      report += `*Memory*\n`;
      report += `Used:  ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${memPercent}%)\n`;
      report += `Free:  ${formatBytes(freeMem)}\n\n`;

      // Storage
      report += `*Storage*\n`;
      report += `Used:  ${formatSize(storage.used)} / ${formatSize(storage.total)} (${storage.percent})\n`;
      report += `Free:  ${formatSize(storage.available)}\n\n`;

      // Top processes
      if (topProcs.length > 0) {
        report += `*Top Processes*\n`;
        for (const proc of topProcs) {
          report += `${proc.name}: ${proc.cpu}% CPU, ${proc.mem}% mem\n`;
        }
        report += '\n';
      }

      // Active sessions
      const remoteSessions = sessions.filter(s => s.host !== 'local');
      report += `*Sessions* (${sessions.length} total, ${remoteSessions.length} remote)\n`;
      if (remoteSessions.length > 0) {
        for (const s of remoteSessions) {
          report += `${s.user}@${s.host} (${s.tty})\n`;
        }
      } else {
        report += 'No remote sessions\n';
      }
      report += '\n';

      // Recent remote logins
      if (recentLogins.length > 0) {
        report += `*Recent Remote Logins*\n`;
        for (const login of recentLogins) {
          report += `${login.user} from ${login.host} - ${login.date}\n`;
        }
      }

      await ctx.reply(report);
    } catch (error) {
      await ctx.reply(`Error checking system: ${error.message}`);
    }

    ctx.completeTask();
  },

  async onMessage(ctx) {
    await ctx.reply('Use /system to run a new check.');
    ctx.completeTask();
  },
};
