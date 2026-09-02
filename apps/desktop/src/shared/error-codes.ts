/**
 * Every failure state this application can be in, with a stable identity.
 *
 * # Why codes
 *
 * The rest of this application refuses to show a number without saying what it
 * measures. A failure deserves the same treatment: "something went wrong" tells
 * whoever is looking at it nothing, and a message alone changes with every
 * rewording, so it cannot be searched for or reported reliably.
 *
 * A code is stable, greppable, and short enough to read down a phone line or
 * out of a screenshot. Someone can say "it says TM-2001" and be understood
 * exactly, without sending a log file.
 *
 * # The contract
 *
 * - **Codes are permanent.** Once published, a code keeps its meaning forever.
 *   A condition that stops existing leaves its code retired, never reused for
 *   something else — a code that changed meaning between versions would make
 *   every older report a lie.
 * - **Every warning and error carries one.** Informational lifecycle lines do
 *   not, because they describe the application working.
 * - **Each one says what to do.** A code that only names a problem leaves the
 *   reader exactly where they started.
 *
 * # Blocks
 *
 * | Range | Subsystem |
 * |---|---|
 * | 1xxx | Startup |
 * | 2xxx | Native collector |
 * | 3xxx | History database |
 * | 4xxx | Settings |
 * | 5xxx | Desktop widget |
 * | 6xxx | Export |
 * | 7xxx | Crash handling and recovery |
 * | 8xxx | Renderer |
 * | 9xxx | Logging itself |
 */

export type ErrorSubsystem =
  | 'startup'
  | 'collector'
  | 'history'
  | 'settings'
  | 'widget'
  | 'export'
  | 'crash'
  | 'renderer'
  | 'logging';

export interface ErrorDefinition {
  code: string;
  subsystem: ErrorSubsystem;
  /** One line, as it appears in a heading. */
  title: string;
  /** What actually happened, and what it costs. */
  meaning: string;
  /** What the person reading this can do about it. */
  action: string;
}

/**
 * Declared as a literal so the code strings are usable as types, and so the
 * registry cannot drift from the codes actually referenced in the source.
 */
export const ERROR_CODES = {
  // --- 1xxx startup ---------------------------------------------------------
  'TM-1001': {
    subsystem: 'startup',
    title: 'Application identity could not be set',
    meaning:
      'Windows was not told the application user model id. Taskbar grouping and notifications may behave oddly. Nothing about measurement is affected.',
    action: 'Harmless. Report it only if taskbar behaviour is actually wrong.',
  },
  'TM-1002': {
    subsystem: 'startup',
    title: 'The main window could not be created',
    meaning:
      'The application is running but has no window. This is usually a graphics driver or GPU process failure rather than anything about the application itself.',
    action:
      'Update the graphics driver. If it persists, launch with --disable-gpu to confirm the GPU is the cause.',
  },
  'TM-1003': {
    subsystem: 'startup',
    title: 'Settings could not be loaded',
    meaning:
      'The settings file was missing, unreadable or not valid JSON, so defaults are in use. Widget placement and preferences from previous runs are gone.',
    action:
      'Usually self-correcting: the next settings change writes a clean file. Delete settings.json to be certain.',
  },
  'TM-1004': {
    subsystem: 'startup',
    title: 'The telemetry service could not be created',
    meaning:
      'Nothing is being measured. The interface will show no values rather than showing zeroes.',
    action: 'See the collector codes (TM-2xxx) in the log for the underlying cause.',
  },
  'TM-1005': {
    subsystem: 'startup',
    title: 'The desktop widget could not be set up',
    meaning: 'The widget is unavailable this session. The main window is unaffected.',
    action: 'Restart the application. Report it if it recurs.',
  },
  'TM-1006': {
    subsystem: 'startup',
    title: 'Restart registration failed',
    meaning:
      'Windows will not relaunch the application if it crashes outright. Everything else works; only automatic recovery from a hard crash is lost.',
    action: 'No action needed unless automatic restart matters to you.',
  },
  'TM-1007': {
    subsystem: 'startup',
    title: 'Inter-process channels could not be registered',
    meaning:
      'The window cannot talk to the part of the application that measures anything, so it will show nothing.',
    action: 'Restart the application. If it repeats, the installation is damaged; re-download it.',
  },
  'TM-1008': {
    subsystem: 'startup',
    title: 'History recording could not be started',
    meaning:
      'Live values still work. Nothing is being written to the history database, so the History page will stay empty.',
    action: 'See TM-3001 in the log. Often a permissions problem on the application data folder.',
  },
  'TM-1009': {
    subsystem: 'startup',
    title: 'Sampling could not be started',
    meaning: 'The collector exists but is not running, so no values will appear.',
    action: 'See the collector codes (TM-2xxx) in the log.',
  },
  'TM-1010': {
    subsystem: 'startup',
    title: 'The tray icon could not be created',
    meaning:
      'There is no tray entry. Everything else works, but the guaranteed way out of widget click-through mode is missing.',
    action: 'Turn click-through off from the Widget page instead.',
  },
  'TM-1011': {
    subsystem: 'startup',
    title: 'The widget could not be restored',
    meaning: 'The widget was enabled but did not reappear. Nothing else is affected.',
    action: 'Toggle the widget off and on from the Widget page.',
  },

  'TM-1012': {
    subsystem: 'startup',
    title: 'The application started with some parts missing',
    meaning:
      'Startup is survivable step by step, so the application is running and useful while one or more parts of it are not. The codes logged just before this one say which.',
    action: 'Look up the codes listed alongside this one; each says what it costs and what to do.',
  },

  // --- 2xxx native collector ------------------------------------------------
  'TM-2001': {
    subsystem: 'collector',
    title: 'The native telemetry module could not be loaded',
    meaning:
      'This module is what reads Windows directly; without it there is nothing real to display, so the application shows no values rather than inventing any.',
    action:
      'In a packaged build this means the download is damaged or a security product removed the file — re-download and check quarantine. From source, run: pnpm native:build',
  },
  'TM-2002': {
    subsystem: 'collector',
    title: 'The native module loaded but would not initialise',
    meaning:
      'The module is present but refused to start collecting. No values will appear.',
    action: 'Report the message beside this code; it comes from Windows and names the failing call.',
  },
  'TM-2003': {
    subsystem: 'collector',
    title: 'The collector thread stopped',
    meaning:
      'Sampling has stopped, and every value on screen is from before it stopped. The application is deliberately saying so rather than continuing to show stale numbers as if they were current.',
    action: 'Restart the application, and report the message beside this code.',
  },

  // --- 3xxx history ---------------------------------------------------------
  'TM-3001': {
    subsystem: 'history',
    title: 'The history database could not be opened',
    meaning:
      'Live measurement is unaffected. Nothing is being recorded, so the History page stays empty and past data is unavailable.',
    action:
      'Check that the application data folder is writable and not full. Deleting history.db lets a fresh one be created.',
  },
  'TM-3002': {
    subsystem: 'history',
    title: 'A history query failed',
    meaning: 'One request for past data could not be answered. Recording continues.',
    action: 'Usually transient. If it repeats, the database file may be corrupt; delete history.db.',
  },

  // --- 4xxx settings --------------------------------------------------------
  'TM-4001': {
    subsystem: 'settings',
    title: 'Settings could not be read',
    meaning:
      'The settings file was missing or unreadable, so defaults are in use: widget placement, the metrics it shows and the history toggle are all back to their starting values for this session.',
    action:
      'Any change you make writes a clean file, so this normally corrects itself. Delete settings.json to force it.',
  },
  'TM-4002': {
    subsystem: 'settings',
    title: 'Settings could not be saved',
    meaning:
      'Changes apply now but will be lost when the application closes. Usually a permissions or disk-space problem.',
    action: 'Check that the application data folder is writable and the disk is not full.',
  },

  // --- 5xxx widget ----------------------------------------------------------
  'TM-5001': {
    subsystem: 'widget',
    title: 'The widget window could not be created',
    meaning: 'The widget is unavailable. The main window is unaffected.',
    action: 'Usually a graphics driver problem, since the widget is a transparent window.',
  },
  'TM-5002': {
    subsystem: 'widget',
    title: 'The widget reported an unusable size',
    meaning:
      'A measurement from the widget was outside sane bounds and was ignored, so it keeps its previous size.',
    action: 'Cosmetic. Report it if the widget is visibly the wrong size.',
  },

  // --- 6xxx export ----------------------------------------------------------
  'TM-6001': {
    subsystem: 'export',
    title: 'The export could not be written',
    meaning: 'Nothing was saved. The chosen location may be read-only or full.',
    action: 'Try a different folder, or copy to the clipboard instead.',
  },
  'TM-6002': {
    subsystem: 'export',
    title: 'The clipboard could not be set',
    meaning:
      'The export was not copied. The clipboard is shared, and another application can be holding it open.',
    action: 'Close whatever else may be using the clipboard and try again, or save to a file.',
  },

  // --- 7xxx crash handling --------------------------------------------------
  'TM-7001': {
    subsystem: 'crash',
    title: 'A window process crashed and was reloaded',
    meaning:
      'The interface died and was rebuilt. Nothing was lost: a window holds no state the next sample cannot rebuild.',
    action: 'None if it happened once. Report it if it repeats.',
  },
  'TM-7002': {
    subsystem: 'crash',
    title: 'A window crashed too often to keep reloading',
    meaning:
      'Reloading was abandoned after repeated crashes, because something is reproducibly wrong rather than transient.',
    action: 'Restart the application, and report the reason recorded beside this code.',
  },
  'TM-7003': {
    subsystem: 'crash',
    title: 'A window stopped responding',
    meaning: 'The interface is alive but not answering. Measurement continues regardless.',
    action: 'Wait a moment. Report it if it does not recover.',
  },
  'TM-7004': {
    subsystem: 'crash',
    title: 'A helper process died',
    meaning:
      'A graphics or utility process crashed. Windows and Electron re-create these on their own, so this is usually invisible.',
    action: 'None unless the interface is visibly broken; then update the graphics driver.',
  },
  'TM-7005': {
    subsystem: 'crash',
    title: 'A fatal error was caught and the application relaunched',
    meaning: 'The application crashed and brought itself back.',
    action: 'Report the stack recorded beside this code.',
  },
  'TM-7006': {
    subsystem: 'crash',
    title: 'An unhandled promise rejection',
    meaning:
      'A bug, but not necessarily a harmful one: the application kept running rather than stopping over it.',
    action: 'Report the message beside this code.',
  },
  'TM-7007': {
    subsystem: 'crash',
    title: 'Restarting was abandoned to avoid a loop',
    meaning:
      'The application crashed and restarted several times in a few minutes, so it stopped relaunching. Something is reproducibly wrong, and crashing forever would be worse than staying closed.',
    action: 'Report the crash reports in the log folder; they name what failed each time.',
  },
  'TM-7008': {
    subsystem: 'crash',
    title: 'The crash reporter could not start',
    meaning: 'No minidumps will be written for native crashes. Everything else works.',
    action: 'None. It only reduces what can be diagnosed if a crash happens later.',
  },
  'TM-7009': {
    subsystem: 'crash',
    title: 'A crash report could not be written',
    meaning: 'A crash happened and could not be recorded to disk. The log line above it survives.',
    action: 'Check that the log folder is writable and the disk is not full.',
  },
  'TM-7010': {
    subsystem: 'crash',
    title: 'Restart history could not be saved',
    meaning:
      'The loop guard cannot count restarts across restarts, so it may allow more relaunches than it should.',
    action: 'Check that the log folder is writable.',
  },

  // --- 8xxx renderer --------------------------------------------------------
  'TM-8001': {
    subsystem: 'renderer',
    title: 'An error inside the interface',
    meaning:
      'Something in the window threw. Part of the interface may be blank; measurement is unaffected.',
    action: 'Report the message and stack beside this code.',
  },
  'TM-8002': {
    subsystem: 'renderer',
    title: 'An unhandled promise rejection inside the interface',
    meaning: 'As above: a bug in the interface, not in measurement.',
    action: 'Report the message beside this code.',
  },

  // --- 9xxx logging ---------------------------------------------------------
  'TM-9001': {
    subsystem: 'logging',
    title: 'The log folder could not be created',
    meaning:
      'Nothing is being written to disk this session, so a later crash will leave no record. The application otherwise works.',
    action: 'Check that the application data folder is writable.',
  },
  'TM-9002': {
    subsystem: 'logging',
    title: 'The log could not be written',
    meaning: 'Logging stopped for this session, usually a full or read-only disk.',
    action: 'Free disk space and restart.',
  },
} as const satisfies Record<string, Omit<ErrorDefinition, 'code'>>;

export type ErrorCode = keyof typeof ERROR_CODES;

/** The registry as a list, for the reference view. */
export const ERROR_CODE_LIST: ErrorDefinition[] = Object.entries(ERROR_CODES).map(
  ([code, definition]) => ({ code, ...definition }),
);

/** Look one up. Returns null for a code from a newer version than this one. */
export function describeErrorCode(code: string): ErrorDefinition | null {
  const definition = (ERROR_CODES as Record<string, Omit<ErrorDefinition, 'code'>>)[code];
  return definition ? { code, ...definition } : null;
}
