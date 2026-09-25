//! Acting on processes, for the process menu.
//!
//! Every function takes a process key - `pid:createTime100ns`, the identity the
//! snapshots carry - and does nothing unless the process with that PID is still
//! the one created at that time. `win::process_control` explains why that
//! check cannot go stale once it has passed.
//!
//! Outcomes are reported as plain strings rather than errors. Most of them are
//! not failures of this module - Windows refusing access, or a process that
//! already exited, is information the application has to show, and the
//! interface decides how.

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;

use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;
use windows_sys::Win32::System::Threading::{
    ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS, HIGH_PRIORITY_CLASS,
    IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
    REALTIME_PRIORITY_CLASS,
};

/// The power throttling mechanism that makes a process EcoQoS.
const EXECUTION_SPEED: u32 = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;

use crate::win::process_control::{
    would_grant, Process, Refusal, ACCESS_ADJUST, ACCESS_END, ACCESS_QUERY,
};
use crate::win::window;

/// How long ending a process waits to see it actually go.
///
/// Ending is asynchronous. Almost every process is gone within milliseconds;
/// one stuck in a driver call can take far longer, and waiting indefinitely
/// would hold a thread for nothing, so after this the answer is "still
/// exiting" rather than a claim either way.
const END_WAIT_MS: u32 = 3_000;

/// Split a process key into its PID and creation time.
pub fn parse_key(key: &str) -> Option<(u32, i64)> {
    let (pid, created) = key.split_once(':')?;
    let pid = pid.parse::<u32>().ok()?;
    let created = created.parse::<i64>().ok()?;
    (created >= 0).then_some((pid, created))
}

fn refusal_name(refusal: Refusal) -> &'static str {
    match refusal {
        Refusal::NotRunning => "notRunning",
        Refusal::IdentityChanged => "identityChanged",
        Refusal::AccessDenied => "accessDenied",
    }
}

/// What the process menu needs to know before it is shown.
#[napi(object)]
pub struct JsProcessState {
    /// `running`, or why the process cannot be reached: `notRunning`,
    /// `identityChanged` (the PID now belongs to another process) or
    /// `accessDenied` (even reading it is refused).
    #[napi(ts_type = "'running' | 'notRunning' | 'identityChanged' | 'accessDenied'")]
    pub status: String,
    /// Windows would let this application end it.
    pub can_end: bool,
    /// Windows would let this application change its priority, efficiency
    /// mode or affinity.
    pub can_adjust: bool,
    /// Ending it would stop Windows. Absent when that could not be read.
    pub is_critical: Option<bool>,
    /// Its windows on the taskbar.
    pub window_count: u32,
    /// It is the Windows shell: the Explorer that owns the taskbar.
    pub is_shell: bool,
    /// `idle`, `belowNormal`, `normal`, `aboveNormal`, `high` or `realtime`.
    /// Absent when it cannot be read.
    #[napi(ts_type = "'idle' | 'belowNormal' | 'normal' | 'aboveNormal' | 'high' | 'realtime'")]
    pub priority_class: Option<String>,
    /// Whether it is set to run as EcoQoS, which is what Efficiency mode sets.
    /// Absent when that cannot be read.
    pub efficiency_mode: Option<bool>,
    /// The logical processors it may run on, by index. Absent when unreadable.
    pub affinity: Option<Vec<u32>>,
    /// The logical processors the system offers it, by index.
    pub processors: Option<Vec<u32>>,
}

/// The result of changing a setting of a process, with what Windows actually
/// applied read back afterwards, since that is not always what was asked for.
#[napi(object)]
pub struct JsSettingOutcome {
    #[napi(ts_type = "'done' | 'notRunning' | 'identityChanged' | 'accessDenied' | 'failed'")]
    pub outcome: String,
    pub win32_error: Option<u32>,
    #[napi(ts_type = "'idle' | 'belowNormal' | 'normal' | 'aboveNormal' | 'high' | 'realtime'")]
    pub priority_class: Option<String>,
    pub efficiency_mode: Option<bool>,
    pub affinity: Option<Vec<u32>>,
}

/// The result of an action.
#[napi(object)]
pub struct JsActionOutcome {
    /// What happened. The possible values depend on the action.
    #[napi(
        ts_type = "'ended' | 'stillExiting' | 'critical' | 'requested' | 'noWindows' | 'done' | 'refused' | 'notRunning' | 'identityChanged' | 'accessDenied' | 'failed'"
    )]
    pub outcome: String,
    /// The Windows error code, when a call failed for a reason worth reporting.
    pub win32_error: Option<u32>,
    /// How many things the action touched, for the actions that touch several.
    pub count: Option<u32>,
}

impl JsActionOutcome {
    fn plain(outcome: &str) -> Self {
        Self {
            outcome: outcome.to_string(),
            win32_error: None,
            count: None,
        }
    }
}

/// Read what the process menu may offer for a process.
#[napi]
pub fn inspect_process(key: String) -> JsProcessState {
    let unreachable = |status: &str| JsProcessState {
        status: status.to_string(),
        can_end: false,
        can_adjust: false,
        is_critical: None,
        window_count: 0,
        is_shell: false,
        priority_class: None,
        efficiency_mode: None,
        affinity: None,
        processors: None,
    };
    let Some((pid, created)) = parse_key(&key) else {
        return unreachable("notRunning");
    };
    let process = match Process::open(pid, created, ACCESS_QUERY) {
        Ok(process) => process,
        Err(refusal) => return unreachable(refusal_name(refusal)),
    };
    let affinity = process.affinity();
    JsProcessState {
        status: "running".to_string(),
        can_end: would_grant(pid, ACCESS_END),
        can_adjust: would_grant(pid, ACCESS_ADJUST),
        is_critical: process.is_critical(),
        window_count: window::taskbar_windows(pid).len() as u32,
        is_shell: window::shell_process_id() == Some(pid),
        priority_class: current_priority(&process),
        efficiency_mode: efficiency_of(&process),
        affinity: affinity.map(|(mask, _)| indices_of(mask)),
        processors: affinity.map(|(_, system)| indices_of(system)),
    }
}

fn current_priority(process: &Process) -> Option<String> {
    process
        .priority_class()
        .and_then(priority_name)
        .map(str::to_string)
}

fn efficiency_of(process: &Process) -> Option<bool> {
    process
        .power_throttling()
        .map(|(control, state)| control & EXECUTION_SPEED != 0 && state & EXECUTION_SPEED != 0)
}

/// The indices of the set bits in an affinity mask.
pub fn indices_of(mask: usize) -> Vec<u32> {
    (0..usize::BITS)
        .filter(|bit| mask & (1usize << bit) != 0)
        .collect()
}

/// An affinity mask from processor indices, or `None` for an index past the
/// end of a mask.
pub fn mask_of(indices: &[u32]) -> Option<usize> {
    indices.iter().try_fold(0usize, |mask, &index| {
        (index < usize::BITS).then(|| mask | (1usize << index))
    })
}

/// Open a process to change one of its settings, then report what is in
/// effect afterwards.
fn adjust(key: &str, change: impl FnOnce(&Process) -> Result<(), u32>) -> JsSettingOutcome {
    let failed = |outcome: &str, win32_error: Option<u32>| JsSettingOutcome {
        outcome: outcome.to_string(),
        win32_error,
        priority_class: None,
        efficiency_mode: None,
        affinity: None,
    };
    let Some((pid, created)) = parse_key(key) else {
        return failed("notRunning", None);
    };
    let process = match Process::open(pid, created, ACCESS_ADJUST) {
        Ok(process) => process,
        Err(refusal) => return failed(refusal_name(refusal), None),
    };
    let result = change(&process);
    JsSettingOutcome {
        outcome: match result {
            Ok(()) => "done",
            Err(ERROR_ACCESS_DENIED) => "accessDenied",
            Err(_) => "failed",
        }
        .to_string(),
        win32_error: result.err(),
        priority_class: current_priority(&process),
        efficiency_mode: efficiency_of(&process),
        affinity: process.affinity().map(|(mask, _)| indices_of(mask)),
    }
}

/// Set a process's priority class, by name.
///
/// Windows may apply a different class than asked for - realtime becomes high
/// for a caller without the privilege to raise it that far - so the class in
/// effect afterwards is read back and returned.
#[napi]
pub fn set_process_priority(
    key: String,
    #[napi(
        ts_arg_type = "'idle' | 'belowNormal' | 'normal' | 'aboveNormal' | 'high' | 'realtime'"
    )]
    priority_class: String,
) -> JsSettingOutcome {
    let Some(value) = priority_value(&priority_class) else {
        return JsSettingOutcome {
            outcome: "failed".to_string(),
            win32_error: None,
            priority_class: None,
            efficiency_mode: None,
            affinity: None,
        };
    };
    adjust(&key, |process| process.set_priority_class(value))
}

/// Turn Efficiency mode on or off, as Windows Task Manager defines it: low
/// priority and EcoQoS on, or both undone.
///
/// Off hands the power decision back to Windows rather than forcing full speed,
/// and restores `restore_priority` - the class the process had before - or
/// normal when that is not known.
#[napi]
pub fn set_efficiency_mode(
    key: String,
    enabled: bool,
    #[napi(
        ts_arg_type = "'idle' | 'belowNormal' | 'normal' | 'aboveNormal' | 'high' | 'realtime'"
    )]
    restore_priority: Option<String>,
) -> JsSettingOutcome {
    adjust(&key, |process| {
        if enabled {
            process.set_power_throttling(EXECUTION_SPEED, EXECUTION_SPEED)?;
            process.set_priority_class(IDLE_PRIORITY_CLASS)
        } else {
            process.set_power_throttling(0, 0)?;
            let restore = restore_priority
                .as_deref()
                .and_then(priority_value)
                .unwrap_or(NORMAL_PRIORITY_CLASS);
            process.set_priority_class(restore)
        }
    })
}

/// Restrict a process to the given logical processors, by index.
#[napi]
pub fn set_process_affinity(key: String, processors: Vec<u32>) -> JsSettingOutcome {
    let Some(mask) = mask_of(&processors).filter(|mask| *mask != 0) else {
        return JsSettingOutcome {
            outcome: "failed".to_string(),
            win32_error: None,
            priority_class: None,
            efficiency_mode: None,
            affinity: None,
        };
    };
    adjust(&key, |process| process.set_affinity(mask))
}

pub struct EndProcess {
    key: String,
}

impl Task for EndProcess {
    type Output = JsActionOutcome;
    type JsValue = JsActionOutcome;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(end(&self.key))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// End a process and wait briefly to see it go.
///
/// Resolves to `ended`, `stillExiting`, `critical` (refused: ending it would
/// stop Windows), `notRunning`, `identityChanged`, `accessDenied`, or `failed`
/// with the Windows error. Runs off the JavaScript thread, because the wait can
/// last seconds.
#[napi(ts_return_type = "Promise<JsActionOutcome>")]
pub fn end_process(key: String) -> AsyncTask<EndProcess> {
    AsyncTask::new(EndProcess { key })
}

fn end(key: &str) -> JsActionOutcome {
    let Some((pid, created)) = parse_key(key) else {
        return JsActionOutcome::plain("notRunning");
    };
    let process = match Process::open(pid, created, ACCESS_END) {
        Ok(process) => process,
        Err(refusal) => return JsActionOutcome::plain(refusal_name(refusal)),
    };
    // Refused here rather than left to the caller, so no path through this
    // module can take Windows down. Unreadable counts as not critical: a
    // process this application cannot even query, it also cannot end.
    if process.is_critical() == Some(true) {
        return JsActionOutcome::plain("critical");
    }
    if let Err(error) = process.terminate() {
        // Windows reports access denied for a process that finished exiting
        // after the checks above, which is not a refusal worth showing.
        if process.has_exited() {
            return JsActionOutcome::plain("notRunning");
        }
        return JsActionOutcome {
            outcome: if error == ERROR_ACCESS_DENIED {
                "accessDenied"
            } else {
                "failed"
            }
            .to_string(),
            win32_error: Some(error),
            count: None,
        };
    }
    JsActionOutcome::plain(if process.wait_for_exit(END_WAIT_MS) {
        "ended"
    } else {
        "stillExiting"
    })
}

/// Ask every taskbar window of a process to close, as its close button would.
///
/// The program decides what happens next: it may close, ask to save, or ignore
/// the request. Resolves to `requested` with how many windows were asked,
/// `noWindows`, `accessDenied` when Windows would not deliver the request (the
/// program runs with higher privileges), `notRunning` or `identityChanged`.
#[napi]
pub fn close_process_windows(key: String) -> JsActionOutcome {
    let Some((pid, created)) = parse_key(&key) else {
        return JsActionOutcome::plain("notRunning");
    };
    // Held until the requests are posted, so the PID cannot change hands
    // between checking it and messaging its windows.
    let _process = match Process::open(pid, created, ACCESS_QUERY) {
        Ok(process) => process,
        Err(refusal) => return JsActionOutcome::plain(refusal_name(refusal)),
    };
    let windows = window::taskbar_windows(pid);
    if windows.is_empty() {
        return JsActionOutcome::plain("noWindows");
    }
    let mut delivered = 0u32;
    let mut last_error = None;
    for target in windows {
        match window::request_close(target) {
            Ok(()) => delivered += 1,
            Err(error) => last_error = Some(error),
        }
    }
    if delivered == 0 {
        return JsActionOutcome {
            outcome: if last_error == Some(ERROR_ACCESS_DENIED) {
                "accessDenied"
            } else {
                "failed"
            }
            .to_string(),
            win32_error: last_error,
            count: Some(0),
        };
    }
    JsActionOutcome {
        outcome: "requested".to_string(),
        win32_error: None,
        count: Some(delivered),
    }
}

/// Bring a process's front-most window forward, restoring it if minimised.
///
/// Resolves to `done`, `noWindows`, `refused` when Windows would not move the
/// focus, `notRunning` or `identityChanged`.
#[napi]
pub fn bring_process_to_front(key: String) -> JsActionOutcome {
    let Some((pid, created)) = parse_key(&key) else {
        return JsActionOutcome::plain("notRunning");
    };
    let _process = match Process::open(pid, created, ACCESS_QUERY) {
        Ok(process) => process,
        Err(refusal) => return JsActionOutcome::plain(refusal_name(refusal)),
    };
    match window::taskbar_windows(pid).first() {
        None => JsActionOutcome::plain("noWindows"),
        Some(&front) => JsActionOutcome::plain(if window::bring_to_front(front) {
            "done"
        } else {
            "refused"
        }),
    }
}

/// The result of asking to run something as administrator.
#[napi(object)]
pub struct JsLaunchOutcome {
    /// `started`, `declined` (the user answered no, which is not a failure)
    /// or `failed`, with the Windows error.
    #[napi(ts_type = "'started' | 'declined' | 'failed'")]
    pub outcome: String,
    pub win32_error: Option<u32>,
}

pub struct LaunchElevated {
    file: String,
    parameters: String,
}

impl Task for LaunchElevated {
    type Output = crate::win::elevation::Launch;
    type JsValue = JsLaunchOutcome;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(crate::win::elevation::launch_elevated(
            &self.file,
            &self.parameters,
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        use crate::win::elevation::Launch;
        let (outcome, win32_error) = match output {
            Launch::Started => ("started", None),
            Launch::Declined => ("declined", None),
            Launch::Failed(error) => ("failed", Some(error)),
        };
        Ok(JsLaunchOutcome {
            outcome: outcome.to_string(),
            win32_error,
        })
    }
}

/// Start `file` with `parameters` as administrator, through the Windows
/// elevation prompt. Resolves once the user has answered it, which can take as
/// long as they like, so it runs off the JavaScript thread.
#[napi(ts_return_type = "Promise<JsLaunchOutcome>")]
pub fn launch_elevated(file: String, parameters: String) -> AsyncTask<LaunchElevated> {
    AsyncTask::new(LaunchElevated { file, parameters })
}

/// Split a command into the thing to open and its parameters, the way the Run
/// dialog reads one: a quoted program; otherwise the longest leading run of
/// words that names something that exists, so an unquoted path with spaces
/// still works; otherwise the first word.
pub fn split_command(command: &str, exists: impl Fn(&str) -> bool) -> (String, String) {
    let command = command.trim();
    if let Some(rest) = command.strip_prefix('"') {
        return match rest.split_once('"') {
            Some((file, parameters)) => (file.to_string(), parameters.trim().to_string()),
            None => (rest.to_string(), String::new()),
        };
    }
    let breaks: Vec<usize> = command
        .char_indices()
        .filter(|(_, c)| c.is_whitespace())
        .map(|(index, _)| index)
        .collect();
    for &at in breaks.iter().rev() {
        let (file, parameters) = command.split_at(at);
        if exists(&expand_environment(file)) {
            return (file.to_string(), parameters.trim().to_string());
        }
    }
    match breaks.first() {
        Some(&at) => {
            let (file, parameters) = command.split_at(at);
            (file.to_string(), parameters.trim().to_string())
        }
        None => (command.to_string(), String::new()),
    }
}

/// Replace `%NAME%` with the environment variable's value, as the Run dialog
/// does. A name that is not set is left as it was.
pub fn expand_environment(text: &str) -> String {
    let mut expanded = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        expanded.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => match std::env::var(&after[..end]) {
                Ok(value) => {
                    expanded.push_str(&value);
                    rest = &after[end + 1..];
                }
                Err(_) => {
                    expanded.push('%');
                    rest = after;
                }
            },
            _ => {
                expanded.push('%');
                rest = after;
            }
        }
    }
    expanded.push_str(rest);
    expanded
}

pub struct RunCommand {
    command: String,
    as_administrator: bool,
}

impl Task for RunCommand {
    type Output = crate::win::elevation::Launch;
    type JsValue = JsLaunchOutcome;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        use crate::win::elevation::{execute, Launch};
        let (file, parameters) =
            split_command(&self.command, |path| std::path::Path::new(path).exists());
        if file.is_empty() {
            return Ok(Launch::Failed(2));
        }
        let home = std::env::var("USERPROFILE").ok();
        Ok(execute(
            self.as_administrator.then_some("runas"),
            &expand_environment(&file),
            &parameters,
            home.as_deref(),
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        use crate::win::elevation::Launch;
        let (outcome, win32_error) = match output {
            Launch::Started => ("started", None),
            Launch::Declined => ("declined", None),
            Launch::Failed(error) => ("failed", Some(error)),
        };
        Ok(JsLaunchOutcome {
            outcome: outcome.to_string(),
            win32_error,
        })
    }
}

/// Run a command the way Windows' Run dialog does: a program, a document, a
/// folder, a URL or a registered name, with parameters, starting in the user's
/// profile folder. `as_administrator` shows the elevation prompt first.
#[napi(ts_return_type = "Promise<JsLaunchOutcome>")]
pub fn run_command(command: String, as_administrator: bool) -> AsyncTask<RunCommand> {
    AsyncTask::new(RunCommand {
        command,
        as_administrator,
    })
}

/// Turn on SeDebugPrivilege, which a process running as administrator holds but
/// has switched off. True when it is on afterwards.
#[napi]
pub fn enable_debug_privilege() -> bool {
    crate::win::elevation::enable_debug_privilege()
}

/// The full path of the executable a process is running, when it can be read.
#[napi]
pub fn process_image_path(pid: u32) -> Option<String> {
    crate::win::elevation::image_path(pid)
}

/// How long the old shell gets to finish exiting.
const SHELL_EXIT_WAIT_MS: u32 = 5_000;
/// How long to wait for a new shell, first from Windows and then from us.
const SHELL_APPEAR_WAIT: std::time::Duration = std::time::Duration::from_secs(8);

/// What became of restarting Windows Explorer.
#[napi(object)]
pub struct JsShellOutcome {
    /// `restarted` (Windows brought the shell back by itself), `started` (it
    /// did not, so a new one was started), `notStarted` (it did not, and
    /// starting one was not allowed), `noShell` (no shell was running),
    /// `accessDenied` or `failed`.
    #[napi(
        ts_type = "'restarted' | 'started' | 'notStarted' | 'noShell' | 'accessDenied' | 'failed'"
    )]
    pub outcome: String,
    pub win32_error: Option<u32>,
}

pub struct RestartShell {
    start_if_missing: bool,
}

impl Task for RestartShell {
    type Output = JsShellOutcome;
    type JsValue = JsShellOutcome;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(restart_shell_now(self.start_if_missing))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Restart the Windows shell: end the Explorer that owns the taskbar, and see
/// that a new one takes its place.
///
/// Windows restarts the shell by itself when it ends unexpectedly (Winlogon's
/// `AutoRestartShell`, which is on unless someone turned it off). If no shell
/// has appeared after a few seconds, a new Explorer is started - but only when
/// `start_if_missing` is true. The caller passes false when running as
/// administrator, because an Explorer started from an elevated process runs
/// elevated, and so would everything launched from the taskbar afterwards.
#[napi(ts_return_type = "Promise<JsShellOutcome>")]
pub fn restart_shell(start_if_missing: bool) -> AsyncTask<RestartShell> {
    AsyncTask::new(RestartShell { start_if_missing })
}

fn restart_shell_now(start_if_missing: bool) -> JsShellOutcome {
    let outcome = |outcome: &str, win32_error: Option<u32>| JsShellOutcome {
        outcome: outcome.to_string(),
        win32_error,
    };
    let Some(pid) = window::shell_process_id() else {
        return outcome("noShell", None);
    };
    let process = match crate::win::process_control::open_live(pid, ACCESS_END) {
        Ok(process) => process,
        Err(Refusal::AccessDenied) => return outcome("accessDenied", None),
        Err(_) => return outcome("noShell", None),
    };
    if let Err(error) = process.terminate() {
        return outcome(
            if error == ERROR_ACCESS_DENIED {
                "accessDenied"
            } else {
                "failed"
            },
            Some(error),
        );
    }
    process.wait_for_exit(SHELL_EXIT_WAIT_MS);
    drop(process);

    if wait_for_new_shell(pid) {
        return outcome("restarted", None);
    }
    if !start_if_missing {
        return outcome("notStarted", None);
    }
    if let Err(error) = crate::win::shell::start_explorer() {
        return outcome("failed", Some(error));
    }
    if wait_for_new_shell(pid) {
        outcome("started", None)
    } else {
        outcome("failed", None)
    }
}

/// Wait for a shell other than `old` to own the taskbar.
fn wait_for_new_shell(old: u32) -> bool {
    let deadline = std::time::Instant::now() + SHELL_APPEAR_WAIT;
    while std::time::Instant::now() < deadline {
        if matches!(window::shell_process_id(), Some(pid) if pid != old) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    false
}

/// Show the Windows Properties dialog for a file, as Explorer does.
///
/// False when Windows could not show it, usually because the file is no longer
/// at that path.
#[napi]
pub fn show_file_properties(path: String) -> bool {
    crate::win::shell::show_properties(&path)
}

/// The Windows priority class for a name, or `None` for an unknown one.
pub fn priority_value(name: &str) -> Option<u32> {
    Some(match name {
        "idle" => IDLE_PRIORITY_CLASS,
        "belowNormal" => BELOW_NORMAL_PRIORITY_CLASS,
        "normal" => NORMAL_PRIORITY_CLASS,
        "aboveNormal" => ABOVE_NORMAL_PRIORITY_CLASS,
        "high" => HIGH_PRIORITY_CLASS,
        "realtime" => REALTIME_PRIORITY_CLASS,
        _ => return None,
    })
}

/// The name for a Windows priority class, or `None` for a value Windows does
/// not document.
pub fn priority_name(class: u32) -> Option<&'static str> {
    Some(match class {
        IDLE_PRIORITY_CLASS => "idle",
        BELOW_NORMAL_PRIORITY_CLASS => "belowNormal",
        NORMAL_PRIORITY_CLASS => "normal",
        ABOVE_NORMAL_PRIORITY_CLASS => "aboveNormal",
        HIGH_PRIORITY_CLASS => "high",
        REALTIME_PRIORITY_CLASS => "realtime",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_key_the_snapshots_carry() {
        assert_eq!(
            parse_key("4312:133712345678901234"),
            Some((4312, 133_712_345_678_901_234))
        );
    }

    #[test]
    fn rejects_anything_that_is_not_a_key() {
        for bad in [
            "",
            "4312",
            ":1",
            "4312:",
            "a:1",
            "1:b",
            "-4:1",
            "4:-1",
            "4:1:2",
            "99999999999:1",
        ] {
            assert_eq!(parse_key(bad), None, "{bad}");
        }
    }

    #[test]
    fn names_every_documented_priority_class() {
        for class in [
            IDLE_PRIORITY_CLASS,
            BELOW_NORMAL_PRIORITY_CLASS,
            NORMAL_PRIORITY_CLASS,
            ABOVE_NORMAL_PRIORITY_CLASS,
            HIGH_PRIORITY_CLASS,
            REALTIME_PRIORITY_CLASS,
        ] {
            assert!(priority_name(class).is_some());
        }
        assert_eq!(priority_name(0x1234), None);
    }

    #[test]
    fn describes_its_own_process_as_running_and_not_critical() {
        let pid = std::process::id();
        let mut buffer = Vec::new();
        crate::win::ntdll::query_process_list_into(&mut buffer).expect("process list");
        let created = crate::win::ntdll::ProcessListIter::new(&buffer)
            .find(|entry| entry.info.unique_process_id as u32 == pid)
            .map(|entry| entry.info.create_time)
            .expect("own process listed");
        let state = inspect_process(format!("{pid}:{created}"));
        assert_eq!(state.status, "running");
        assert_eq!(state.is_critical, Some(false));
        assert!(state.can_end);
        assert_eq!(state.priority_class.as_deref(), Some("normal"));
    }

    #[test]
    fn splits_a_command_the_way_the_run_dialog_does() {
        let nothing_exists = |_: &str| false;
        assert_eq!(
            split_command(r#""C:\Program Files\App\app.exe" --flag x"#, nothing_exists),
            (
                r"C:\Program Files\App\app.exe".to_string(),
                "--flag x".to_string()
            )
        );
        assert_eq!(
            split_command("notepad  readme.txt", nothing_exists),
            ("notepad".to_string(), "readme.txt".to_string())
        );
        assert_eq!(
            split_command("  calc  ", nothing_exists),
            ("calc".to_string(), String::new())
        );
        assert_eq!(
            split_command("", nothing_exists),
            (String::new(), String::new())
        );
    }

    #[test]
    fn keeps_an_unquoted_path_with_spaces_together_when_it_exists() {
        let exists = |path: &str| path == r"C:\Program Files\App\app.exe";
        assert_eq!(
            split_command(r"C:\Program Files\App\app.exe --flag", exists),
            (
                r"C:\Program Files\App\app.exe".to_string(),
                "--flag".to_string()
            )
        );
    }

    #[test]
    fn expands_environment_variables_and_leaves_unknown_ones() {
        let windows = std::env::var("WINDIR").expect("WINDIR is always set");
        assert_eq!(
            expand_environment(r"%WINDIR%\notepad.exe"),
            format!(r"{windows}\notepad.exe")
        );
        assert_eq!(
            expand_environment("%NO_SUCH_VARIABLE_HERE%"),
            "%NO_SUCH_VARIABLE_HERE%"
        );
        assert_eq!(expand_environment("100% sure"), "100% sure");
    }

    #[test]
    fn converts_between_affinity_masks_and_processor_indices() {
        assert_eq!(indices_of(0b1011), vec![0, 1, 3]);
        assert_eq!(mask_of(&[0, 1, 3]), Some(0b1011));
        assert_eq!(mask_of(&[]), Some(0));
        assert_eq!(mask_of(&[usize::BITS]), None);
    }

    #[test]
    fn names_and_values_of_priority_classes_agree() {
        for name in [
            "idle",
            "belowNormal",
            "normal",
            "aboveNormal",
            "high",
            "realtime",
        ] {
            assert_eq!(priority_value(name).and_then(priority_name), Some(name));
        }
        assert_eq!(priority_value("urgent"), None);
    }

    /// A harmless helper process and its key, as a snapshot would name it.
    fn helper_with_key() -> (std::process::Child, String) {
        use std::os::windows::process::CommandExt;
        let child = std::process::Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .creation_flags(0x0800_0000)
            .spawn()
            .expect("ping starts");
        let pid = child.id();
        let mut buffer = Vec::new();
        crate::win::ntdll::query_process_list_into(&mut buffer).expect("process list");
        let created = crate::win::ntdll::ProcessListIter::new(&buffer)
            .find(|entry| entry.info.unique_process_id as u32 == pid)
            .map(|entry| entry.info.create_time)
            .expect("helper listed");
        (child, format!("{pid}:{created}"))
    }

    #[test]
    fn efficiency_mode_lowers_priority_and_restores_what_was_there() {
        let (mut child, key) = helper_with_key();
        let before = inspect_process(key.clone());
        assert_eq!(before.efficiency_mode, Some(false));
        assert_eq!(before.priority_class.as_deref(), Some("normal"));

        let on = set_efficiency_mode(key.clone(), true, None);
        assert_eq!(on.outcome, "done");
        assert_eq!(on.efficiency_mode, Some(true));
        assert_eq!(on.priority_class.as_deref(), Some("idle"));

        let off = set_efficiency_mode(key, false, Some("aboveNormal".into()));
        assert_eq!(off.outcome, "done");
        assert_eq!(off.efficiency_mode, Some(false));
        assert_eq!(off.priority_class.as_deref(), Some("aboveNormal"));
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn realtime_without_the_privilege_is_applied_as_high() {
        // The reason priority is read back rather than assumed. Tests run
        // unelevated, where the privilege to raise a process to realtime is
        // not held.
        if crate::host::host_info().is_elevated {
            return;
        }
        let (mut child, key) = helper_with_key();
        let outcome = set_process_priority(key, "realtime".into());
        assert_eq!(outcome.outcome, "done");
        assert_eq!(outcome.priority_class.as_deref(), Some("high"));
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn affinity_is_set_and_read_back_by_processor_index() {
        let (mut child, key) = helper_with_key();
        let processors = inspect_process(key.clone()).processors.expect("processors");
        let outcome = set_process_affinity(key, vec![processors[0]]);
        assert_eq!(outcome.outcome, "done");
        assert_eq!(outcome.affinity, Some(vec![processors[0]]));
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn refuses_an_empty_affinity() {
        let (mut child, key) = helper_with_key();
        assert_eq!(set_process_affinity(key, vec![]).outcome, "failed");
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn describes_a_stale_key_as_unreachable() {
        let state = inspect_process(format!("{}:1", std::process::id()));
        assert_eq!(state.status, "identityChanged");
        assert!(!state.can_end);
    }
}
