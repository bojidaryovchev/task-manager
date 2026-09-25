//! The Windows shell's own dialogs, for the process menu, and starting the
//! shell itself when it is gone.

use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
use windows_sys::Win32::System::SystemInformation::GetWindowsDirectoryW;
use windows_sys::Win32::System::Threading::{CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW};
use windows_sys::Win32::UI::Shell::{SHObjectProperties, SHOP_FILEPATH};

/// Start Explorer. With no shell running, a new Explorer becomes the shell.
/// On failure, the Windows error code.
pub fn start_explorer() -> Result<(), u32> {
    let mut directory = vec![0u16; 260];
    // SAFETY: the buffer has the length passed; the call writes at most that.
    let length = unsafe { GetWindowsDirectoryW(directory.as_mut_ptr(), directory.len() as u32) };
    if length == 0 || length as usize >= directory.len() {
        // SAFETY: reading the calling thread's last error code.
        return Err(unsafe { GetLastError() });
    }
    let path = format!(
        "{}\\explorer.exe",
        String::from_utf16_lossy(&directory[..length as usize])
    );
    // CreateProcessW may write to the command line, so it gets its own buffer.
    let mut command: Vec<u16> = format!("\"{path}\"")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    // SAFETY: both structures are plain data, zeroed as documented, with the
    // size field set; the command buffer is NUL-terminated and writable.
    unsafe {
        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        let mut created: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessW(
            std::ptr::null(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            0,
            std::ptr::null(),
            std::ptr::null(),
            &startup,
            &mut created,
        );
        if ok == 0 {
            return Err(GetLastError());
        }
        CloseHandle(created.hThread);
        CloseHandle(created.hProcess);
    }
    Ok(())
}

/// Show the Properties dialog for a file, the same one Explorer shows.
///
/// Returns false when the shell could not show it, typically because nothing
/// exists at that path any more. The dialog belongs to the shell and runs on
/// its own, so this returns once it has been asked for.
pub fn show_properties(path: &str) -> bool {
    let wide: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call. No owner window
    // and a null page name, which opens the dialog on its first page.
    unsafe {
        SHObjectProperties(
            std::ptr::null_mut(),
            SHOP_FILEPATH as u32,
            wide.as_ptr(),
            std::ptr::null(),
        ) != 0
    }
}
