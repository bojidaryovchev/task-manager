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
    IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, REALTIME_PRIORITY_CLASS,
};

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
    };
    let Some((pid, created)) = parse_key(&key) else {
        return unreachable("notRunning");
    };
    let process = match Process::open(pid, created, ACCESS_QUERY) {
        Ok(process) => process,
        Err(refusal) => return unreachable(refusal_name(refusal)),
    };
    JsProcessState {
        status: "running".to_string(),
        can_end: would_grant(pid, ACCESS_END),
        can_adjust: would_grant(pid, ACCESS_ADJUST),
        is_critical: process.is_critical(),
        window_count: window::taskbar_windows(pid).len() as u32,
        is_shell: window::shell_process_id() == Some(pid),
        priority_class: process
            .priority_class()
            .and_then(priority_name)
            .map(str::to_string),
    }
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

/// Show the Windows Properties dialog for a file, as Explorer does.
///
/// False when Windows could not show it, usually because the file is no longer
/// at that path.
#[napi]
pub fn show_file_properties(path: String) -> bool {
    crate::win::shell::show_properties(&path)
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
    fn describes_a_stale_key_as_unreachable() {
        let state = inspect_process(format!("{}:1", std::process::id()));
        assert_eq!(state.status, "identityChanged");
        assert!(!state.can_end);
    }
}
