//! Starting and stopping Windows services, for the Services page.
//!
//! Windows decides per service who may do what. Most services can be started
//! and stopped only by administrators; some - per-user service instances and a
//! number of third-party services - by the signed-in user as well. Every
//! handle here asks for exactly the access its operation needs, so a refusal
//! is about that operation and nothing broader.
//!
//! Starting and stopping follow Microsoft's own samples ("Starting a
//! Service", "Stopping a Service"): wait out a pending state before acting,
//! stop the running dependents first in the order Windows lists them, and give
//! each wait 30 seconds before calling it timed out.
//!
//! Windows lists every dependent, not only the direct ones, each before the
//! service it depends on. Checked on this machine: the list for `nsi` includes
//! `upnphost`, which depends on it only through `SSDPSRV`, and lists it first.
//! So stopping them in order never meets one with dependents still running.

use std::time::Duration;

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Task};
use napi_derive::napi;
use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_SERVICE_ALREADY_RUNNING, ERROR_SERVICE_CANNOT_ACCEPT_CTRL,
    ERROR_SERVICE_DISABLED, ERROR_SERVICE_DOES_NOT_EXIST, ERROR_SERVICE_NOT_ACTIVE,
};
use windows_sys::Win32::System::Services::{
    SC_MANAGER_CONNECT, SERVICE_ACCEPT_STOP, SERVICE_ACTIVE, SERVICE_DISABLED,
    SERVICE_ENUMERATE_DEPENDENTS, SERVICE_QUERY_CONFIG, SERVICE_QUERY_STATUS, SERVICE_RUNNING,
    SERVICE_START, SERVICE_START_PENDING, SERVICE_STOP, SERVICE_STOPPED, SERVICE_STOP_PENDING,
};

use crate::api::service_state_name;
use crate::win::services::{self as scm, ScHandle, ServiceStatus};

/// How long each wait for a service to start or stop lasts, as in
/// Microsoft's samples.
const WAIT: Duration = Duration::from_secs(30);

/// A service by both of its names.
#[napi(object)]
pub struct JsServiceName {
    pub name: String,
    pub display_name: String,
}

/// What the service menu needs to know before it is shown.
#[napi(object)]
pub struct JsServiceState {
    /// Its state, or `notFound` when no service has that name any more.
    #[napi(
        ts_type = "'stopped' | 'startPending' | 'stopPending' | 'running' | 'continuePending' | 'pausePending' | 'paused' | 'unknown' | 'notFound'"
    )]
    pub state: String,
    /// The process it runs in, when it is running.
    pub pid: Option<u32>,
    /// Windows would let this application start it.
    pub can_start: bool,
    /// Windows would let this application stop it.
    pub can_stop: bool,
    /// It accepts being stopped right now. Some services never do.
    pub accepts_stop: bool,
    /// Its start type is Disabled, so it cannot be started.
    pub disabled: bool,
    /// Running services that depend on it and would stop with it, in the
    /// order they would be stopped. Absent when Windows would not say: some
    /// services let only administrators list their dependents.
    pub running_dependents: Option<Vec<JsServiceName>>,
}

/// What became of starting, stopping or restarting a service.
#[napi(object)]
pub struct JsServiceOutcome {
    /// `done`; `accessDenied`; `notFound`; `disabled` (it cannot be started
    /// while disabled); `cannotStop` (it does not accept being stopped now);
    /// `dependentsRunning` (asked not to stop them, and some are running);
    /// `stoppedWithError` (it started, then stopped, with the error given);
    /// `timedOut` (still starting or stopping after 30 seconds); or `failed`,
    /// with the Windows error.
    #[napi(
        ts_type = "'done' | 'accessDenied' | 'notFound' | 'disabled' | 'cannotStop' | 'dependentsRunning' | 'stoppedWithError' | 'timedOut' | 'failed'"
    )]
    pub outcome: String,
    pub win32_error: Option<u32>,
    /// The state it was left in, when it could be read.
    pub state: Option<String>,
    /// Services stopped along with it, by display name.
    pub stopped_dependents: Vec<String>,
    /// For a restart: services stopped along with it that did not start
    /// again, by display name.
    pub not_restarted: Vec<String>,
}

impl JsServiceOutcome {
    fn plain(outcome: &str, win32_error: Option<u32>) -> Self {
        Self {
            outcome: outcome.into(),
            win32_error,
            state: None,
            stopped_dependents: Vec::new(),
            not_restarted: Vec::new(),
        }
    }

    /// The outcome for a Windows error from opening or controlling a service.
    fn from_error(error: u32) -> Self {
        match error {
            ERROR_ACCESS_DENIED => Self::plain("accessDenied", None),
            ERROR_SERVICE_DOES_NOT_EXIST => Self::plain("notFound", None),
            ERROR_SERVICE_DISABLED => Self::plain("disabled", None),
            ERROR_SERVICE_CANNOT_ACCEPT_CTRL => Self::plain("cannotStop", None),
            error => Self::plain("failed", Some(error)),
        }
    }

    fn with_state(mut self, status: Option<ServiceStatus>) -> Self {
        self.state = status.map(|status| service_state_name(status.state).into());
        self
    }
}

/// Open a service by name. On failure, the Windows error code.
fn open(name: &str, access: u32) -> Result<ScHandle, u32> {
    let manager = scm::open_manager(SC_MANAGER_CONNECT)?;
    scm::open_service(&manager, name, access)
}

/// What the service menu may offer for a service. Opens a few handles and
/// starts or stops nothing.
#[napi]
pub fn inspect_service(name: String) -> JsServiceState {
    let mut state = JsServiceState {
        state: "notFound".into(),
        pid: None,
        can_start: false,
        can_stop: false,
        accepts_stop: false,
        disabled: false,
        running_dependents: None,
    };
    let Ok(manager) = scm::open_manager(SC_MANAGER_CONNECT) else {
        state.state = "unknown".into();
        return state;
    };
    let status = scm::open_service(&manager, &name, SERVICE_QUERY_STATUS)
        .and_then(|service| scm::query_status(&service));
    match status {
        Ok(status) => {
            state.state = service_state_name(status.state).into();
            state.pid = (status.pid != 0).then_some(status.pid);
            state.accepts_stop = status.controls_accepted & SERVICE_ACCEPT_STOP != 0;
        }
        Err(ERROR_SERVICE_DOES_NOT_EXIST) => return state,
        // It exists, but will not say how it is.
        Err(_) => state.state = "unknown".into(),
    }
    let granted = |access: u32| scm::open_service(&manager, &name, access).is_ok();
    state.can_start = granted(SERVICE_START);
    state.can_stop = granted(SERVICE_STOP);
    state.disabled = scm::open_service(&manager, &name, SERVICE_QUERY_CONFIG)
        .and_then(|handle| scm::query_config(&handle))
        .is_ok_and(|config| config.start_type == SERVICE_DISABLED);
    state.running_dependents = scm::open_service(&manager, &name, SERVICE_ENUMERATE_DEPENDENTS)
        .and_then(|service| scm::dependents(&service, SERVICE_ACTIVE))
        .ok()
        .map(|dependents| {
            dependents
                .into_iter()
                .map(|dependent| JsServiceName {
                    name: dependent.name,
                    display_name: dependent.display_name,
                })
                .collect()
        });
    state
}

/// Start a service and wait to see it running.
fn start_now(name: &str) -> JsServiceOutcome {
    let service = match open(name, SERVICE_START | SERVICE_QUERY_STATUS) {
        Ok(service) => service,
        Err(error) => return JsServiceOutcome::from_error(error),
    };
    let status = match scm::query_status(&service) {
        Ok(status) => status,
        Err(error) => return JsServiceOutcome::from_error(error),
    };
    if status.state == SERVICE_RUNNING {
        return JsServiceOutcome::plain("done", None).with_state(Some(status));
    }
    // One that is still stopping has to finish first.
    if status.state == SERVICE_STOP_PENDING {
        match scm::wait_while(&service, SERVICE_STOP_PENDING, WAIT) {
            Ok(status) if status.state == SERVICE_STOP_PENDING => {
                return JsServiceOutcome::plain("timedOut", None).with_state(Some(status));
            }
            Ok(_) => {}
            Err(error) => return JsServiceOutcome::from_error(error),
        }
    }
    match scm::start(&service) {
        Ok(()) | Err(ERROR_SERVICE_ALREADY_RUNNING) => {}
        Err(error) => return JsServiceOutcome::from_error(error),
    }
    match scm::wait_while(&service, SERVICE_START_PENDING, WAIT) {
        Ok(status) if status.state == SERVICE_RUNNING => {
            JsServiceOutcome::plain("done", None).with_state(Some(status))
        }
        Ok(status) if status.state == SERVICE_START_PENDING => {
            JsServiceOutcome::plain("timedOut", None).with_state(Some(status))
        }
        // It started and stopped again: the exit code says why.
        Ok(status) => JsServiceOutcome::plain(
            "stoppedWithError",
            (status.win32_exit_code != 0).then_some(status.win32_exit_code),
        )
        .with_state(Some(status)),
        Err(error) => JsServiceOutcome::from_error(error),
    }
}

/// Stop a service and wait to see it stopped. Running dependents are stopped
/// first when `with_dependents`; otherwise their presence stops everything.
fn stop_now(name: &str, with_dependents: bool) -> JsServiceOutcome {
    let service = match open(
        name,
        SERVICE_STOP | SERVICE_QUERY_STATUS | SERVICE_ENUMERATE_DEPENDENTS,
    ) {
        Ok(service) => service,
        Err(error) => return JsServiceOutcome::from_error(error),
    };
    let status = match scm::query_status(&service) {
        Ok(status) => status,
        Err(error) => return JsServiceOutcome::from_error(error),
    };
    if status.state == SERVICE_STOPPED {
        return JsServiceOutcome::plain("done", None).with_state(Some(status));
    }
    if status.state == SERVICE_STOP_PENDING {
        return finish_stopping(&service, Vec::new());
    }

    let dependents = match scm::dependents(&service, SERVICE_ACTIVE) {
        Ok(dependents) => dependents,
        Err(error) => return JsServiceOutcome::from_error(error),
    };
    if !dependents.is_empty() && !with_dependents {
        return JsServiceOutcome::plain("dependentsRunning", None).with_state(Some(status));
    }
    let mut stopped = Vec::new();
    for dependent in &dependents {
        let outcome = stop_one(&dependent.name);
        if outcome.outcome != "done" {
            // Say which one held things up, and leave the rest running.
            let mut outcome = outcome;
            outcome.stopped_dependents = stopped;
            return outcome;
        }
        stopped.push(dependent.display_name.clone());
    }

    match scm::request_stop(&service) {
        Ok(()) => finish_stopping(&service, stopped),
        // It stopped by itself in the meantime.
        Err(ERROR_SERVICE_NOT_ACTIVE) => {
            let mut outcome = JsServiceOutcome::plain("done", None);
            outcome.stopped_dependents = stopped;
            outcome.with_state(scm::query_status(&service).ok())
        }
        Err(error) => {
            let mut outcome = JsServiceOutcome::from_error(error);
            outcome.stopped_dependents = stopped;
            outcome.with_state(scm::query_status(&service).ok())
        }
    }
}

/// Stop one dependent, with no dependents of its own left running: Windows
/// lists every dependent, so those were stopped before it.
fn stop_one(name: &str) -> JsServiceOutcome {
    let service = match open(name, SERVICE_STOP | SERVICE_QUERY_STATUS) {
        Ok(service) => service,
        Err(error) => return JsServiceOutcome::from_error(error),
    };
    match scm::request_stop(&service) {
        Ok(()) => finish_stopping(&service, Vec::new()),
        Err(ERROR_SERVICE_NOT_ACTIVE) => JsServiceOutcome::plain("done", None),
        Err(error) => JsServiceOutcome::from_error(error),
    }
}

fn finish_stopping(service: &ScHandle, stopped: Vec<String>) -> JsServiceOutcome {
    let mut outcome = match scm::wait_while(service, SERVICE_STOP_PENDING, WAIT) {
        Ok(status) if status.state == SERVICE_STOPPED => {
            JsServiceOutcome::plain("done", None).with_state(Some(status))
        }
        Ok(status) => JsServiceOutcome::plain("timedOut", None).with_state(Some(status)),
        Err(error) => JsServiceOutcome::from_error(error),
    };
    outcome.stopped_dependents = stopped;
    outcome
}

/// Stop a service, start it again, and then start the dependents it took
/// down, in their start order. As for stopping, running dependents are only
/// stopped when `with_dependents`.
fn restart_now(name: &str, with_dependents: bool) -> JsServiceOutcome {
    // Which dependents were running, by key name, before they are stopped.
    let dependents: Vec<_> = open(name, SERVICE_ENUMERATE_DEPENDENTS)
        .and_then(|service| scm::dependents(&service, SERVICE_ACTIVE))
        .unwrap_or_default();
    let stopped = stop_now(name, with_dependents);
    if stopped.outcome != "done" {
        return stopped;
    }
    let mut started = start_now(name);
    started.stopped_dependents = stopped.stopped_dependents;
    if started.outcome != "done" {
        return started;
    }
    // Stopped in the order listed, so started in the reverse.
    for dependent in dependents.iter().rev() {
        if start_now(&dependent.name).outcome != "done" {
            started.not_restarted.push(dependent.display_name.clone());
        }
    }
    started
}

pub struct StartService {
    name: String,
}

impl Task for StartService {
    type Output = JsServiceOutcome;
    type JsValue = JsServiceOutcome;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(start_now(&self.name))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Start a service, and wait up to 30 seconds to see it running. Runs off the
/// JavaScript thread.
#[napi(ts_return_type = "Promise<JsServiceOutcome>")]
pub fn start_service(name: String) -> AsyncTask<StartService> {
    AsyncTask::new(StartService { name })
}

pub struct StopService {
    name: String,
    with_dependents: bool,
}

impl Task for StopService {
    type Output = JsServiceOutcome;
    type JsValue = JsServiceOutcome;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(stop_now(&self.name, self.with_dependents))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Stop a service, and wait up to 30 seconds to see it stopped. Its running
/// dependents are stopped first only when `with_dependents`; otherwise, with
/// any running, nothing is stopped and the outcome is `dependentsRunning`.
#[napi(ts_return_type = "Promise<JsServiceOutcome>")]
pub fn stop_service(name: String, with_dependents: bool) -> AsyncTask<StopService> {
    AsyncTask::new(StopService {
        name,
        with_dependents,
    })
}

pub struct RestartService {
    name: String,
    with_dependents: bool,
}

impl Task for RestartService {
    type Output = JsServiceOutcome;
    type JsValue = JsServiceOutcome;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(restart_now(&self.name, self.with_dependents))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        Ok(output)
    }
}

/// Stop a service, start it again, then start again the dependents stopped
/// with it. Running dependents are stopped only when `with_dependents`;
/// otherwise, with any running, nothing is stopped and the outcome is
/// `dependentsRunning`.
#[napi(ts_return_type = "Promise<JsServiceOutcome>")]
pub fn restart_service(name: String, with_dependents: bool) -> AsyncTask<RestartService> {
    AsyncTask::new(RestartService {
        name,
        with_dependents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspects_a_service_without_changing_it() {
        let before = scm::enumerate().expect("enumerate");
        // The RPC service runs on every Windows installation and never
        // accepts being stopped.
        let rpc = inspect_service("RpcSs".into());
        assert_eq!(rpc.state, "running");
        assert!(rpc.pid.is_some());
        assert!(!rpc.accepts_stop);
        // The Network Store Interface service lets anyone list its running
        // dependents, and there are always some: DHCP and DNS among them.
        let nsi = inspect_service("nsi".into());
        assert_eq!(nsi.state, "running");
        assert!(nsi
            .running_dependents
            .is_some_and(|dependents| !dependents.is_empty()));
        let after = scm::enumerate().expect("enumerate");
        let running = |list: &[scm::ServiceEntry]| {
            list.iter()
                .filter(|service| service.state == SERVICE_RUNNING)
                .count()
        };
        // Nothing was started or stopped by looking; allow for the rest of
        // the machine going about its business in between.
        assert!(running(&before).abs_diff(running(&after)) < 10);
    }

    #[test]
    fn says_when_a_service_does_not_exist() {
        let name = "TaskManagerNoSuchService".to_string();
        assert_eq!(inspect_service(name.clone()).state, "notFound");
        assert_eq!(start_now(&name).outcome, "notFound");
        assert_eq!(stop_now(&name, false).outcome, "notFound");
    }

    #[test]
    fn refusals_are_named_from_the_windows_error() {
        assert_eq!(
            JsServiceOutcome::from_error(ERROR_ACCESS_DENIED).outcome,
            "accessDenied"
        );
        assert_eq!(
            JsServiceOutcome::from_error(ERROR_SERVICE_DISABLED).outcome,
            "disabled"
        );
        assert_eq!(
            JsServiceOutcome::from_error(ERROR_SERVICE_CANNOT_ACCEPT_CTRL).outcome,
            "cannotStop"
        );
        let failed = JsServiceOutcome::from_error(1234);
        assert_eq!(failed.outcome, "failed");
        assert_eq!(failed.win32_error, Some(1234));
    }
}
