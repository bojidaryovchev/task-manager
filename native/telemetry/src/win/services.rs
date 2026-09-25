//! Windows services, as the Service Control Manager reports them.
//!
//! Listing services and the process each runs in needs no administrator rights:
//! `EnumServicesStatusExW` with `SC_ENUM_PROCESS_INFO` gives every service's
//! name, display name, state and process ID in one pass. That is what turns 99
//! identical `svchost.exe` rows into rows that say which services they host.

use windows_sys::Win32::Foundation::{GetLastError, ERROR_MORE_DATA};
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, EnumServicesStatusExW, OpenSCManagerW, ENUM_SERVICE_STATUS_PROCESSW,
    SC_ENUM_PROCESS_INFO, SC_HANDLE, SC_MANAGER_CONNECT, SC_MANAGER_ENUMERATE_SERVICE,
    SERVICE_STATE_ALL, SERVICE_WIN32,
};

/// One service as the Service Control Manager lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceEntry {
    /// The key name, e.g. `Audiosrv`.
    pub name: String,
    /// The name people read, e.g. `Windows Audio`.
    pub display_name: String,
    /// `SERVICE_WIN32_OWN_PROCESS`, `SERVICE_WIN32_SHARE_PROCESS` and so on.
    pub service_type: u32,
    /// `SERVICE_RUNNING`, `SERVICE_STOPPED`, and the states in between.
    pub state: u32,
    /// Which controls the service accepts right now, such as stopping.
    pub controls_accepted: u32,
    /// The process it runs in, or 0 when it is not running.
    pub pid: u32,
}

/// An open handle to the Service Control Manager or a service.
pub struct ScHandle(SC_HANDLE);

impl ScHandle {
    pub fn raw(&self) -> SC_HANDLE {
        self.0
    }
}

impl Drop for ScHandle {
    fn drop(&mut self) {
        // SAFETY: we own this handle and close it exactly once.
        unsafe { CloseServiceHandle(self.0) };
    }
}

/// Connect to the Service Control Manager with `access`. On failure, the
/// Windows error code.
pub fn open_manager(access: u32) -> Result<ScHandle, u32> {
    // SAFETY: null machine and database names mean this machine's active
    // database; the handle returned is ours to close.
    let handle = unsafe { OpenSCManagerW(std::ptr::null(), std::ptr::null(), access) };
    if handle.is_null() {
        // SAFETY: reading the calling thread's last error code.
        Err(unsafe { GetLastError() })
    } else {
        Ok(ScHandle(handle))
    }
}

/// Every Win32 service, running or not. On failure, the Windows error code.
pub fn enumerate() -> Result<Vec<ServiceEntry>, u32> {
    let manager = open_manager(SC_MANAGER_CONNECT | SC_MANAGER_ENUMERATE_SERVICE)?;
    let mut services = Vec::with_capacity(400);
    let mut resume = 0u32;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let mut needed = 0u32;
        let mut returned = 0u32;
        // SAFETY: the buffer is writable for its full length, which is what we
        // pass; the out-pointers are valid; `resume` carries the position
        // between calls as the documentation describes.
        let ok = unsafe {
            EnumServicesStatusExW(
                manager.raw(),
                SC_ENUM_PROCESS_INFO,
                SERVICE_WIN32,
                SERVICE_STATE_ALL,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut needed,
                &mut returned,
                &mut resume,
                std::ptr::null(),
            )
        };
        if ok == 0 {
            // SAFETY: reading the calling thread's last error code.
            let error = unsafe { GetLastError() };
            if error != ERROR_MORE_DATA {
                return Err(error);
            }
        }

        let entries = buffer.as_ptr().cast::<ENUM_SERVICE_STATUS_PROCESSW>();
        for index in 0..returned as usize {
            // SAFETY: Windows wrote `returned` entries at the start of the
            // buffer, with the strings they point to stored after them inside
            // the same buffer, which is alive for this loop.
            let entry = unsafe { std::ptr::read_unaligned(entries.add(index)) };
            // SAFETY: both names point to NUL-terminated strings in `buffer`.
            let (name, display_name) = unsafe {
                (
                    wide_to_string(entry.lpServiceName),
                    wide_to_string(entry.lpDisplayName),
                )
            };
            services.push(ServiceEntry {
                name,
                display_name,
                service_type: entry.ServiceStatusProcess.dwServiceType,
                state: entry.ServiceStatusProcess.dwCurrentState,
                controls_accepted: entry.ServiceStatusProcess.dwControlsAccepted,
                pid: entry.ServiceStatusProcess.dwProcessId,
            });
        }

        if ok != 0 {
            return Ok(services);
        }
        // More to come. Grow the buffer if even one more entry would not fit.
        if needed as usize > buffer.len() {
            buffer.resize(needed as usize, 0);
        }
    }
}

/// Read a NUL-terminated UTF-16 string.
///
/// # Safety
///
/// `text` must be null or point to a readable, NUL-terminated UTF-16 string.
unsafe fn wide_to_string(text: *const u16) -> String {
    if text.is_null() {
        return String::new();
    }
    let mut length = 0usize;
    // SAFETY: the caller guarantees a NUL terminator is reachable.
    while unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    // SAFETY: the `length` elements before the terminator are readable.
    String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::Services::SERVICE_RUNNING;

    #[test]
    fn lists_services_with_their_processes_without_administrator_rights() {
        let services = enumerate().expect("enumerate");
        // Every Windows installation runs dozens of services.
        assert!(services.len() > 50, "{} services", services.len());
        let running: Vec<_> = services
            .iter()
            .filter(|service| service.state == SERVICE_RUNNING)
            .collect();
        assert!(!running.is_empty());
        // A running service lives in a process; a stopped one does not.
        assert!(running.iter().all(|service| service.pid != 0));
        assert!(services
            .iter()
            .filter(|service| service.state != SERVICE_RUNNING && service.pid == 0)
            .all(|service| !service.name.is_empty()));
    }

    #[test]
    fn names_every_service_both_ways() {
        for service in enumerate().expect("enumerate") {
            assert!(!service.name.is_empty());
            assert!(!service.display_name.is_empty(), "{}", service.name);
        }
    }
}
