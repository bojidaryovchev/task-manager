import { join } from 'node:path';
import { BrowserWindow, clipboard, Menu, shell } from 'electron';
import type { ServiceSnapshot, SystemSnapshot } from '@task-manager/telemetry-types';
import type {
  ServiceMenuCommand,
  ServiceMenuRequest,
  ServiceOutcome,
} from '@shared/services.js';
import { ask, showReport, type ActionGate } from './action-gate.js';
import type { Logger } from './logger.js';
import type { NativeTelemetryModule } from './native.js';
import { codeLines } from './process-menu.js';
import {
  buildServiceMenu,
  confirmStopping,
  reportService,
  type ServiceActionKind,
} from './service-menu.js';

/**
 * Carries out what the service menu offers: start, stop and restart, going to
 * the process a service runs in, and opening the Services console.
 *
 * As with processes, the page only asks for the menu; the question, the call
 * into Windows and the report all happen here.
 */

export interface ServiceActionsHost {
  native(): NativeTelemetryModule | null;
  latestSnapshot(): SystemSnapshot | null;
  /** This application is running as administrator. */
  elevated(): boolean;
  /** Read the service list again at once, after starting or stopping one. */
  refreshServices(): void;
  logger: Logger | null;
  restartElevated?: () => void;
  /** Shared with the process actions, so only one action runs at a time. */
  gate: ActionGate;
}

/** As for the process menu: allow for a click landing after the close. */
const MENU_SETTLE_MS = 250;

export class ServiceActions {
  #host: ServiceActionsHost;

  constructor(host: ServiceActionsHost) {
    this.#host = host;
  }

  /**
   * Show the menu for a service. Resolves, once the menu has closed, with
   * anything the page itself has to do.
   */
  showMenu(window: BrowserWindow | null, request: ServiceMenuRequest): Promise<ServiceMenuCommand> {
    const native = this.#host.native();
    const service = this.#host
      .latestSnapshot()
      ?.services?.services.find((candidate) => candidate.name === request.name);
    if (!native || !service || this.#host.gate.busy) return Promise.resolve(null);

    const state = native.inspectService(service.name);
    let resolve: (command: ServiceMenuCommand) => void = () => {};
    const chosen = new Promise<ServiceMenuCommand>((settle) => {
      resolve = settle;
    });
    const template = buildServiceMenu(
      { service, state, elevated: this.#host.elevated() },
      {
        start: () => void this.#host.gate.run('start service', () => this.#act(window, 'start', service)),
        stop: () => void this.#host.gate.run('stop service', () => this.#act(window, 'stop', service)),
        restart: () =>
          void this.#host.gate.run('restart service', () => this.#act(window, 'restart', service)),
        goToProcess: () => {
          if (state.pid !== undefined) resolve({ kind: 'goToProcess', pid: state.pid });
        },
        openServices: () => void this.openServices(window),
        searchOnline: () => {
          const query = `${service.displayName} ${service.name} service`;
          void shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
        },
        copy: (text) => clipboard.writeText(text),
      },
    );
    Menu.buildFromTemplate(template).popup({
      window: window ?? undefined,
      callback: () => setTimeout(() => resolve(null), MENU_SETTLE_MS),
    });
    return chosen;
  }

  async #act(
    window: BrowserWindow | null,
    kind: ServiceActionKind,
    service: ServiceSnapshot,
  ): Promise<void> {
    const native = this.#host.native();
    if (!native) return;

    // Checked again now rather than trusted from when the menu opened: a
    // dependent may have started in between. What Windows would refuse is
    // said at once, rather than after a question whose answer cannot matter.
    const current = native.inspectService(service.name);
    const allowed =
      kind === 'start'
        ? current.canStart
        : kind === 'stop'
          ? current.canStop
          : current.canStop && current.canStart;
    if (current.state === 'notFound' || !allowed) {
      await this.#report(window, kind, service, {
        outcome: current.state === 'notFound' ? 'notFound' : 'accessDenied',
        stoppedDependents: [],
        notRestarted: [],
      });
      return;
    }

    let withDependents = false;
    if (kind !== 'start') {
      const dependents = current.runningDependents ?? [];
      const question = confirmStopping(kind, service, dependents);
      if (question) {
        const answer = await ask(window, {
          type: 'warning',
          title: 'Task Manager',
          message: question.message,
          detail: question.detail,
          buttons: [question.confirm, 'Cancel'],
          // Cancel is the default, as for every question that stops things.
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        this.#host.logger?.info(
          'service',
          `${answer.response === 0 ? 'confirmed' : 'cancelled'}: ${question.message} ${dependents
            .map((dependent) => dependent.name)
            .join(', ')}`,
        );
        if (answer.response !== 0) return;
        withDependents = true;
      }
    }

    const outcome: ServiceOutcome =
      kind === 'start'
        ? await native.startService(service.name)
        : kind === 'stop'
          ? await native.stopService(service.name, withDependents)
          : await native.restartService(service.name, withDependents);
    this.#host.refreshServices();

    if (outcome.outcome === 'done') {
      const past = { start: 'started', stop: 'stopped', restart: 'restarted' }[kind];
      const along =
        outcome.stoppedDependents.length > 0
          ? `, with ${outcome.stoppedDependents.join(', ')}`
          : '';
      this.#host.logger?.info('service', `${past} ${service.displayName} (${service.name})${along}`);
    }
    await this.#report(window, kind, service, outcome);
  }

  /** Log and show what went wrong, when anything did. */
  async #report(
    window: BrowserWindow | null,
    kind: ServiceActionKind,
    service: ServiceSnapshot,
    outcome: ServiceOutcome,
  ): Promise<void> {
    const described = `${service.displayName} (${service.name})`;
    const report = reportService(kind, service, outcome, this.#host.elevated());
    if (!report) return;
    if (report.code) {
      this.#host.logger?.warn(
        report.code,
        `could not ${kind} ${described}: ${outcome.outcome}${
          outcome.win32Error === undefined ? '' : `, Windows error ${outcome.win32Error}`
        }`,
      );
    }
    await showReport(window, report, this.#host.restartElevated);
  }

  /** Open the Windows Services console, reporting it if it would not open. */
  openServices(window: BrowserWindow | null): Promise<void> {
    return this.#host.gate.run('open Services', () => this.#openServices(window));
  }

  async #openServices(window: BrowserWindow | null): Promise<void> {
    const services = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'services.msc');
    // Empty on success; otherwise the reason.
    const failure = await shell.openPath(services);
    if (!failure) return;
    this.#host.logger?.warn('TM-0022', `could not open ${services}: ${failure}`);
    await showReport(window, {
      type: 'warning',
      message: 'Services could not be opened.',
      detail: `${failure}\n\n${codeLines('TM-0022')}`,
      code: 'TM-0022',
      offerElevation: false,
    });
  }
}
