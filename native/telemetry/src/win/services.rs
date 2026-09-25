//! Windows services, as the Service Control Manager reports them.
//!
//! Listing services and the process each runs in needs no administrator rights:
//! `EnumServicesStatusExW` with `SC_ENUM_PROCESS_INFO` gives every service's
//! name, display name, state and process ID in one pass. That is what turns 99
//! identical `svchost.exe` rows into rows that say which services they host.

use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_MORE_DATA};
use windows_sys::Win32::System::Services::{
    CloseServiceHandle, ControlService, EnumDependentServicesW, EnumServicesStatusExW,
    OpenSCManagerW, OpenServiceW, QueryServiceConfig2W, QueryServiceConfigW, QueryServiceStatusEx,
    StartServiceW, ENUM_SERVICE_STATUSW, ENUM_SERVICE_STATUS_PROCESSW, QUERY_SERVICE_CONFIGW,
    SC_ENUM_PROCESS_INFO, SC_HANDLE, SC_MANAGER_CONNECT, SC_MANAGER_ENUMERATE_SERVICE,
    SC_STATUS_PROCESS_INFO, SERVICE_CONFIG_DELAYED_AUTO_START_INFO, SERVICE_CONFIG_DESCRIPTION,
    SERVICE_CONFIG_TRIGGER_INFO, SERVICE_CONTROL_STOP, SERVICE_DELAYED_AUTO_START_INFO,
    SERVICE_DESCRIPTIONW, SERVICE_STATE_ALL, SERVICE_STATUS, SERVICE_STATUS_PROCESS,
    SERVICE_TRIGGER_INFO, SERVICE_WIN32,
};

/// How often a wait for a service to finish starting or stopping looks again.
const POLL: Duration = Duration::from_millis(250);

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

/// A service's configuration, as far as this account may read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceConfig {
    /// `SERVICE_AUTO_START`, `SERVICE_DEMAND_START`, `SERVICE_DISABLED`, and
    /// for drivers the boot and system starts.
    pub start_type: u32,
    /// An automatic service Windows starts shortly after the others.
    pub delayed_auto_start: bool,
    /// Also started or stopped by an event, such as a device arriving.
    pub trigger_start: bool,
    /// What the service runs, e.g. `C:\WINDOWS\system32\svchost.exe -k netsvcs -p`.
    pub binary_path: String,
    /// The account it runs as, e.g. `LocalSystem`.
    pub account: String,
    /// What the service says it does, when it says.
    pub description: Option<String>,
}

/// Open one service with `access`. On failure, the Windows error code:
/// `ERROR_ACCESS_DENIED` when this account may not have that access.
pub fn open_service(manager: &ScHandle, name: &str, access: u32) -> Result<ScHandle, u32> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    // SAFETY: the manager handle is open and `wide` is NUL-terminated and
    // outlives the call; the handle returned is ours to close.
    let handle = unsafe { OpenServiceW(manager.raw(), wide.as_ptr(), access) };
    if handle.is_null() {
        // SAFETY: reading the calling thread's last error code.
        Err(unsafe { GetLastError() })
    } else {
        Ok(ScHandle(handle))
    }
}

/// Read a service's configuration. The handle needs `SERVICE_QUERY_CONFIG`.
pub fn query_config(service: &ScHandle) -> Result<ServiceConfig, u32> {
    let buffer = read_sized(|buffer, size, needed| {
        // SAFETY: `buffer` is writable for `size` bytes (or null with size 0),
        // aligned for the structure, and `needed` is a valid out-pointer.
        unsafe { QueryServiceConfigW(service.raw(), buffer.cast(), size, needed) }
    })?;
    // SAFETY: Windows wrote a QUERY_SERVICE_CONFIGW at the start of the
    // buffer, which is 8-byte aligned, with its strings stored after it.
    let config = unsafe { &*buffer.as_ptr().cast::<QUERY_SERVICE_CONFIGW>() };
    // SAFETY: each string is null or NUL-terminated inside `buffer`.
    let (binary_path, account) = unsafe {
        (
            wide_to_string(config.lpBinaryPathName),
            wide_to_string(config.lpServiceStartName),
        )
    };

    let description = config2(service, SERVICE_CONFIG_DESCRIPTION)
        .ok()
        .and_then(|buffer| {
            // SAFETY: a SERVICE_DESCRIPTIONW at the start of the aligned
            // buffer, its string null or NUL-terminated inside it.
            let text = unsafe {
                wide_to_string((*buffer.as_ptr().cast::<SERVICE_DESCRIPTIONW>()).lpDescription)
            };
            (!text.trim().is_empty()).then_some(text)
        });
    let delayed_auto_start = config2(service, SERVICE_CONFIG_DELAYED_AUTO_START_INFO)
        // SAFETY: a SERVICE_DELAYED_AUTO_START_INFO at the start of the
        // aligned buffer.
        .map(|buffer| unsafe {
            (*buffer.as_ptr().cast::<SERVICE_DELAYED_AUTO_START_INFO>()).fDelayedAutostart != 0
        })
        .unwrap_or(false);
    let trigger_start = config2(service, SERVICE_CONFIG_TRIGGER_INFO)
        // SAFETY: a SERVICE_TRIGGER_INFO at the start of the aligned buffer.
        .map(|buffer| unsafe { (*buffer.as_ptr().cast::<SERVICE_TRIGGER_INFO>()).cTriggers > 0 })
        .unwrap_or(false);

    Ok(ServiceConfig {
        start_type: config.dwStartType,
        delayed_auto_start,
        trigger_start,
        binary_path,
        account,
        description,
    })
}

/// A service's state right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServiceStatus {
    /// `SERVICE_RUNNING`, `SERVICE_STOPPED`, and the states in between.
    pub state: u32,
    /// Which controls it accepts right now, such as stopping.
    pub controls_accepted: u32,
    /// The process it runs in, or 0 when it is not running.
    pub pid: u32,
    /// Why it stopped, when it stopped with an error: a Windows error code,
    /// or `ERROR_SERVICE_SPECIFIC_ERROR` with `service_exit_code` saying more.
    pub win32_exit_code: u32,
    pub service_exit_code: u32,
}

/// Read a service's state. The handle needs `SERVICE_QUERY_STATUS`.
pub fn query_status(service: &ScHandle) -> Result<ServiceStatus, u32> {
    let mut status = SERVICE_STATUS_PROCESS::default();
    let mut needed = 0u32;
    // SAFETY: `status` is a writable SERVICE_STATUS_PROCESS of exactly the
    // size passed, and `needed` is a valid out-pointer.
    let ok = unsafe {
        QueryServiceStatusEx(
            service.raw(),
            SC_STATUS_PROCESS_INFO,
            (&mut status as *mut SERVICE_STATUS_PROCESS).cast(),
            std::mem::size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    Ok(ServiceStatus {
        state: status.dwCurrentState,
        controls_accepted: status.dwControlsAccepted,
        pid: status.dwProcessId,
        win32_exit_code: status.dwWin32ExitCode,
        service_exit_code: status.dwServiceSpecificExitCode,
    })
}

/// Wait while a service stays in the `pending` state, for at most `timeout`,
/// and return the state it was last seen in. The handle needs
/// `SERVICE_QUERY_STATUS`.
pub fn wait_while(
    service: &ScHandle,
    pending: u32,
    timeout: Duration,
) -> Result<ServiceStatus, u32> {
    let deadline = Instant::now() + timeout;
    loop {
        let status = query_status(service)?;
        if status.state != pending || Instant::now() >= deadline {
            return Ok(status);
        }
        std::thread::sleep(POLL);
    }
}

/// Ask Windows to start a service, with no arguments. Returns once it is
/// starting, not once it has started. The handle needs `SERVICE_START`.
pub fn start(service: &ScHandle) -> Result<(), u32> {
    // SAFETY: an open service handle, and no arguments.
    let ok = unsafe { StartServiceW(service.raw(), 0, std::ptr::null()) };
    if ok == 0 {
        Err(last_error())
    } else {
        Ok(())
    }
}

/// Ask a service to stop. Returns once asked, not once it has stopped. The
/// handle needs `SERVICE_STOP`.
pub fn request_stop(service: &ScHandle) -> Result<(), u32> {
    let mut status = SERVICE_STATUS::default();
    // SAFETY: an open service handle, and a writable SERVICE_STATUS.
    let ok = unsafe { ControlService(service.raw(), SERVICE_CONTROL_STOP, &mut status) };
    if ok == 0 {
        Err(last_error())
    } else {
        Ok(())
    }
}

/// A service that depends on another.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependent {
    pub name: String,
    pub display_name: String,
    pub state: u32,
}

/// The services that depend on this one, in `state` (`SERVICE_ACTIVE` for
/// the running ones), in the order they can be stopped: Windows returns them
/// in the reverse of their start order (`EnumDependentServicesW`). The handle
/// needs `SERVICE_ENUMERATE_DEPENDENTS`.
pub fn dependents(service: &ScHandle, state: u32) -> Result<Vec<Dependent>, u32> {
    let mut needed = 0u32;
    let mut returned = 0u32;
    // SAFETY: no buffer and a size of zero, which asks for the size needed;
    // the out-pointers are valid.
    let ok = unsafe {
        EnumDependentServicesW(
            service.raw(),
            state,
            std::ptr::null_mut(),
            0,
            &mut needed,
            &mut returned,
        )
    };
    // Succeeding with no buffer means there are none.
    if ok != 0 {
        return Ok(Vec::new());
    }
    let error = last_error();
    if error != ERROR_MORE_DATA {
        return Err(error);
    }
    let mut buffer = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: the buffer is writable, 8-byte aligned, and as long as passed.
    let ok = unsafe {
        EnumDependentServicesW(
            service.raw(),
            state,
            buffer.as_mut_ptr().cast(),
            (buffer.len() * 8) as u32,
            &mut needed,
            &mut returned,
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    let entries = buffer.as_ptr().cast::<ENUM_SERVICE_STATUSW>();
    Ok((0..returned as usize)
        .map(|index| {
            // SAFETY: Windows wrote `returned` entries at the start of the
            // buffer, with their strings after them inside it.
            let entry = unsafe { &*entries.add(index) };
            // SAFETY: both names are NUL-terminated strings in `buffer`.
            let (name, display_name) = unsafe {
                (
                    wide_to_string(entry.lpServiceName),
                    wide_to_string(entry.lpDisplayName),
                )
            };
            Dependent {
                name,
                display_name,
                state: entry.ServiceStatus.dwCurrentState,
            }
        })
        .collect())
}

/// The calling thread's last Windows error code.
fn last_error() -> u32 {
    // SAFETY: reading the calling thread's last error code.
    unsafe { GetLastError() }
}

/// One `QueryServiceConfig2W` level, in an 8-byte-aligned buffer.
fn config2(service: &ScHandle, level: u32) -> Result<Vec<u64>, u32> {
    read_sized(|buffer, size, needed| {
        // SAFETY: as for `query_config`.
        unsafe { QueryServiceConfig2W(service.raw(), level, buffer.cast(), size, needed) }
    })
}

/// Call a Windows function that fills a buffer and reports the size it
/// needed when the buffer was too small. The first attempt uses a buffer big
/// enough for nearly every service, so a read is usually one round trip to the
/// Service Control Manager rather than two. The buffer is `u64`s so that
/// structures holding pointers are aligned.
fn read_sized(mut call: impl FnMut(*mut u64, u32, *mut u32) -> i32) -> Result<Vec<u64>, u32> {
    let mut buffer = vec![0u64; 512];
    loop {
        let mut needed = 0u32;
        let size = (buffer.len() * 8) as u32;
        if call(buffer.as_mut_ptr(), size, &mut needed) != 0 {
            return Ok(buffer);
        }
        let error = last_error();
        let wanted = (needed as usize).div_ceil(8);
        if error != ERROR_INSUFFICIENT_BUFFER || wanted <= buffer.len() {
            return Err(error);
        }
        buffer.resize(wanted, 0);
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
    #[ignore = "measurement, run by hand"]
    fn measure_config_reads() {
        use windows_sys::Win32::System::Services::{
            SERVICE_QUERY_CONFIG, SERVICE_START, SERVICE_STOP,
        };
        let listed = std::time::Instant::now();
        let services = enumerate().expect("enumerate");
        let list_ms = listed.elapsed().as_secs_f64() * 1000.0;
        let manager = open_manager(SC_MANAGER_CONNECT).expect("manager");
        let started = std::time::Instant::now();
        let mut read = 0;
        let mut refused = Vec::new();
        let mut samples = Vec::new();
        for service in &services {
            match open_service(&manager, &service.name, SERVICE_QUERY_CONFIG)
                .and_then(|handle| query_config(&handle))
            {
                Ok(config) => {
                    read += 1;
                    if samples.len() < 6 && config.binary_path.contains("svchost") {
                        samples.push((service.name.clone(), config));
                    }
                }
                Err(error) => refused.push((service.name.clone(), error)),
            }
        }
        let config_ms = started.elapsed().as_secs_f64() * 1000.0;
        let started = std::time::Instant::now();
        let controllable: Vec<_> = services
            .iter()
            .filter(|service| {
                open_service(&manager, &service.name, SERVICE_START | SERVICE_STOP).is_ok()
            })
            .map(|service| service.name.clone())
            .collect();
        let access_ms = started.elapsed().as_secs_f64() * 1000.0;
        println!("{} services listed in {list_ms:.1} ms", services.len());
        println!(
            "configs: {read} read, {} refused, in {config_ms:.1} ms",
            refused.len()
        );
        println!("refused: {refused:?}");
        println!(
            "start/stop granted for {} in {access_ms:.1} ms: {controllable:?}",
            controllable.len()
        );
        for (name, config) in samples {
            println!("{name}: {config:?}");
        }
    }

    #[test]
    fn names_every_service_both_ways() {
        for service in enumerate().expect("enumerate") {
            assert!(!service.name.is_empty());
            assert!(!service.display_name.is_empty(), "{}", service.name);
        }
    }
}
