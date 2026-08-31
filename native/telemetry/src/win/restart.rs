//! Asking Windows to restart this application if it dies.
//!
//! # Why this and not a watchdog
//!
//! A process cannot restart itself after a hard crash: by the time the fault
//! happens there is nothing left running to do it. The usual answer is a second
//! watchdog process, but this application ships as a single executable that
//! installs nothing, and a background watchdog is exactly the kind of thing that
//! turns into a mystery process on someone's machine.
//!
//! Windows already solves this. `RegisterApplicationRestart` tells the Restart
//! Manager to relaunch this process, with a command line we choose, after it
//! crashes or stops responding. Windows Error Reporting does the work, so there
//! is nothing extra running while the application is healthy, and nothing left
//! behind if it is killed.
//!
//! # What it does and does not cover
//!
//! Covered: an unhandled exception that reaches Windows Error Reporting, and a
//! hang the Restart Manager detects. **Not** covered: a clean exit, `TerminateProcess`,
//! or the user closing the application - Windows deliberately does not restart
//! an application that went away on purpose, which is the behaviour anyone would
//! want.
//!
//! Registration is inherited by nothing and lasts for the life of the process.
//! `UnregisterApplicationRestart` is called on a clean shutdown so a deliberate
//! quit is never mistaken for a crash.

use windows_sys::core::{HRESULT, PCWSTR};

/// Do not restart after an application update. A patched application should
/// come back when the user asks, not because it was mid-restart.
const RESTART_NO_PATCH: u32 = 4;
/// Do not restart after a system reboot. Coming back automatically after an
/// unrelated reboot would be surprising; crashing and coming back is not.
const RESTART_NO_REBOOT: u32 = 8;

/// `S_OK`.
const S_OK: HRESULT = 0;

/// Longest command line the Restart Manager accepts, in characters, from
/// `RESTART_MAX_CMD_LINE` in `winbase.h`.
const RESTART_MAX_CMD_LINE: usize = 1024;

#[link(name = "kernel32")]
extern "system" {
    fn RegisterApplicationRestart(pwzcommandline: PCWSTR, dwflags: u32) -> HRESULT;
    fn UnregisterApplicationRestart() -> HRESULT;
}

/// Register for automatic restart after a crash or a hang.
///
/// `command_line` is what the restarted process receives - **not** including the
/// executable path, which Windows supplies. Pass a marker argument so the
/// restarted instance can tell it was restarted rather than launched.
///
/// Returns false when Windows refused the registration, which is not worth
/// treating as an error: the application simply does not come back by itself.
pub fn register_for_restart(command_line: &str) -> bool {
    // Truncating silently would register a command line that is not the one
    // asked for, so an over-long one is refused instead.
    if command_line.len() >= RESTART_MAX_CMD_LINE {
        return false;
    }
    let wide: Vec<u16> = command_line
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 buffer that outlives the call;
    // Windows copies the string. The flags are the documented bit values.
    let status =
        unsafe { RegisterApplicationRestart(wide.as_ptr(), RESTART_NO_PATCH | RESTART_NO_REBOOT) };
    status == S_OK
}

/// Cancel the registration.
///
/// Called on a deliberate shutdown. Without it a clean quit that Windows
/// happened to observe as abnormal - a session ending abruptly, say - could
/// bring the application back when the user had closed it on purpose.
pub fn unregister_for_restart() -> bool {
    // SAFETY: takes no arguments and is safe to call whether or not a
    // registration is currently held.
    let status = unsafe { UnregisterApplicationRestart() };
    status == S_OK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_and_unregisters_against_the_real_api() {
        // Runs against Windows itself: the point is that the declaration matches
        // the real export, which a hand-written extern block cannot prove any
        // other way.
        assert!(register_for_restart("--restarted-by-windows"));
        assert!(unregister_for_restart());
    }

    #[test]
    fn refuses_a_command_line_longer_than_windows_accepts() {
        // Truncating would register something other than what was asked for.
        assert!(!register_for_restart(&"x".repeat(RESTART_MAX_CMD_LINE)));
        assert!(!register_for_restart(
            &"x".repeat(RESTART_MAX_CMD_LINE + 500)
        ));
    }

    #[test]
    fn accepts_an_empty_command_line() {
        // Meaning "restart me with no arguments".
        assert!(register_for_restart(""));
        assert!(unregister_for_restart());
    }
}
