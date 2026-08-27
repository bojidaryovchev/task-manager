/**
 * Development driver for the Task Manager window over the Chrome DevTools
 * Protocol.
 *
 * Used to exercise the running application without a human at the keyboard:
 * switch pages, capture screenshots, and read anything the renderer logged or
 * threw. Requires the app to have been started with
 * `--remote-debugging-port=<port>`.
 *
 * Usage:
 *   node tools/devtools.mjs shot <output.png> [pageId]
 *   node tools/devtools.mjs eval "<expression>"
 *   node tools/devtools.mjs errors
 *
 * This is a development tool. It is not part of the shipped application and the
 * app does not open a debugging port unless explicitly told to.
 */

const PORT = Number(process.env.TASK_MANAGER_DEBUG_PORT ?? 9222);

async function findRendererTarget() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await response.json();
  const target = targets.find(
    (t) => t.type === 'page' && (t.title.includes('Task Manager') || t.url.includes('index.html')),
  );
  if (!target) {
    throw new Error(
      `No Task Manager page target on port ${PORT}. Targets: ${targets
        .map((t) => `${t.type}:${t.title}`)
        .join(', ')}`,
    );
  }
  return target;
}

class Session {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #events = [];

  static async open(webSocketDebuggerUrl) {
    const session = new Session();
    session.#socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      session.#socket.addEventListener('open', resolve, { once: true });
      session.#socket.addEventListener('error', reject, { once: true });
    });
    session.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = session.#pending.get(message.id);
        session.#pending.delete(message.id);
        if (!pending) return;
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      } else {
        session.#events.push(message);
      }
    });
    return session;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 20_000);
    });
  }

  get events() {
    return this.#events;
  }

  close() {
    this.#socket.close();
  }
}

const [command, ...args] = process.argv.slice(2);

const target = await findRendererTarget();
const session = await Session.open(target.webSocketDebuggerUrl);

try {
  switch (command) {
    case 'shot': {
      const [output, pageId] = args;
      if (pageId) {
        await session.send('Runtime.evaluate', {
          expression: navigateExpression(pageId),
          awaitPromise: true,
        });
        // Give React a couple of frames plus one telemetry interval to settle.
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      const { data } = await session.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: false,
      });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(output, Buffer.from(data, 'base64'));
      console.log(`saved ${output}`);
      break;
    }
    case 'eval': {
      const result = await session.send('Runtime.evaluate', {
        expression: args[0],
        awaitPromise: true,
        returnByValue: true,
      });
      console.log(JSON.stringify(result.result?.value ?? result, null, 2));
      break;
    }
    case 'errors': {
      await session.send('Log.enable');
      await session.send('Runtime.enable');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const interesting = session.events.filter(
        (event) =>
          event.method === 'Log.entryAdded' || event.method === 'Runtime.exceptionThrown',
      );
      console.log(interesting.length === 0 ? 'no errors' : JSON.stringify(interesting, null, 2));
      break;
    }
    default:
      console.error('Unknown command. Use: shot | eval | errors');
      process.exitCode = 1;
  }
} finally {
  session.close();
}

/**
 * Clicks the sidebar entry for a page. The sidebar buttons are the application's
 * only navigation, so driving them exercises the same path a user takes.
 */
function navigateExpression(pageId) {
  const labels = {
    overview: 'Overview',
    processes: 'Processes',
    cpu: 'CPU',
    memory: 'Memory',
    debug: 'Debug telemetry',
  };
  const label = labels[pageId];
  if (!label) throw new Error(`Unknown page ${pageId}`);
  return `(() => {
    const button = [...document.querySelectorAll('nav button')]
      .find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!button) throw new Error('nav button not found: ' + ${JSON.stringify(label)});
    button.click();
    return true;
  })()`;
}
