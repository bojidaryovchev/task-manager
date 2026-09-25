//! The Windows shell's own dialogs, for the process menu.

use windows_sys::Win32::UI::Shell::{SHObjectProperties, SHOP_FILEPATH};

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
