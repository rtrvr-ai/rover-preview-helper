import test from 'node:test';
import assert from 'node:assert/strict';

const REQUEST_SOURCE = 'my-rover-extension';
const RESPONSE_SOURCE = 'my-rover-extension-rover-bridge';

const flush = async (times = 4) => {
  for (let i = 0; i < times; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
};

// Load a fresh copy of the MAIN-world bridge against a stub window, the same way
// content-start.test.mjs exercises the content-script IIFE.
async function loadBridge(label) {
  const previousWindow = globalThis.window;
  const listeners = [];
  const posted = [];
  const handlers = new Map();
  const sent = [];
  const newTasks = [];

  const rover = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
      return () => handlers.get(event).delete(handler);
    },
    send(prompt, options) {
      sent.push({ prompt, options });
    },
    newTask(options) {
      newTasks.push(options);
    },
  };

  const win = {
    rover,
    addEventListener(type, handler) {
      if (type === 'message') listeners.push(handler);
    },
    postMessage(data) {
      posted.push(data);
    },
  };
  globalThis.window = win;

  await import(`./page-bridge.js?${label}`);

  return {
    posted,
    sent,
    newTasks,
    subscribed: event => handlers.has(event) && handlers.get(event).size > 0,
    emit(event, payload) {
      for (const handler of [...(handlers.get(event) || [])]) handler(payload);
    },
    async run(message) {
      for (const listener of listeners) {
        listener({ source: win, data: { source: REQUEST_SOURCE, type: 'ROVER_HEADLESS_RUN', ...message } });
      }
      await flush();
    },
    results: () => posted.filter(item => item.type === 'ROVER_HEADLESS_RESULT'),
    events: () => posted.filter(item => item.type === 'ROVER_HEADLESS_EVENT'),
    restore() {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

test('bridge reports the run summary when Rover completes successfully', async () => {
  const bridge = await loadBridge('completed');
  try {
    await bridge.run({ requestId: 'req-1', prompt: 'Extract the headline.', timeoutMs: 5000 });

    assert.deepEqual(bridge.sent, [{ prompt: 'Extract the headline.', options: undefined }]);
    assert.ok(bridge.subscribed('run_completed'));
    assert.ok(bridge.subscribed('run_state_transition'), 'must watch parked runs too');

    bridge.emit('response_shown', { responseKind: 'checkpoint', text: 'Looking at the page' });
    bridge.emit('run_completed', {
      runId: 'run_1',
      outcome: 'success',
      terminalState: 'completed',
      summary: '{"headline":"Engineer"}',
      ok: true,
    });

    const [result] = bridge.results();
    assert.equal(result.requestId, 'req-1');
    assert.equal(result.payload.status, 'completed');
    assert.equal(result.payload.summary, '{"headline":"Engineer"}');
    assert.equal(result.payload.runId, 'run_1');
  } finally {
    bridge.restore();
  }
});

test('bridge fails the run when run_completed reports a failure outcome', async () => {
  const bridge = await loadBridge('failed');
  try {
    await bridge.run({ requestId: 'req-2', prompt: 'Do the thing.', timeoutMs: 5000 });
    bridge.emit('run_completed', {
      runId: 'run_2',
      outcome: 'failure',
      terminalState: 'failed',
      error: 'Element never appeared.',
      ok: false,
    });

    const [result] = bridge.results();
    assert.equal(result.payload.status, 'failed');
    assert.equal(result.payload.error, 'Element never appeared.');
  } finally {
    bridge.restore();
  }
});

// A parked run emits run_state_transition and never reaches run_completed, so a
// bridge that only waits on run_completed would hang until its timeout.
test('bridge settles a parked run from run_state_transition alone', async () => {
  const bridge = await loadBridge('parked');
  try {
    await bridge.run({ requestId: 'req-3', prompt: 'Book something.', timeoutMs: 5000 });
    bridge.emit('run_state_transition', {
      runId: 'run_3',
      terminalState: 'waiting_input',
      needsUserInput: true,
      continuationReason: 'awaiting_user',
      questions: [{ key: 'date', query: 'Which date?' }],
    });

    const [result] = bridge.results();
    assert.equal(result.payload.status, 'needs_input');
    assert.deepEqual(result.payload.questions, [{ key: 'date', query: 'Which date?' }]);
  } finally {
    bridge.restore();
  }
});

test('bridge ignores background error scopes that do not belong to the run', async () => {
  const bridge = await loadBridge('error-scopes');
  try {
    await bridge.run({ requestId: 'req-4', prompt: 'Summarize.', timeoutMs: 5000 });

    bridge.emit('error', { scope: 'roverbook_attach', message: 'Failed to attach Rover Analytics.' });
    bridge.emit('error', { scope: 'run_cancel_repair', message: 'Failed to cancel stale run.' });
    assert.equal(bridge.results().length, 0, 'background subsystem errors must not end the run');

    bridge.emit('response_shown', { responseKind: 'final', text: 'All done.' });
    bridge.emit('run_completed', { runId: 'run_4', outcome: 'success', terminalState: 'completed' });

    const [result] = bridge.results();
    assert.equal(result.payload.status, 'completed');
    assert.equal(result.payload.text, 'All done.', 'falls back to the final response text');
  } finally {
    bridge.restore();
  }
});

// An execution error does not always end the run: Rover can recover and still
// report a terminal state, which must win over the error.
test('bridge lets a recovered run outlive an unscoped execution error', async () => {
  const bridge = await loadBridge('error-grace');
  try {
    await bridge.run({ requestId: 'req-10', prompt: 'Retry the click.', timeoutMs: 5000 });

    bridge.emit('error', { message: 'Execution error' });
    assert.equal(bridge.results().length, 0, 'must wait for a terminal signal first');

    bridge.emit('run_completed', {
      runId: 'run_10',
      outcome: 'success',
      terminalState: 'completed',
      summary: 'Recovered.',
    });

    const [result] = bridge.results();
    assert.equal(result.payload.status, 'completed');
    assert.equal(result.payload.summary, 'Recovered.');
  } finally {
    bridge.restore();
  }
});

test('bridge fails immediately when the prompt never dispatched', async () => {
  const bridge = await loadBridge('run-input');
  try {
    await bridge.run({ requestId: 'req-5', prompt: 'Go.', timeoutMs: 5000 });
    bridge.emit('error', { scope: 'run_input', message: 'Run start failed' });

    const [result] = bridge.results();
    assert.equal(result.payload.status, 'failed');
    assert.equal(result.payload.error, 'Run start failed');
  } finally {
    bridge.restore();
  }
});

test('bridge rejects a concurrent request instead of letting it be swallowed', async () => {
  const bridge = await loadBridge('busy');
  try {
    await bridge.run({ requestId: 'req-6', prompt: 'First.', timeoutMs: 5000 });
    await bridge.run({ requestId: 'req-7', prompt: 'Second.', timeoutMs: 5000 });

    const [result] = bridge.results();
    assert.equal(result.requestId, 'req-7');
    assert.equal(result.payload.status, 'busy');
    assert.equal(bridge.sent.length, 1, 'the runtime silently drops a concurrent dispatch');

    bridge.emit('run_completed', { runId: 'run_6', outcome: 'success', terminalState: 'completed' });
    assert.equal(bridge.results().length, 2);
  } finally {
    bridge.restore();
  }
});

test('bridge starts a fresh task boundary and forwards send options when asked', async () => {
  const bridge = await loadBridge('new-task');
  try {
    await bridge.run({
      requestId: 'req-8',
      prompt: 'Second prompt on this page.',
      timeoutMs: 5000,
      startNewTask: true,
      sendOptions: { engagementKind: 'support' },
    });

    assert.equal(bridge.newTasks.length, 1);
    assert.deepEqual(bridge.sent, [{
      prompt: 'Second prompt on this page.',
      options: { engagementKind: 'support' },
    }]);

    bridge.emit('run_completed', { runId: 'run_8', outcome: 'success', terminalState: 'completed' });
  } finally {
    bridge.restore();
  }
});

test('bridge rejects an empty prompt without touching Rover', async () => {
  const bridge = await loadBridge('empty');
  try {
    await bridge.run({ requestId: 'req-9', prompt: '   ' });

    const [result] = bridge.results();
    assert.equal(result.payload.status, 'failed');
    assert.equal(result.payload.error, 'Missing prompt.');
    assert.equal(bridge.sent.length, 0);
  } finally {
    bridge.restore();
  }
});
