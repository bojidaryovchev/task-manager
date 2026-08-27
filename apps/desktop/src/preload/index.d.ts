import type { TaskManagerApi } from '../shared/ipc';

declare global {
  interface Window {
    taskManager: TaskManagerApi;
  }
}

export {};
