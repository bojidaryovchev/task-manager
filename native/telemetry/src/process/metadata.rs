//! Executable metadata, used to group processes into applications.
//!
//! Grouping must be conservative, so it is built only from signals Windows
//! actually provides:
//!
//! * the version resource of the image (`ProductName`, `CompanyName`,
//!   `FileDescription`), which is what a publisher declares about their own
//!   binary;
//! * Windows package identity (`GetPackageFullName`) and the Application User
//!   Model ID (`GetApplicationUserModelId`) for packaged applications, which are
//!   authoritative identifiers rather than heuristics.
//!
//! There is deliberately no built-in database of application names. Anything not
//! covered by these signals falls back to the executable path, and the user can
//! always see the raw processes underneath a group.
//!
//! Version resources are read from disk, so results are cached per image path -
//! a thousand `chrome.exe` processes read one file once.

use std::collections::HashMap;
use std::sync::Mutex;

use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HANDLE};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows_sys::Win32::Storage::Packaging::Appx::{GetApplicationUserModelId, GetPackageFullName};

/// What the image itself declares about the program it belongs to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ImageMetadata {
    /// `ProductName` from the version resource, e.g. "Google Chrome".
    pub product_name: Option<String>,
    /// `CompanyName`, e.g. "Google LLC".
    pub company_name: Option<String>,
    /// `FileDescription`, which is what Explorer shows as the friendly name.
    pub file_description: Option<String>,
}

impl ImageMetadata {
    pub fn is_empty(&self) -> bool {
        self.product_name.is_none()
            && self.company_name.is_none()
            && self.file_description.is_none()
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Cache keyed on image path. Version resources never change while a file is
/// mapped, and the same executable is usually running many times over.
static IMAGE_METADATA: Mutex<Option<HashMap<String, ImageMetadata>>> = Mutex::new(None);

/// Read the version resource of an executable.
pub fn image_metadata(image_path: &str) -> ImageMetadata {
    if let Ok(mut guard) = IMAGE_METADATA.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        if let Some(cached) = cache.get(image_path) {
            return cached.clone();
        }
    }
    let metadata = read_version_resource(image_path).unwrap_or_default();
    if let Ok(mut guard) = IMAGE_METADATA.lock() {
        let cache = guard.get_or_insert_with(HashMap::new);
        cache.insert(image_path.to_owned(), metadata.clone());
    }
    metadata
}

fn read_version_resource(image_path: &str) -> Option<ImageMetadata> {
    let path = wide(image_path);
    let mut handle: u32 = 0;
    // SAFETY: `path` is a NUL-terminated UTF-16 string that outlives the call.
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut handle) };
    // Guard against an implausible resource rather than trusting the size.
    if size == 0 || size > 4 * 1024 * 1024 {
        return None;
    }
    let mut block = vec![0u8; size as usize];
    // SAFETY: the block is exactly `size` bytes, which is what the call above
    // asked for.
    let ok = unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, block.as_mut_ptr() as *mut _) };
    if ok == 0 {
        return None;
    }

    // The translation table names which language/codepage blocks exist. Using
    // the first entry rather than assuming 040904b0 means non-English binaries
    // are read correctly.
    let translation = wide(r"\VarFileInfo\Translation");
    let mut pointer: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut length: u32 = 0;
    // SAFETY: `block` holds a valid version resource; VerQueryValueW returns a
    // pointer into it, valid for as long as `block` lives.
    let ok = unsafe {
        VerQueryValueW(
            block.as_ptr() as *const _,
            translation.as_ptr(),
            &mut pointer,
            &mut length,
        )
    };
    // Each translation entry is a WORD language followed by a WORD codepage.
    let (language, codepage) = if ok != 0 && !pointer.is_null() && length >= 4 {
        // SAFETY: verified at least four bytes are available at `pointer`.
        unsafe {
            let words = pointer as *const u16;
            (words.read_unaligned(), words.add(1).read_unaligned())
        }
    } else {
        // US English, Unicode - the historical default.
        (0x0409, 0x04b0)
    };

    let read = |name: &str| -> Option<String> {
        let key = wide(&format!(
            "\\StringFileInfo\\{language:04x}{codepage:04x}\\{name}"
        ));
        let mut value: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut value_len: u32 = 0;
        // SAFETY: as above; the returned pointer borrows from `block`.
        let ok = unsafe {
            VerQueryValueW(
                block.as_ptr() as *const _,
                key.as_ptr(),
                &mut value,
                &mut value_len,
            )
        };
        if ok == 0 || value.is_null() || value_len == 0 || value_len > 4096 {
            return None;
        }
        // SAFETY: VerQueryValueW reports the length in characters for a string
        // value, and the buffer lives inside `block`.
        let text = unsafe {
            let slice = std::slice::from_raw_parts(value as *const u16, value_len as usize);
            let end = slice.iter().position(|&c| c == 0).unwrap_or(slice.len());
            String::from_utf16_lossy(&slice[..end])
        };
        let trimmed = text.trim().to_string();
        (!trimmed.is_empty()).then_some(trimmed)
    };

    let metadata = ImageMetadata {
        product_name: read("ProductName"),
        company_name: read("CompanyName"),
        file_description: read("FileDescription"),
    };
    (!metadata.is_empty()).then_some(metadata)
}

/// Windows package identity for a packaged (MSIX/UWP) process.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PackageIdentity {
    /// e.g. `Microsoft.WindowsTerminal_1.22.0_x64__8wekyb3d8bbwe`
    pub package_full_name: Option<String>,
    /// The Application User Model ID, which identifies one app within a package.
    pub application_user_model_id: Option<String>,
}

impl PackageIdentity {
    pub fn is_empty(&self) -> bool {
        self.package_full_name.is_none() && self.application_user_model_id.is_none()
    }
}

/// Read package identity from an open process handle.
///
/// Returns an empty identity for ordinary desktop processes, which is the
/// overwhelmingly common case and not an error.
pub fn package_identity(process: HANDLE) -> PackageIdentity {
    PackageIdentity {
        package_full_name: read_package_full_name(process),
        application_user_model_id: read_application_user_model_id(process),
    }
}

fn read_package_full_name(process: HANDLE) -> Option<String> {
    let mut length: u32 = 0;
    // SAFETY: a null buffer asks for the required length in characters; the call
    // fails with ERROR_INSUFFICIENT_BUFFER for a packaged process and with
    // APPMODEL_ERROR_NO_PACKAGE for everything else.
    unsafe { GetPackageFullName(process, &mut length, std::ptr::null_mut()) };
    if length == 0 || length > 1024 {
        return None;
    }
    let mut buffer = vec![0u16; length as usize];
    // SAFETY: the buffer holds `length` characters, as just requested.
    let status = unsafe { GetPackageFullName(process, &mut length, buffer.as_mut_ptr()) };
    if status != ERROR_SUCCESS {
        return None;
    }
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..end]);
    (!text.is_empty()).then_some(text)
}

fn read_application_user_model_id(process: HANDLE) -> Option<String> {
    let mut length: u32 = 0;
    // SAFETY: as above - a null buffer requests the length.
    unsafe { GetApplicationUserModelId(process, &mut length, std::ptr::null_mut()) };
    if length == 0 || length > 1024 {
        return None;
    }
    let mut buffer = vec![0u16; length as usize];
    // SAFETY: the buffer holds `length` characters, as just requested.
    let status = unsafe { GetApplicationUserModelId(process, &mut length, buffer.as_mut_ptr()) };
    if status != ERROR_SUCCESS {
        return None;
    }
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..end]);
    (!text.is_empty()).then_some(text)
}
