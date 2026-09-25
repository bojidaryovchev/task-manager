//! A process's windows, and the two things the process menu does with them:
//! asking them to close, and bringing one to the front.
//!
//! # Which windows count
//!
//! The ones on the taskbar, because those are what a person thinks of as a
//! program's windows. Windows documents the rule in "Managing Taskbar Buttons":
//! a visible window with no owner gets a button unless it is a tool window, and
//! a window marked as an app window always gets one. Cloaked windows are left
//! out as well - Windows keeps some programs' windows "visible" but cloaked
//! while they are suspended or parked, and switching to one of those would show
//! nothing - and so are the shell's own surfaces, the taskbar and the desktop,
//! which belong to Explorer and must never be asked to close.

use std::ffi::c_void;

use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowW, GetClassNameW, GetWindow, GetWindowLongPtrW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, PostMessageW, SetForegroundWindow,
    ShowWindow, GWL_EXSTYLE, GW_OWNER, SW_RESTORE, WM_CLOSE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

/// Window classes that are the shell itself rather than a program's window: the
/// taskbar on each monitor, and the desktop.
const SHELL_SURFACES: [&str; 4] = [
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Progman",
    "WorkerW",
];

/// A top-level window handle. Plain data rather than `HWND` so it can cross
/// threads; a window handle is only ever an identifier.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window(isize);

impl Window {
    fn hwnd(self) -> HWND {
        self.0 as HWND
    }
}

/// The taskbar windows `pid` owns, topmost first.
pub fn taskbar_windows(pid: u32) -> Vec<Window> {
    struct Search {
        pid: u32,
        found: Vec<Window>,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the `Search` passed to EnumWindows below, which
        // outlives the enumeration and is touched by nothing else meanwhile.
        let search = unsafe { &mut *(lparam as *mut Search) };
        let mut owner = 0u32;
        // SAFETY: `hwnd` comes from the enumeration; `owner` is a valid out-pointer.
        unsafe { GetWindowThreadProcessId(hwnd, &mut owner) };
        if owner == search.pid && is_taskbar_window(hwnd) {
            search.found.push(Window(hwnd as isize));
        }
        1
    }

    let mut search = Search {
        pid,
        found: Vec::new(),
    };
    // SAFETY: the callback only dereferences `lparam` as the `Search` above,
    // which lives until EnumWindows returns. EnumWindows walks in Z order, so
    // the first window found is the one in front.
    unsafe { EnumWindows(Some(visit), &mut search as *mut Search as LPARAM) };
    search.found
}

fn is_taskbar_window(hwnd: HWND) -> bool {
    // SAFETY: every call below takes a window handle from the enumeration and
    // tolerates one that has just been destroyed.
    unsafe {
        if IsWindowVisible(hwnd) == 0 || is_cloaked(hwnd) || is_shell_surface(hwnd) {
            return false;
        }
        let extended = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        if extended & WS_EX_APPWINDOW != 0 {
            return true;
        }
        GetWindow(hwnd, GW_OWNER).is_null() && extended & WS_EX_TOOLWINDOW == 0
    }
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    // SAFETY: `cloaked` is a u32 of the size passed, which is what DWMWA_CLOAKED
    // writes. Failure (for instance a window that just vanished) reads as not
    // cloaked, and the window is then judged on the other tests alone.
    let result = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            &mut cloaked as *mut u32 as *mut c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };
    result == 0 && cloaked != 0
}

fn is_shell_surface(hwnd: HWND) -> bool {
    let mut buffer = [0u16; 64];
    // SAFETY: the buffer holds the 64 characters we say it does.
    let length = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if length <= 0 {
        return false;
    }
    let class = String::from_utf16_lossy(&buffer[..length as usize]);
    SHELL_SURFACES.contains(&class.as_str())
}

/// Ask a window to close, as its close button would. On failure, the Windows
/// error code - access denied when the window belongs to a process running
/// with higher privileges, which Windows does not let a lower one message.
pub fn request_close(window: Window) -> Result<(), u32> {
    // SAFETY: posting a message to a window handle is safe whatever the handle;
    // a stale one simply fails.
    if unsafe { PostMessageW(window.hwnd(), WM_CLOSE, 0, 0) } != 0 {
        Ok(())
    } else {
        // SAFETY: reading the calling thread's last error code.
        Err(unsafe { GetLastError() })
    }
}

/// Restore a window if it is minimised and bring it to the front. True when
/// Windows made it the foreground window.
///
/// Windows only lets the foreground process move focus, which this application
/// is at the moment someone picks the command from its menu.
pub fn bring_to_front(window: Window) -> bool {
    // SAFETY: both calls take a window handle and tolerate a stale one.
    unsafe {
        if IsIconic(window.hwnd()) != 0 {
            ShowWindow(window.hwnd(), SW_RESTORE);
        }
        SetForegroundWindow(window.hwnd()) != 0
    }
}

/// The process running the Windows shell: the `explorer.exe` that owns the
/// taskbar, as opposed to any Explorer processes showing folders.
pub fn shell_process_id() -> Option<u32> {
    let class: Vec<u16> = "Shell_TrayWnd\0".encode_utf16().collect();
    // SAFETY: `class` is NUL-terminated; a null window name matches any title.
    let taskbar = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
    if taskbar.is_null() {
        return None;
    }
    let mut pid = 0u32;
    // SAFETY: `taskbar` is a window handle; `pid` is a valid out-pointer.
    unsafe { GetWindowThreadProcessId(taskbar, &mut pid) };
    (pid != 0).then_some(pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, PeekMessageW, MSG, PM_REMOVE, WS_OVERLAPPED, WS_VISIBLE,
    };

    /// A real top-level window in this test process, parked far off screen so
    /// it never appears on the desktop.
    struct TestWindow(HWND);

    impl TestWindow {
        fn create(extended_style: u32, owner: HWND) -> Self {
            // A built-in class, so the test needs no window procedure of its own.
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let title: Vec<u16> = "test\0".encode_utf16().collect();
            // SAFETY: the class and title buffers outlive the call.
            let hwnd = unsafe {
                CreateWindowExW(
                    extended_style,
                    class.as_ptr(),
                    title.as_ptr(),
                    WS_OVERLAPPED | WS_VISIBLE,
                    -32000,
                    -32000,
                    40,
                    40,
                    owner,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            };
            assert!(!hwnd.is_null(), "test window created");
            Self(hwnd)
        }

        fn window(&self) -> Window {
            Window(self.0 as isize)
        }
    }

    impl Drop for TestWindow {
        fn drop(&mut self) {
            // SAFETY: destroying a window this thread created.
            unsafe { DestroyWindow(self.0) };
        }
    }

    #[test]
    fn finds_a_program_window_and_skips_tool_and_owned_windows() {
        let main = TestWindow::create(0, std::ptr::null_mut());
        let tool = TestWindow::create(WS_EX_TOOLWINDOW, std::ptr::null_mut());
        let owned = TestWindow::create(0, main.0);
        let found = taskbar_windows(std::process::id());
        assert!(found.contains(&main.window()));
        assert!(!found.contains(&tool.window()));
        assert!(!found.contains(&owned.window()));
    }

    #[test]
    fn counts_an_app_window_even_when_owned() {
        let main = TestWindow::create(0, std::ptr::null_mut());
        let app = TestWindow::create(WS_EX_APPWINDOW, main.0);
        assert!(taskbar_windows(std::process::id()).contains(&app.window()));
    }

    #[test]
    fn asks_a_window_to_close_with_the_message_its_close_button_sends() {
        let window = TestWindow::create(0, std::ptr::null_mut());
        assert!(request_close(window.window()).is_ok());
        // SAFETY: MSG is plain data; PeekMessageW fills it for this thread's
        // own window, which is where the close request was posted.
        let received = unsafe {
            let mut message: MSG = std::mem::zeroed();
            PeekMessageW(&mut message, window.0, WM_CLOSE, WM_CLOSE, PM_REMOVE) != 0
                && message.message == WM_CLOSE
        };
        assert!(received);
    }

    #[test]
    fn finds_nothing_for_a_process_without_windows() {
        assert!(taskbar_windows(0xFFFF_FFF1).is_empty());
    }

    #[test]
    fn finds_the_shell() {
        // Tests run on a desktop session, where Explorer owns the taskbar.
        assert!(shell_process_id().is_some());
    }
}
