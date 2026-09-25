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
 * | 0xxx | Acting on processes and the system |
 * | 1xxx | Startup |
 * | 2xxx | Native collector |
 * | 3xxx | History database |
 * | 4xxx | Settings |
 * | 5xxx | Desktop widget and tray |
 * | 6xxx | Export |
 * | 7xxx | Crash handling and recovery |
 * | 8xxx | Renderer |
 * | 9xxx | Logging itself |
 */

export type ErrorSubsystem =
  | 'actions'
  | 'startup'
  | 'collector'
  | 'history'
  | 'settings'
  | 'widget'
  | 'tray'
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
  // --- 0xxx acting on processes and the system ------------------------------
  'TM-0001': {
    subsystem: 'actions',
    title: 'Windows refused to let Task Manager act on the process',
    meaning:
      'The process runs with more privileges than Task Manager: as administrator, as a Windows service, or as another user. Windows only lets an application end or change processes at or below its own level. Nothing was done to it.',
    action:
      'Restart Task Manager as administrator (from the tray menu or the dialog that showed this code) and try again.',
  },
  'TM-0002': {
    subsystem: 'actions',
    title: 'The process is protected by Windows',
    meaning:
      'Windows protects some processes, such as antivirus engines and parts of Windows itself, from being ended or changed by any application, even one running as administrator. Nothing was done to it.',
    action:
      'Nothing can do this from Task Manager. A protected program can only be stopped through its own settings, or by uninstalling it.',
  },
  'TM-0003': {
    subsystem: 'actions',
    title: 'The process had been replaced',
    meaning:
      'The process you chose exited, and Windows gave its PID to a different program before the action ran. Task Manager checks the start time as well as the PID, noticed, and did nothing, so the other program was not touched.',
    action: 'Find the program in the list again. If it restarted, it has a new row.',
  },
  'TM-0004': {
    subsystem: 'actions',
    title: 'Refused: the process is critical to Windows',
    meaning:
      'Windows marks this process as critical. Ending it stops the whole system with a blue screen and loses everything unsaved in every program, so Task Manager will not do it.',
    action: 'If it is misbehaving, restart Windows instead.',
  },
  'TM-0005': {
    subsystem: 'actions',
    title: 'The process is still exiting',
    meaning:
      'Windows accepted the request to end it, but it had not finished exiting a few seconds later. That usually means a driver is completing an operation on its behalf, and Windows waits for that before the process can go.',
    action:
      'Wait. It disappears once the operation completes. If it never does, a driver is stuck and only restarting Windows clears it.',
  },
  'TM-0006': {
    subsystem: 'actions',
    title: 'Windows could not carry out the action',
    meaning:
      'The call into Windows failed for a reason other than permissions. The Windows error number shown alongside this code says which.',
    action: 'Try again. If it keeps failing, report this code and the Windows error number.',
  },
  'TM-0007': {
    subsystem: 'actions',
    title: 'The window could not be brought to the front',
    meaning:
      'Windows only lets the application in front move the focus to another window, and it declined this time. Nothing else happened.',
    action: "Click the program's button on the taskbar instead.",
  },
  'TM-0008': {
    subsystem: 'actions',
    title: "The program's windows could not be asked to close",
    meaning:
      'The program runs with more privileges than Task Manager, and Windows does not let an application send messages to one above it. Its windows are unaffected.',
    action: 'Restart Task Manager as administrator and try again, or use End task.',
  },
  'TM-0009': {
    subsystem: 'actions',
    title: "The program's file could not be shown",
    meaning:
      "Windows could not open the folder or the properties of the program's executable, usually because the file was moved or deleted after the program started.",
    action: 'Check whether the path shown still exists.',
  },
  'TM-0010': {
    subsystem: 'actions',
    title: 'Task Manager could not restart as administrator',
    meaning:
      'Windows could not start the administrator copy, for the reason given by the Windows error number alongside this code. This copy is still running, without administrator rights, exactly as before.',
    action:
      'Try again. If it keeps failing, right-click the Task Manager executable and choose Run as administrator.',
  },
  'TM-0011': {
    subsystem: 'actions',
    title: 'The debug privilege could not be switched on',
    meaning:
      'Task Manager is running as administrator, but Windows did not let it switch on the privilege that opens processes running as other accounts. Services and some system processes will still refuse to be ended or inspected.',
    action:
      'Usually a security policy removed the privilege from administrators. Nothing else is affected.',
  },
  'TM-0012': {
    subsystem: 'actions',
    title: 'Windows applied a lower priority than the one asked for',
    meaning:
      'The priority change went through, but Windows chose a lower class than requested. Realtime becomes High for any application without the privilege to raise a process that far, which only administrators hold. The dialog says which class is now in effect.',
    action: 'Restart Task Manager as administrator if realtime is really what you need.',
  },
  'TM-0013': {
    subsystem: 'actions',
    title: 'Windows Explorer did not come back',
    meaning:
      'Explorer was ended so it could restart, but no new taskbar appeared. Windows did not restart it by itself, and Task Manager either could not start one or would not: running as administrator, an Explorer it started would run as administrator too, and so would everything opened from the taskbar afterwards.',
    action:
      'Signing out and back in brings Explorer back. So does running explorer.exe from a program that is not running as administrator.',
  },
  'TM-0014': {
    subsystem: 'actions',
    title: 'Windows could not start the new task',
    meaning:
      'Windows could not find or open what was typed: no program by that name on the path or registered with Windows, no file at that location, or nothing set to open that kind of file. Nothing was started.',
    action:
      'Check the spelling, give the full path, or use Browse to pick the program.',
  },
  'TM-0015': {
    subsystem: 'actions',
    title: 'Windows refused to let Task Manager start or stop the service',
    meaning:
      'Windows decides per service who may start and stop it. For most services that is administrators only; for a few, the signed-in user as well. Nothing was changed.',
    action:
      'Restart Task Manager as administrator and try again. Some services refuse even administrators; Windows protects those.',
  },
  'TM-0016': {
    subsystem: 'actions',
    title: 'The service could not be started or stopped',
    meaning:
      'Windows or the service itself reported an error, given by number alongside this code. A service that starts and then stops at once usually cannot find something it needs: a file, a setting, or another service.',
    action:
      'Try again. If it keeps failing, the System event log usually has an entry from the Service Control Manager saying why.',
  },
  'TM-0017': {
    subsystem: 'actions',
    title: 'The service did not finish starting or stopping',
    meaning:
      'Windows was asked, and the service said it was starting or stopping, but 30 seconds later it had not finished. Some services take longer; a stuck one never finishes.',
    action:
      'Wait, and watch its status on the Services page. If it stays stuck, restarting Windows clears it.',
  },
  'TM-0018': {
    subsystem: 'actions',
    title: 'The service is disabled',
    meaning:
      'Its start type is Disabled, which stops anything from starting it, Task Manager included. Nothing was changed.',
    action:
      'Change its start type in Services (Open Services on the right-click menu), if it should be allowed to run.',
  },
  'TM-0019': {
    subsystem: 'actions',
    title: 'The service does not accept being stopped',
    meaning:
      'Services say which requests they accept, and this one does not accept stopping, at least not at the moment. Some never do, because Windows cannot run without them.',
    action: 'Nothing to do from here. If it is misbehaving, restart Windows.',
  },
  'TM-0020': {
    subsystem: 'actions',
    title: 'The service no longer exists',
    meaning:
      'It was removed, usually by uninstalling the program it belonged to, after the list was read. Nothing was changed.',
    action: 'None. The list catches up within a few seconds.',
  },
  'TM-0021': {
    subsystem: 'actions',
    title: 'Some services did not start again after a restart',
    meaning:
      'Restarting a service stops the services that depend on it first, and starts them again afterwards. The service itself restarted, but the ones named alongside this code did not come back.',
    action: 'Start them from the Services page. If one will not start, its own report says why.',
  },
  'TM-0022': {
    subsystem: 'actions',
    title: 'Services could not be opened',
    meaning:
      "Windows could not open the Services console (services.msc), usually because a policy blocks the Microsoft Management Console.",
    action: 'Try running services.msc from Run new task.',
  },
  'TM-0023': {
    subsystem: 'actions',
    title: 'Only administrators can change what starts for every user',
    meaning:
      'Programs registered for every user of this PC are recorded in a part of the registry that only administrators may change. Nothing was changed.',
    action: 'Restart Task Manager as administrator and try again.',
  },
  'TM-0024': {
    subsystem: 'actions',
    title: 'The startup entry no longer exists',
    meaning:
      'It was removed after the list was read, usually by the program itself or by uninstalling it. Nothing was changed.',
    action: 'None. The list is read again when the page is next shown.',
  },
  'TM-0025': {
    subsystem: 'actions',
    title: 'The startup setting could not be changed',
    meaning:
      'Windows refused to record the change, for the reason given by the Windows error number alongside this code. The program starts or not exactly as before.',
    action: 'Try again. If it keeps failing, report this code and the Windows error number.',
  },
  'TM-0026': {
    subsystem: 'actions',
    title: "Windows refused to let Task Manager read the process's memory",
    meaning:
      'A memory dump is a copy of everything the process has in memory, and Windows only lets an application read that from processes at or below its own level. Protected processes refuse even administrators. Nothing was written.',
    action: 'Restart Task Manager as administrator and try again.',
  },
  'TM-0027': {
    subsystem: 'actions',
    title: 'The memory dump could not be written',
    meaning:
      'Windows reported an error while writing it, given by number alongside this code; the most common is a full disk, since a dump is as large as the memory the process uses. Nothing was left behind.',
    action: 'Free some disk space and try again, or report this code and the error number.',
  },

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
  'TM-1013': {
    subsystem: 'startup',
    title: 'Running as administrator could not be set up',
    meaning:
      'Checking for administrator rights, or switching on the privilege that goes with them, failed outright. The application runs, but may refuse to end or inspect services and system processes as if it were not elevated.',
    action: 'Restart the application. Report the message beside this code if it repeats.',
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
  'TM-2004': {
    subsystem: 'collector',
    title: 'The service list could not be read',
    meaning:
      'Windows did not return the list of services, for the reason given by number alongside this code. The Services page stays empty and svchost.exe processes are not labelled with their services. Everything else is measured as usual.',
    action: 'It is read again every few seconds. If it keeps failing, report the Windows error number.',
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

  'TM-3003': {
    subsystem: 'history',
    title: 'History could not be cleared',
    meaning:
      'The request to delete recorded history was not confirmed, so some or all of it may still be on disk. Recording carries on either way.',
    action:
      'Try again. To be certain, close Task Manager and delete history.db from the folder shown on the History page.',
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
  'TM-5003': {
    subsystem: 'tray',
    title: 'The live tray icon could not be drawn',
    meaning:
      'The tray has gone back to the plain application icon for the rest of this session. Its tooltip still shows the current values and everything else is unaffected.',
    action:
      'Report the message beside this code. Restarting the application tries the live icon again.',
  },
  'TM-5004': {
    subsystem: 'tray',
    title: 'The live tray icon is off because its cost could not be bounded',
    meaning:
      'Every redraw of the icon holds a few graphics handles until they are explicitly reclaimed, and reclaiming them was not possible here. Rather than let them build up for as long as the application runs, the tray shows the plain icon instead.',
    action: 'Nothing is lost but the bars; the tooltip still shows the values. Report this code.',
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
