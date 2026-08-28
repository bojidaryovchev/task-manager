//! Static facts about the machine and about our own privileges.
//!
//! Privilege matters for coverage rather than for basic operation: without
//! elevation the collector still reads CPU, memory and the full process list,
//! but a handful of per-process details on other users' and protected processes
//! stay unavailable. The application reports what it cannot see instead of
//! silently showing partial data.

use crate::api::JsHostInfo;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::Security::{
    GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
};
use windows_sys::Win32::System::SystemInformation::{
    GetComputerNameExW, GetSystemInfo, GetTickCount64, SYSTEM_INFO,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

const PROCESSOR_ARCHITECTURE_AMD64: u16 = 9;
const PROCESSOR_ARCHITECTURE_ARM64: u16 = 12;
const PROCESSOR_ARCHITECTURE_INTEL: u16 = 0;

/// `ComputerNameDnsHostname`
const COMPUTER_NAME_DNS_HOSTNAME: i32 = 1;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn computer_name() -> String {
    let mut size: u32 = 0;
    // SAFETY: a null buffer asks for the required length in characters.
    unsafe {
        GetComputerNameExW(COMPUTER_NAME_DNS_HOSTNAME, std::ptr::null_mut(), &mut size);
    }
    if size == 0 || size > 1024 {
        return String::new();
    }
    let mut buffer = vec![0u16; size as usize];
    // SAFETY: buffer holds `size` characters, which is what the API asked for.
    let ok =
        unsafe { GetComputerNameExW(COMPUTER_NAME_DNS_HOSTNAME, buffer.as_mut_ptr(), &mut size) };
    if ok == 0 {
        return String::new();
    }
    buffer.truncate(size as usize);
    String::from_utf16_lossy(&buffer)
}

fn native_architecture() -> String {
    // SAFETY: SYSTEM_INFO is plain data with no invalid bit patterns, and
    // GetSystemInfo overwrites every field before we read any of them.
    let mut info: SYSTEM_INFO = unsafe { std::mem::zeroed() };
    // SAFETY: single out-parameter; GetSystemInfo cannot fail.
    unsafe { GetSystemInfo(&mut info) };
    // SAFETY: reading the union field that carries the architecture.
    let architecture = unsafe { info.Anonymous.Anonymous.wProcessorArchitecture };
    match architecture {
        PROCESSOR_ARCHITECTURE_AMD64 => "x64".to_string(),
        PROCESSOR_ARCHITECTURE_ARM64 => "arm64".to_string(),
        PROCESSOR_ARCHITECTURE_INTEL => "x86".to_string(),
        other => format!("unknown({other})"),
    }
}

fn is_elevated() -> bool {
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: GetCurrentProcess returns a pseudo-handle that needs no closing;
    // `token` receives a real handle we close below.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }
    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut size = std::mem::size_of::<TOKEN_ELEVATION>() as u32;
    // SAFETY: output buffer matches the size we pass.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            &mut elevation as *mut TOKEN_ELEVATION as *mut _,
            size,
            &mut size,
        )
    };
    // SAFETY: closing the token handle we opened above, exactly once.
    unsafe { CloseHandle(token) };
    ok != 0 && elevation.TokenIsElevated != 0
}

/// Read OS name and display build from the registry, where Windows records the
/// marketing name. `GetVersionEx` is subject to compatibility shimming and
/// reports the wrong thing for unmanifested applications, so it is not used.
fn os_details() -> (Option<String>, String, Option<String>) {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };

    const KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

    let read_string = |name: &str| -> Option<String> {
        let subkey = wide(KEY);
        let value_name = wide(name);
        let mut size: u32 = 0;
        // SAFETY: null buffer requests the size.
        unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                subkey.as_ptr(),
                value_name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if size == 0 || size > 4096 {
            return None;
        }
        let mut buffer = vec![0u16; size as usize / 2 + 1];
        let mut size_out = size;
        // SAFETY: buffer holds at least `size` bytes.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                subkey.as_ptr(),
                value_name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr() as *mut _,
                &mut size_out,
            )
        };
        if status != 0 {
            return None;
        }
        let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        let text = String::from_utf16_lossy(&buffer[..end]).trim().to_string();
        (!text.is_empty()).then_some(text)
    };

    let read_dword = |name: &str| -> Option<u32> {
        let subkey = wide(KEY);
        let value_name = wide(name);
        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: output is a u32 and we pass its exact size.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                subkey.as_ptr(),
                value_name.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                &mut data as *mut u32 as *mut _,
                &mut size,
            )
        };
        (status == 0).then_some(data)
    };

    let major = read_dword("CurrentMajorVersionNumber").unwrap_or(0);
    let minor = read_dword("CurrentMinorVersionNumber").unwrap_or(0);
    let build = read_string("CurrentBuildNumber").unwrap_or_default();
    let ubr = read_dword("UBR");

    // Windows 11 reports itself as major version 10 with a build number of
    // 22000 or higher; the ProductName value still says "Windows 10" on many
    // installs, so the name is corrected from the build number.
    let build_number: u32 = build.parse().unwrap_or(0);
    let product_name = read_string("ProductName").map(|name| {
        if build_number >= 22000 {
            name.replace("Windows 10", "Windows 11")
        } else {
            name
        }
    });

    let version = format!("{major}.{minor}.{build}");
    let display_build = ubr.map(|ubr| format!("{build}.{ubr}"));
    (product_name, version, display_build)
}

pub fn host_info() -> JsHostInfo {
    let (os_name, os_version, os_build) = os_details();
    // SAFETY: GetTickCount64 takes no arguments and cannot fail.
    let uptime_ms = unsafe { GetTickCount64() } as f64;
    JsHostInfo {
        computer_name: computer_name(),
        os_name,
        os_version,
        os_build,
        architecture: native_architecture(),
        is_elevated: is_elevated(),
        // SeDebugPrivilege is only obtainable when elevated. We do not enable it
        // yet - nothing collected so far needs it - so this reports the
        // possibility, not an acquired privilege.
        has_debug_privilege: false,
        boot_time_unix_ms: Some(crate::clock::wall_clock_unix_ms() - uptime_ms),
        native_module_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}
