//! Per-process facts that require a handle, resolved once and cached.
//!
//! Image path, command line, owning user, architecture and protection status do
//! not change while a process runs, so paying for them every 500 ms would be
//! waste. They are resolved the first time an identity is seen and kept until
//! the process exits.
//!
//! Two things keep this affordable on a machine with a thousand processes:
//!
//! * a process-wide SID cache, because `LookupAccountSidW` is the expensive part
//!   and nearly every process is owned by one of two or three accounts;
//! * a per-tick resolution budget, so discovering hundreds of processes at once
//!   (application start, or a burst of new processes) cannot overrun the
//!   sampling interval.
//!
//! Every failure mode here is expected, not exceptional: the process may have
//! exited between enumeration and the open, it may be protected, or we may
//! simply lack rights. Each of those results in a cached "we cannot read this"
//! entry so we do not retry uselessly on every sample.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use super::ProcessKey;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ACCESS_DENIED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::{
    GetLengthSid, GetTokenInformation, LookupAccountSidW, TokenUser, PSID, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::System::Threading::{
    IsWow64Process2, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};

/// `IMAGE_FILE_MACHINE_UNKNOWN`: `IsWow64Process2` reports this for the process
/// machine when the process is not running under WOW64.
const IMAGE_FILE_MACHINE_UNKNOWN: u16 = 0;
const IMAGE_FILE_MACHINE_I386: u16 = 0x014c;
const IMAGE_FILE_MACHINE_AMD64: u16 = 0x8664;
const IMAGE_FILE_MACHINE_ARM64: u16 = 0xAA64;
const IMAGE_FILE_MACHINE_ARMNT: u16 = 0x01c4;

/// `ProcessCommandLineInformation`, available since Windows 8.1. Returns a
/// `UNICODE_STRING` followed by its buffer, and needs only
/// `PROCESS_QUERY_LIMITED_INFORMATION` - far cheaper and safer than the
/// traditional approach of reading the PEB out of the target address space.
const PROCESS_COMMAND_LINE_INFORMATION: u32 = 60;
/// `ProcessBasicInformation` with a `PROCESS_EXTENDED_BASIC_INFORMATION` buffer.
const PROCESS_BASIC_INFORMATION: u32 = 0;

/// Upper bound on how many *new* processes get their handle-derived details
/// resolved in a single sampling tick.
///
/// Resolving one process costs a handful of syscalls. On a machine with a
/// thousand processes, doing all of them at once costs roughly 180 ms, which
/// would overrun a 500 ms interval on the very first sample. Spreading the work
/// means a newly discovered process can show its path and owner a tick or two
/// late - invisible in practice, and far better than a stalled sampler. Steady
/// state churn is a few processes per tick, well under the budget.
const DETAIL_RESOLUTIONS_PER_TICK: usize = 96;

#[derive(Debug, Clone, Default)]
pub struct ProcessDetails {
    pub image_path: Option<String>,
    pub command_line: Option<String>,
    pub user_name: Option<String>,
    pub architecture: Option<&'static str>,
    pub is_wow64: Option<bool>,
    pub is_protected: Option<bool>,
    /// `None` on success, otherwise a stable reason code for the UI.
    pub failure: Option<&'static str>,
}

pub struct DetailCache {
    entries: HashMap<ProcessKey, ProcessDetails>,
    /// Whether command lines were requested when an entry was built, so the
    /// entry can be upgraded if the setting is turned on later.
    resolved_with_command_line: HashMap<ProcessKey, bool>,
    /// Resolutions performed in the current tick; reset by `begin_tick`.
    budget_used: usize,
}

impl DetailCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::with_capacity(512),
            resolved_with_command_line: HashMap::with_capacity(512),
            budget_used: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Reset the per-tick resolution budget. Call once per sample.
    pub fn begin_tick(&mut self) {
        self.budget_used = 0;
    }

    /// Resolutions performed during the current tick.
    pub fn budget_used(&self) -> usize {
        self.budget_used
    }

    /// Details for a process, resolving them if this tick still has budget.
    ///
    /// Returns `None` when nothing is cached and the budget is spent; the caller
    /// leaves those fields empty and they fill in on a later tick.
    pub fn get(&mut self, key: ProcessKey, want_command_line: bool) -> Option<&ProcessDetails> {
        let needs_upgrade = want_command_line
            && !self
                .resolved_with_command_line
                .get(&key)
                .copied()
                .unwrap_or(false);
        if !self.entries.contains_key(&key) || needs_upgrade {
            if self.budget_used >= DETAIL_RESOLUTIONS_PER_TICK {
                return self.entries.get(&key);
            }
            self.budget_used += 1;
            let details = resolve(key.pid, want_command_line);
            self.entries.insert(key, details);
            self.resolved_with_command_line
                .insert(key, want_command_line);
        }
        self.entries.get(&key)
    }

    /// Drop entries for identities that are no longer alive.
    pub fn retain_seen(&mut self, live: &HashSet<ProcessKey>) {
        self.entries.retain(|key, _| live.contains(key));
        self.resolved_with_command_line
            .retain(|key, _| live.contains(key));
    }
}

impl Default for DetailCache {
    fn default() -> Self {
        Self::new()
    }
}

/// RAII wrapper so every early return closes the handle.
struct OwnedHandle(HANDLE);

impl OwnedHandle {
    fn open_process(pid: u32) -> Option<Self> {
        // SAFETY: OpenProcess returns null on failure and a handle we own on
        // success. PROCESS_QUERY_LIMITED_INFORMATION is the least privilege that
        // still allows image path, command line and architecture queries.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(Self(handle))
        }
    }

    fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            // SAFETY: we own this handle and close it exactly once.
            unsafe { CloseHandle(self.0) };
        }
    }
}

fn resolve(pid: u32, want_command_line: bool) -> ProcessDetails {
    // PID 0 is the System Idle Process, which is not a real process and cannot
    // be opened. That is normal, not an access failure.
    if pid == 0 {
        return ProcessDetails {
            failure: Some("notSupported"),
            ..Default::default()
        };
    }

    let Some(handle) = OwnedHandle::open_process(pid) else {
        // SAFETY: reading the calling thread's last error code.
        let error = unsafe { GetLastError() };
        return ProcessDetails {
            failure: Some(if error == ERROR_ACCESS_DENIED {
                "accessDenied"
            } else {
                "processExited"
            }),
            ..Default::default()
        };
    };

    let (architecture, is_wow64) = read_architecture(handle.raw());
    ProcessDetails {
        image_path: read_image_path(handle.raw()),
        command_line: want_command_line
            .then(|| read_command_line(handle.raw()))
            .flatten(),
        user_name: read_user_name(handle.raw()),
        architecture,
        is_wow64,
        is_protected: read_is_protected(handle.raw()),
        failure: None,
    }
}

fn read_image_path(handle: HANDLE) -> Option<String> {
    // MAX_PATH is not the limit for this API; paths can be longer.
    let mut buffer = vec![0u16; 1024];
    let mut size = buffer.len() as u32;
    // SAFETY: buffer has `size` UTF-16 elements; the API writes at most that
    // many and updates `size` with the length it wrote.
    let ok = unsafe {
        QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buffer.as_mut_ptr(), &mut size)
    };
    if ok == 0 || size == 0 {
        return None;
    }
    buffer.truncate(size as usize);
    Some(String::from_utf16_lossy(&buffer))
}

fn read_architecture(handle: HANDLE) -> (Option<&'static str>, Option<bool>) {
    let mut process_machine: u16 = 0;
    let mut native_machine: u16 = 0;
    // SAFETY: two out-parameters pointing at local storage.
    let ok = unsafe { IsWow64Process2(handle, &mut process_machine, &mut native_machine) };
    if ok == 0 {
        return (None, None);
    }
    let is_wow64 = process_machine != IMAGE_FILE_MACHINE_UNKNOWN;
    // When not under WOW64 the process runs as the native machine type.
    let effective = if is_wow64 {
        process_machine
    } else {
        native_machine
    };
    let name = match effective {
        IMAGE_FILE_MACHINE_AMD64 => Some("x64"),
        IMAGE_FILE_MACHINE_I386 => Some("x86"),
        IMAGE_FILE_MACHINE_ARM64 => Some("arm64"),
        IMAGE_FILE_MACHINE_ARMNT => Some("arm"),
        _ => None,
    };
    (name, Some(is_wow64))
}

/// Cache of SID bytes to the resolved `DOMAIN\User` string.
///
/// Process-wide, because the mapping is a property of the machine rather than of
/// any one collector. `LookupAccountSidW` can consult the LSA and, on a domain
/// machine, the network; calling it once per process would dominate the cost of
/// a sample.
static SID_NAMES: Mutex<Option<HashMap<Vec<u8>, Option<String>>>> = Mutex::new(None);

fn lookup_account_name_cached(sid: PSID, sid_length: u32) -> Option<String> {
    // SAFETY: `sid` points at `sid_length` readable bytes inside the token
    // information buffer, which the caller still owns.
    let sid_bytes = unsafe { std::slice::from_raw_parts(sid as *const u8, sid_length as usize) };

    if let Ok(mut guard) = SID_NAMES.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        if let Some(cached) = cache.get(sid_bytes) {
            return cached.clone();
        }
    }

    let mut name = vec![0u16; 256];
    let mut name_len = name.len() as u32;
    let mut domain = vec![0u16; 256];
    let mut domain_len = domain.len() as u32;
    let mut sid_type = 0i32;
    // SAFETY: both output buffers are sized by the lengths we pass, and the SID
    // stays valid for the duration of the call.
    let ok = unsafe {
        LookupAccountSidW(
            std::ptr::null(),
            sid,
            name.as_mut_ptr(),
            &mut name_len,
            domain.as_mut_ptr(),
            &mut domain_len,
            &mut sid_type,
        )
    };
    let resolved = if ok == 0 {
        None
    } else {
        let account = String::from_utf16_lossy(&name[..name_len as usize]);
        let domain_name = String::from_utf16_lossy(&domain[..domain_len as usize]);
        Some(if domain_name.is_empty() {
            account
        } else {
            format!("{domain_name}\\{account}")
        })
    };

    if let Ok(mut guard) = SID_NAMES.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        cache.insert(sid_bytes.to_vec(), resolved.clone());
    }
    resolved
}

fn read_user_name(handle: HANDLE) -> Option<String> {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `token` receives a handle we own on success.
    if unsafe { OpenProcessToken(handle, TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    let token = OwnedHandle(token);

    let mut needed: u32 = 0;
    // SAFETY: a null buffer with zero length asks for the required size.
    unsafe { GetTokenInformation(token.raw(), TokenUser, std::ptr::null_mut(), 0, &mut needed) };
    if needed == 0 || needed > 4096 {
        return None;
    }
    let mut buffer = vec![0u8; needed as usize];
    // SAFETY: buffer is `needed` bytes, which is what the API just asked for.
    let ok = unsafe {
        GetTokenInformation(
            token.raw(),
            TokenUser,
            buffer.as_mut_ptr() as *mut _,
            needed,
            &mut needed,
        )
    };
    if ok == 0 {
        return None;
    }
    // SAFETY: on success the buffer starts with a TOKEN_USER whose Sid points
    // inside the same allocation.
    let token_user = unsafe { &*(buffer.as_ptr() as *const TOKEN_USER) };
    let sid = token_user.User.Sid;
    if sid.is_null() {
        return None;
    }
    // SAFETY: `sid` is a well-formed SID produced by the token query.
    let sid_length = unsafe { GetLengthSid(sid) };
    if sid_length == 0 {
        return None;
    }
    lookup_account_name_cached(sid, sid_length)
}

fn read_command_line(handle: HANDLE) -> Option<String> {
    let query = crate::win::ntdll::query_information_process()?;
    // The buffer holds a UNICODE_STRING header followed by the characters.
    let mut length: u32 = 0;
    // SAFETY: a null buffer asks for the required size; the call returns
    // STATUS_INFO_LENGTH_MISMATCH and writes the size.
    unsafe {
        query(
            handle,
            PROCESS_COMMAND_LINE_INFORMATION,
            std::ptr::null_mut(),
            0,
            &mut length,
        )
    };
    if length == 0 || length > 64 * 1024 {
        return None;
    }
    let mut buffer = vec![0u8; length as usize];
    // SAFETY: buffer is `length` bytes and we pass that exact length.
    let status = unsafe {
        query(
            handle,
            PROCESS_COMMAND_LINE_INFORMATION,
            buffer.as_mut_ptr() as *mut _,
            length,
            &mut length,
        )
    };
    if status != 0 {
        return None;
    }
    // SAFETY: on success the buffer begins with a UNICODE_STRING whose Buffer
    // points inside the same allocation, which is alive for this expression.
    unsafe {
        let unicode = &*(buffer.as_ptr() as *const windows_sys::Win32::Foundation::UNICODE_STRING);
        crate::win::ntdll::unicode_string_to_string(unicode)
    }
}

fn read_is_protected(handle: HANDLE) -> Option<bool> {
    let query = crate::win::ntdll::query_information_process()?;
    // PROCESS_EXTENDED_BASIC_INFORMATION on x64: SIZE_T Size, then a 48-byte
    // PROCESS_BASIC_INFORMATION, then a ULONG flags bitfield.
    const EXTENDED_SIZE: usize = 64;
    const FLAGS_OFFSET: usize = 56;
    let mut buffer = [0u8; EXTENDED_SIZE];
    buffer[0..8].copy_from_slice(&(EXTENDED_SIZE as u64).to_le_bytes());
    let mut length: u32 = 0;
    // SAFETY: buffer is EXTENDED_SIZE bytes and we pass that exact length; the
    // Size field is set as the API requires to select the extended form.
    let status = unsafe {
        query(
            handle,
            PROCESS_BASIC_INFORMATION,
            buffer.as_mut_ptr() as *mut _,
            EXTENDED_SIZE as u32,
            &mut length,
        )
    };
    if status != 0 || (length as usize) < EXTENDED_SIZE {
        return None;
    }
    let flags = u32::from_le_bytes([
        buffer[FLAGS_OFFSET],
        buffer[FLAGS_OFFSET + 1],
        buffer[FLAGS_OFFSET + 2],
        buffer[FLAGS_OFFSET + 3],
    ]);
    // Bit 0 is IsProtectedProcess.
    Some(flags & 1 != 0)
}
