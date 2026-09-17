/**
 * tasks.js — the Task Queue panel. Each unit of delegated work is a task with
 * an owner, a state machine, and a measured latency. The master creates tasks;
 * agents never create their own work.
 */
import { nowIso, uid } from '../util.js';

const MAX = 120;

export class TaskQueue {
  constructor({ bus }) {
    this.bus = bus;
    this.items = [];
  }

  open({ command, agents = [], symbol = null }) {
    const task = {
      id: uid('task'),
      command,
      symbol,
      agents,
      status: 'routed',
      startedAt: Date.now(),
      at: nowIso(),
      done: [],
      failed: [],
      ms: null,
    };
    this.items.unshift(task);
    if (this.items.length > MAX) this.items.pop();
    this.bus.emitEvent('task', { task });
    return task;
  }

  step(id, agent, status, detail = '') {
    const task = this.items.find((t) => t.id === id);
    if (!task) return null;
    if (status === 'done') task.done.push(agent);
    if (status === 'failed') task.failed.push(agent);
    task.status = status === 'failed' ? 'partial' : status;
    task.detail = detail;
    this.bus.emitEvent('task', { task });
    return task;
  }

  close(id, { status = 'done', summary = '' } = {}) {
    const task = this.items.find((t) => t.id === id);
    if (!task) return null;
    task.status = status;
    task.summary = summary;
    task.ms = Date.now() - task.startedAt;
    task.finishedAt = nowIso();
    this.bus.emitEvent('task', { task });
    return task;
  }

  list(limit = 12) {
    return this.items.slice(0, limit);
  }
}
