/**
 * helpers.js — a whole desk, in a temp folder, in one call.
 *
 * Tests exercise the real wiring (real signing key, real approval ledger, real
 * agents) against the labelled sim feed, so they run with no network and no
 * keys, and never touch your actual journal or blotter.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DEMO_FEED = '1';
process.env.ALLOW_SIM = '1';
process.env.EXECUTION_MODE = 'paper';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'friday-test-'));

export async function makeDesk() {
  const { config } = await import('../server/config.js');
  const { DeskBus } = await import('../server/bus.js');
  const { Journal } = await import('../server/store/journal.js');
  const { PaperBlotter } = await import('../server/store/blotter.js');
  const { ApprovalLedger } = await import('../server/store/approvals.js');
  const { TaskQueue } = await import('../server/store/tasks.js');
  const { DeskFeed } = await import('../server/data/provider.js');
  const { buildAgents } = await import('../server/agents/registry.js');
  const { Master } = await import('../server/master.js');
  const { mcpBridge } = await import('../server/charting/mcp-bridge.js');
  const { describeSession } = await import('../server/data/session.js');
  const { nextEventRisk, buildCalendar } = await import('../server/data/events.js');
  const { loadSentinelKeys, publicKeyPem } = await import('../server/keys.js');

  const keys = loadSentinelKeys();
  const bus = new DeskBus();
  const journal = new Journal(path.join(tmp, 'journal'));
  const approvals = new ApprovalLedger({ publicKeyPem: publicKeyPem(), bus, journal });
  const blotter = new PaperBlotter({ bus, journal });
  blotter.file = path.join(tmp, 'blotter', 'positions.json');
  const queue = new TaskQueue({ bus });
  const feed = new DeskFeed({ bus, journal });
  const registry = buildAgents({ bus, journal, approvals, blotter, queue, mcp: mcpBridge });
  const master = new Master({
    bus, journal, queue, feed, approvals, blotter,
    call: registry.call, load: registry.load, mcp: mcpBridge,
    servicesFor: (id) => (id === 'sentinel' ? { keys } : { keys: null }),
  });
  master.updateContext({ session: describeSession(), nextEvent: nextEventRisk(), calendar: buildCalendar() });

  return { config, keys, bus, journal, approvals, blotter, feed, registry, master, tmp, alerts: [] , events: [] };
}

export const dir = (name) => path.join(tmp, name);
export const tmpRoot = tmp;
