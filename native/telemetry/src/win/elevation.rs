//! Running as administrator: starting a copy of this application through the
//! elevation prompt, and the one privilege that makes being administrator
//! worth it to a task manager.

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_CANCELLED, ERROR_SUCCESS, HANDLE, LUID,
};
use windows_sys::Win32::Security::{
    AdjustTokenPrivileges, GetTokenInformation, LookupPrivilegeValueW, TokenPrivileges,
    LUID_AND_ATTRIBUTES, SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_PRIVILEGES, TOKEN_PRIVILEGES,
    TOKEN_QUERY,
};
use windows_sys::Win32::System::Com::{
    CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Shell::{
    ShellExecuteExW, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// What became of a request to start something as administrator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launch {
    /// The user agreed and it is running.
    Started,
    /// The user answered no. Their choice, not a failure.
    Declined,
    /// Windows could not start it; the error code says why.
    Failed(u32),
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

/// Start `file` with `parameters` as administrator, which shows the Windows
/// elevation prompt. Blocks until the user has answered it, so it belongs on
/// a worker thread, never the JavaScript one.
pub fn launch_elevated(file: &str, parameters: &str) -> Launch {
    let verb = wide("runas");
    let file = wide(file);
    let parameters = wide(parameters);

    // ShellExecuteEx can reach shell extensions through COM, so the calling
    // thread needs COM initialised, as the documentation for the function asks.
    // SAFETY: balanced by CoUninitialize below on this same thread.
    let com = unsafe {
        CoInitializeEx(
            std::ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };

    // SAFETY: SHELLEXECUTEINFOW is plain data; zeroed is its documented
    // starting state, and every pointer set below outlives the call.
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    // No error dialogs of the shell's own: the application reports failures
    // itself, with a code. And wait for the launch to finish before returning.
    info.fMask = SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = SW_SHOWNORMAL;

    // SAFETY: `info` is fully initialised for the call.
    let outcome = if unsafe { ShellExecuteExW(&mut info) } != 0 {
        Launch::Started
    } else {
        // SAFETY: reading the calling thread's last error code.
        match unsafe { GetLastError() } {
            ERROR_CANCELLED => Launch::Declined,
            error => Launch::Failed(error),
        }
    };

    if com >= 0 {
        // SAFETY: pairs with the successful CoInitializeEx above.
        unsafe { CoUninitialize() };
    }
    outcome
}

/// The locally unique identifier of SeDebugPrivilege.
fn debug_privilege() -> Option<LUID> {
    let name = wide("SeDebugPrivilege");
    let mut luid = LUID {
        LowPart: 0,
        HighPart: 0,
    };
    // SAFETY: `name` is NUL-terminated; `luid` is a valid out-pointer.
    let ok = unsafe { LookupPrivilegeValueW(std::ptr::null(), name.as_ptr(), &mut luid) };
    (ok != 0).then_some(luid)
}

fn open_own_token(access: u32) -> Option<HANDLE> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: the current-process pseudo handle needs no closing; `token` is a
    // valid out-pointer and is closed by the caller.
    let ok = unsafe { OpenProcessToken(GetCurrentProcess(), access, &mut token) };
    (ok != 0).then_some(token)
}

/// Turn on SeDebugPrivilege for this process. True when it is on afterwards.
///
/// Administrators hold the privilege but have it switched off. Switched on,
/// Windows lets this process open processes running as other accounts,
/// services included, which is what lets a task manager running as
/// administrator show their details and end them. Protected processes still
/// refuse. Only meaningful when running as administrator; otherwise the
/// privilege is not held at all and this returns false.
pub fn enable_debug_privilege() -> bool {
    let Some(luid) = debug_privilege() else {
        return false;
    };
    let Some(token) = open_own_token(TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY) else {
        return false;
    };
    let wanted = TOKEN_PRIVILEGES {
        PrivilegeCount: 1,
        Privileges: [LUID_AND_ATTRIBUTES {
            Luid: luid,
            Attributes: SE_PRIVILEGE_ENABLED,
        }],
    };
    // SAFETY: `token` was opened with TOKEN_ADJUST_PRIVILEGES; `wanted` is a
    // complete one-entry list, and no previous state is asked for.
    let adjusted = unsafe {
        AdjustTokenPrivileges(
            token,
            0,
            &wanted,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    // AdjustTokenPrivileges succeeds even when it assigned nothing, and says
    // so only through the last error.
    // SAFETY: reading the calling thread's last error code.
    let assigned = adjusted != 0 && unsafe { GetLastError() } == ERROR_SUCCESS;
    // SAFETY: we own this token handle and close it exactly once.
    unsafe { CloseHandle(token) };
    assigned && debug_privilege_enabled()
}

/// Whether SeDebugPrivilege is currently enabled for this process.
pub fn debug_privilege_enabled() -> bool {
    let Some(luid) = debug_privilege() else {
        return false;
    };
    let Some(token) = open_own_token(TOKEN_QUERY) else {
        return false;
    };
    let mut needed = 0u32;
    // SAFETY: a size query with no buffer, which fails and reports the size.
    unsafe { GetTokenInformation(token, TokenPrivileges, std::ptr::null_mut(), 0, &mut needed) };
    let mut buffer = vec![0u8; needed as usize];
    // SAFETY: the buffer has the size Windows asked for.
    let ok = needed > 0
        && unsafe {
            GetTokenInformation(
                token,
                TokenPrivileges,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut needed,
            )
        } != 0;
    // SAFETY: we own this token handle and close it exactly once.
    unsafe { CloseHandle(token) };
    if !ok {
        return false;
    }
    // SAFETY: on success the buffer holds a TOKEN_PRIVILEGES header followed
    // by `PrivilegeCount` entries, all inside the size Windows reported.
    // Read unaligned, since a byte buffer carries no alignment guarantee.
    unsafe {
        let header = buffer.as_ptr().cast::<TOKEN_PRIVILEGES>();
        let count = std::ptr::read_unaligned(std::ptr::addr_of!((*header).PrivilegeCount));
        let first = std::ptr::addr_of!((*header).Privileges).cast::<LUID_AND_ATTRIBUTES>();
        (0..count as usize).any(|index| {
            let entry = std::ptr::read_unaligned(first.add(index));
            entry.Luid.LowPart == luid.LowPart
                && entry.Luid.HighPart == luid.HighPart
                && entry.Attributes & SE_PRIVILEGE_ENABLED != 0
        })
    }
}

/// The full path of the executable `pid` is running, or `None` when it cannot
/// be read.
pub fn image_path(pid: u32) -> Option<String> {
    // SAFETY: OpenProcess returns null on failure and a handle we own on
    // success, closed before returning.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut buffer = vec![0u16; 1024];
    let mut size = buffer.len() as u32;
    // SAFETY: the buffer has `size` elements; the call writes at most that many.
    let ok = unsafe {
        QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size)
    };
    // SAFETY: we own this handle and close it exactly once.
    unsafe { CloseHandle(handle) };
    (ok != 0).then(|| String::from_utf16_lossy(&buffer[..size as usize]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_its_own_image_path() {
        let own = image_path(std::process::id()).expect("own path");
        let expected = std::env::current_exe().expect("current exe");
        assert!(own.eq_ignore_ascii_case(&expected.to_string_lossy()));
    }

    #[test]
    fn knows_whether_the_debug_privilege_is_on() {
        // Tests run unelevated, where the privilege is not even held, so it
        // can be neither on nor turned on.
        let elevated = crate::host::host_info().is_elevated;
        if !elevated {
            assert!(!debug_privilege_enabled());
            assert!(!enable_debug_privilege());
        }
    }
}
