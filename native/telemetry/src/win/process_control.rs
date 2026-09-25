//! Acting on a process: the kernel calls behind End task and the other commands
//! in the process menu.
//!
//! # Identity
//!
//! Windows reuses PIDs, so a process is named here by its PID *and* its
//! creation time, and every action opens the process and compares the creation
//! time before doing anything else. Once the handle is open the check cannot go
//! stale: a handle keeps the process object alive, and Windows does not hand a
//! PID to a new process while the old process object still exists. Without the
//! check, ending a process that exited a moment ago could end whichever
//! unrelated program Windows had given its PID to since.
//!
//! The creation time compared is the one `NtQuerySystemInformation` reports and
//! the snapshots carry in every process key. `GetProcessTimes` reads the same
//! kernel field, which a test below confirms against a live process.

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ACCESS_DENIED, FILETIME, HANDLE, STILL_ACTIVE, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetPriorityClass, GetProcessAffinityMask, GetProcessInformation,
    GetProcessTimes, IsProcessCritical, OpenProcess, ProcessPowerThrottling, SetPriorityClass,
    SetProcessAffinityMask, SetProcessInformation, TerminateProcess, WaitForSingleObject,
    PROCESS_ACCESS_RIGHTS, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
    PROCESS_POWER_THROTTLING_STATE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION,
    PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};

/// Access to end a process and then wait to see that it did end.
pub const ACCESS_END: PROCESS_ACCESS_RIGHTS = PROCESS_TERMINATE | PROCESS_SYNCHRONIZE;
/// Access to change priority, efficiency mode and affinity.
pub const ACCESS_ADJUST: PROCESS_ACCESS_RIGHTS = PROCESS_SET_INFORMATION;
/// Nothing beyond the query access every open includes.
pub const ACCESS_QUERY: PROCESS_ACCESS_RIGHTS = 0;

/// The exit code a process ended this way reports. Windows Task Manager's own
/// choice is not documented; 1 is the conventional "did not finish normally".
const TERMINATED_EXIT_CODE: u32 = 1;

/// Why an action could not reach the process the caller meant.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// No process has this PID any more, or the one that has it already exited.
    NotRunning,
    /// The PID now belongs to a different process than the one the caller saw.
    IdentityChanged,
    /// The process is there, and Windows will not grant the access asked for.
    AccessDenied,
}

/// A process, opened with its identity confirmed.
pub struct Process {
    handle: HANDLE,
}

impl Drop for Process {
    fn drop(&mut self) {
        // SAFETY: we own this handle and close it exactly once.
        unsafe { CloseHandle(self.handle) };
    }
}

impl Process {
    /// Open `pid` for `access`, provided it is still the process created at
    /// `create_time_100ns`.
    pub fn open(
        pid: u32,
        create_time_100ns: i64,
        access: PROCESS_ACCESS_RIGHTS,
    ) -> Result<Self, Refusal> {
        // SAFETY: OpenProcess returns null on failure and a handle we own on
        // success. Query access is always included, because the identity check
        // below needs it.
        let handle = unsafe { OpenProcess(access | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            // SAFETY: reading the calling thread's last error code.
            let error = unsafe { GetLastError() };
            if error != ERROR_ACCESS_DENIED {
                return Err(Refusal::NotRunning);
            }
            // Refused - but by which process? A recycled PID now belonging to
            // something privileged must not be reported as the original
            // process refusing, so look again with the least access there is.
            return Err(match creation_time_of(pid) {
                Some(found) if found != create_time_100ns => Refusal::IdentityChanged,
                _ => Refusal::AccessDenied,
            });
        }

        let process = Self { handle };
        match process.creation_time() {
            Some(found) if found == create_time_100ns => {}
            Some(_) => return Err(Refusal::IdentityChanged),
            None => return Err(Refusal::NotRunning),
        }
        if process.has_exited() {
            return Err(Refusal::NotRunning);
        }
        Ok(process)
    }

    fn creation_time(&self) -> Option<i64> {
        creation_time(self.handle)
    }

    /// Whether the process has finished running.
    ///
    /// Read from the exit code, which is `STILL_ACTIVE` while it runs. A process
    /// that deliberately exits with that same value (259) would read as running;
    /// Windows documents the ambiguity, and nothing here depends on the answer
    /// for more than a message.
    pub fn has_exited(&self) -> bool {
        let mut code = 0u32;
        // SAFETY: `code` is a valid out-pointer; the handle has query access.
        let ok = unsafe { GetExitCodeProcess(self.handle, &mut code) };
        ok != 0 && code != STILL_ACTIVE as u32
    }

    /// Whether Windows marks this process as critical: ending one stops the
    /// whole system with a bug check. `None` when that cannot be read.
    pub fn is_critical(&self) -> Option<bool> {
        let mut critical = 0;
        // SAFETY: `critical` is a valid out-pointer; the handle has query access.
        let ok = unsafe { IsProcessCritical(self.handle, &mut critical) };
        (ok != 0).then_some(critical != 0)
    }

    /// End the process. On failure, the Windows error code.
    ///
    /// Needs `ACCESS_END`. Ending is asynchronous: this returns once Windows has
    /// started tearing the process down, which is why `wait_for_exit` exists.
    pub fn terminate(&self) -> Result<(), u32> {
        // SAFETY: the handle was opened with PROCESS_TERMINATE.
        if unsafe { TerminateProcess(self.handle, TERMINATED_EXIT_CODE) } != 0 {
            Ok(())
        } else {
            // SAFETY: reading the calling thread's last error code.
            Err(unsafe { GetLastError() })
        }
    }

    /// Wait up to `timeout_ms` for the process to finish. True when it did.
    ///
    /// Needs `ACCESS_END`, which includes the synchronise right waiting takes.
    pub fn wait_for_exit(&self, timeout_ms: u32) -> bool {
        // SAFETY: the handle was opened with PROCESS_SYNCHRONIZE.
        unsafe { WaitForSingleObject(self.handle, timeout_ms) == WAIT_OBJECT_0 }
    }

    /// The priority class, or `None` when it cannot be read.
    pub fn priority_class(&self) -> Option<u32> {
        // SAFETY: the handle has query access; zero means failure.
        let class = unsafe { GetPriorityClass(self.handle) };
        (class != 0).then_some(class)
    }

    /// Set the priority class. On failure, the Windows error code.
    ///
    /// Needs `ACCESS_ADJUST`. Windows may apply a different class than the one
    /// asked for - realtime without the privilege to set it becomes high - so
    /// callers read `priority_class` back rather than assuming.
    pub fn set_priority_class(&self, class: u32) -> Result<(), u32> {
        // SAFETY: the handle was opened with PROCESS_SET_INFORMATION.
        if unsafe { SetPriorityClass(self.handle, class) } != 0 {
            Ok(())
        } else {
            // SAFETY: reading the calling thread's last error code.
            Err(unsafe { GetLastError() })
        }
    }

    /// The process's power throttling state as `(control, state)` masks, or
    /// `None` when Windows will not say.
    ///
    /// A mechanism appears in `control` only when someone has set it
    /// explicitly; everything else is left to Windows' own heuristics.
    pub fn power_throttling(&self) -> Option<(u32, u32)> {
        let mut throttling = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: 0,
            StateMask: 0,
        };
        // SAFETY: the structure is the size passed, and `Version` is set as the
        // documentation requires; the handle has query access.
        let ok = unsafe {
            GetProcessInformation(
                self.handle,
                ProcessPowerThrottling,
                (&mut throttling as *mut PROCESS_POWER_THROTTLING_STATE).cast(),
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            )
        };
        (ok != 0).then_some((throttling.ControlMask, throttling.StateMask))
    }

    /// Set the power throttling masks. `(0, 0)` hands the decision back to
    /// Windows. Needs `ACCESS_ADJUST`.
    pub fn set_power_throttling(&self, control: u32, state: u32) -> Result<(), u32> {
        let throttling = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: control,
            StateMask: state,
        };
        // SAFETY: the structure is the size passed; the handle was opened with
        // PROCESS_SET_INFORMATION.
        let ok = unsafe {
            SetProcessInformation(
                self.handle,
                ProcessPowerThrottling,
                (&throttling as *const PROCESS_POWER_THROTTLING_STATE).cast(),
                std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            )
        };
        if ok != 0 {
            Ok(())
        } else {
            // SAFETY: reading the calling thread's last error code.
            Err(unsafe { GetLastError() })
        }
    }

    /// The processors this process may run on, and the ones the system has, as
    /// bit masks over the process's processor group.
    pub fn affinity(&self) -> Option<(usize, usize)> {
        let (mut process, mut system) = (0usize, 0usize);
        // SAFETY: two valid out-pointers; the handle has query access.
        let ok = unsafe { GetProcessAffinityMask(self.handle, &mut process, &mut system) };
        (ok != 0).then_some((process, system))
    }

    /// Restrict the process to the processors in `mask`. Needs `ACCESS_ADJUST`.
    pub fn set_affinity(&self, mask: usize) -> Result<(), u32> {
        // SAFETY: the handle was opened with PROCESS_SET_INFORMATION.
        if unsafe { SetProcessAffinityMask(self.handle, mask) } != 0 {
            Ok(())
        } else {
            // SAFETY: reading the calling thread's last error code.
            Err(unsafe { GetLastError() })
        }
    }
}

/// Open whichever process has `pid` right now.
///
/// Only for a PID read from Windows a moment ago, such as the owner of the
/// taskbar window: the identity check then compares against the creation time
/// read here, which can only fail if the process was replaced in between.
pub fn open_live(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> Result<Process, Refusal> {
    let created = creation_time_of(pid).ok_or(Refusal::NotRunning)?;
    Process::open(pid, created, access)
}

/// Whether Windows would grant `access` to `pid`, without keeping the handle.
///
/// Used to decide what the process menu offers. The answer can change - a
/// process can exit, or this application can gain privileges - so every
/// action still checks for itself when it runs.
pub fn would_grant(pid: u32, access: PROCESS_ACCESS_RIGHTS) -> bool {
    // SAFETY: OpenProcess returns null on failure and a handle we own on success,
    // which is closed straight away.
    let handle = unsafe { OpenProcess(access, 0, pid) };
    if handle.is_null() {
        return false;
    }
    // SAFETY: we own this handle and close it exactly once.
    unsafe { CloseHandle(handle) };
    true
}

/// Creation time of `pid`, through a query-only handle, or `None` when even
/// that is refused or no such process exists.
fn creation_time_of(pid: u32) -> Option<i64> {
    // SAFETY: as above; the handle is closed before returning.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let time = creation_time(handle);
    // SAFETY: we own this handle and close it exactly once.
    unsafe { CloseHandle(handle) };
    time
}

fn creation_time(handle: HANDLE) -> Option<i64> {
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: four valid out-pointers; the handle has query access.
    let ok = unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    (ok != 0).then(|| filetime_to_i64(created))
}

fn filetime_to_i64(time: FILETIME) -> i64 {
    ((u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::win::ntdll::{self, ProcessListIter};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    /// `CREATE_NO_WINDOW`, so a test's helper process never flashes a console.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    /// The creation time the snapshots would put in this process's key.
    fn snapshot_creation_time(pid: u32) -> i64 {
        let mut buffer = Vec::new();
        ntdll::query_process_list_into(&mut buffer).expect("process list");
        ProcessListIter::new(&buffer)
            .find(|entry| entry.info.unique_process_id as u32 == pid)
            .map(|entry| entry.info.create_time)
            .expect("the process is in the list")
    }

    /// A harmless process to act on: it waits for about a minute and exits.
    fn helper() -> std::process::Child {
        Command::new("ping")
            .args(["-n", "60", "127.0.0.1"])
            .stdout(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("ping starts")
    }

    #[test]
    fn the_snapshot_creation_time_is_the_one_windows_checks_against() {
        // The whole identity scheme rests on these being the same kernel value.
        let pid = std::process::id();
        let process = Process::open(pid, snapshot_creation_time(pid), ACCESS_QUERY);
        assert!(
            process.is_ok(),
            "own process must verify: {:?}",
            process.err()
        );
    }

    #[test]
    fn refuses_a_process_whose_creation_time_does_not_match() {
        let pid = std::process::id();
        let wrong = snapshot_creation_time(pid) + 1;
        assert_eq!(
            Process::open(pid, wrong, ACCESS_QUERY).err(),
            Some(Refusal::IdentityChanged)
        );
    }

    #[test]
    fn ends_a_process_and_sees_it_go() {
        let mut child = helper();
        let pid = child.id();
        let process = Process::open(pid, snapshot_creation_time(pid), ACCESS_END).expect("open");
        assert_eq!(process.is_critical(), Some(false));
        assert!(process.terminate().is_ok());
        assert!(process.wait_for_exit(5_000));
        let status = child.wait().expect("wait");
        assert_eq!(status.code(), Some(TERMINATED_EXIT_CODE as i32));
    }

    #[test]
    fn will_not_touch_a_process_through_a_stale_identity() {
        let mut child = helper();
        let pid = child.id();
        let stale = snapshot_creation_time(pid) - 1;
        assert_eq!(
            Process::open(pid, stale, ACCESS_END).err(),
            Some(Refusal::IdentityChanged)
        );
        // Still running: the refusal happened before anything was done.
        assert!(child.try_wait().expect("poll").is_none());
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn reports_a_process_that_already_exited_as_not_running() {
        let mut child = helper();
        let pid = child.id();
        let created = snapshot_creation_time(pid);
        child.kill().expect("kill");
        child.wait().expect("wait");
        // `child` still holds a handle, so the PID cannot have been reused and
        // the exited process object is still there to be found.
        assert_eq!(
            Process::open(pid, created, ACCESS_END).err(),
            Some(Refusal::NotRunning)
        );
    }

    #[test]
    fn reports_a_pid_nobody_has_as_not_running() {
        // PIDs are multiples of four, so this one is never issued.
        assert_eq!(
            Process::open(0xFFFF_FFF1, 0, ACCESS_QUERY).err(),
            Some(Refusal::NotRunning)
        );
    }

    #[test]
    fn turns_efficiency_mode_on_and_hands_it_back_to_windows() {
        use windows_sys::Win32::System::Threading::PROCESS_POWER_THROTTLING_EXECUTION_SPEED as SPEED;
        let mut child = helper();
        let pid = child.id();
        let process = Process::open(pid, snapshot_creation_time(pid), ACCESS_ADJUST).expect("open");
        // A fresh process has nothing set explicitly.
        assert_eq!(process.power_throttling(), Some((0, 0)));
        process.set_power_throttling(SPEED, SPEED).expect("on");
        assert_eq!(process.power_throttling(), Some((SPEED, SPEED)));
        process.set_power_throttling(0, 0).expect("back to Windows");
        assert_eq!(process.power_throttling(), Some((0, 0)));
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn narrows_affinity_and_reads_it_back() {
        let mut child = helper();
        let pid = child.id();
        let process = Process::open(pid, snapshot_creation_time(pid), ACCESS_ADJUST).expect("open");
        let (current, system) = process.affinity().expect("affinity");
        // A fresh process may run anywhere.
        assert_eq!(current, system);
        let lowest = system.isolate_lowest_one();
        process.set_affinity(lowest).expect("narrow");
        assert_eq!(process.affinity().map(|(mask, _)| mask), Some(lowest));
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn reads_and_sets_a_priority_class() {
        use windows_sys::Win32::System::Threading::{
            BELOW_NORMAL_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS,
        };
        let mut child = helper();
        let pid = child.id();
        let process = Process::open(pid, snapshot_creation_time(pid), ACCESS_ADJUST).expect("open");
        assert_eq!(process.priority_class(), Some(NORMAL_PRIORITY_CLASS));
        assert!(process
            .set_priority_class(BELOW_NORMAL_PRIORITY_CLASS)
            .is_ok());
        assert_eq!(process.priority_class(), Some(BELOW_NORMAL_PRIORITY_CLASS));
        child.kill().ok();
        child.wait().ok();
    }
}
