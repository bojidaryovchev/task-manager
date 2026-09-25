//! The little of the registry this application reads and writes: listing a
//! key's values, reading one, and setting a binary one.

use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegEnumValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_SET_VALUE, KEY_WOW64_64KEY,
    REG_BINARY, REG_EXPAND_SZ, REG_OPTION_NON_VOLATILE, REG_SZ,
};

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// The hive a key is in: only the two this application uses, so a caller can
/// name nothing but a key Windows predefines.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Root {
    CurrentUser,
    LocalMachine,
}

impl Root {
    fn handle(self) -> HKEY {
        match self {
            Root::CurrentUser => HKEY_CURRENT_USER,
            Root::LocalMachine => HKEY_LOCAL_MACHINE,
        }
    }
}

/// An open registry key, closed when dropped.
pub struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: we own this handle and close it exactly once.
        unsafe { RegCloseKey(self.0) };
    }
}

/// A value's data, for the types this application reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Data {
    /// `REG_SZ`, or `REG_EXPAND_SZ` with its `%VARIABLES%` left as they are.
    Text {
        text: String,
        expandable: bool,
    },
    Binary(Vec<u8>),
    /// Any other type, which nothing here needs.
    Other,
}

impl Key {
    /// Open `path` under `root` for reading, in the 64-bit view. On failure,
    /// the Windows error code: `ERROR_FILE_NOT_FOUND` when it does not exist.
    pub fn open(root: Root, path: &str) -> Result<Key, u32> {
        let path = wide(path);
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: `path` is NUL-terminated and outlives the call; `key` is a
        // valid out-pointer, and the handle it receives is ours to close.
        let status = unsafe {
            RegOpenKeyExW(
                root.handle(),
                path.as_ptr(),
                0,
                KEY_QUERY_VALUE | KEY_WOW64_64KEY,
                &mut key,
            )
        };
        if status == ERROR_SUCCESS {
            Ok(Key(key))
        } else {
            Err(status)
        }
    }

    /// Open `path` under `root` for writing, creating it if it is missing.
    /// On failure, the Windows error code: `ERROR_ACCESS_DENIED` when this
    /// account may not write there.
    pub fn create_for_writing(root: Root, path: &str) -> Result<Key, u32> {
        let path = wide(path);
        let mut key: HKEY = std::ptr::null_mut();
        // SAFETY: as for `open`; the class and security attributes are null,
        // and the disposition is not asked for.
        let status = unsafe {
            RegCreateKeyExW(
                root.handle(),
                path.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE | KEY_QUERY_VALUE | KEY_WOW64_64KEY,
                std::ptr::null(),
                &mut key,
                std::ptr::null_mut(),
            )
        };
        if status == ERROR_SUCCESS {
            Ok(Key(key))
        } else {
            Err(status)
        }
    }

    /// Every value in the key, by name, in the order the registry lists them.
    pub fn values(&self) -> Vec<(String, Data)> {
        let mut values = Vec::new();
        let mut name = vec![0u16; 16_384];
        let mut data = vec![0u8; 4096];
        let mut index = 0u32;
        loop {
            let mut name_length = name.len() as u32;
            let mut data_length = data.len() as u32;
            let mut kind = 0u32;
            // SAFETY: both buffers are writable for the lengths passed, which
            // Windows updates to what it wrote.
            let status = unsafe {
                RegEnumValueW(
                    self.0,
                    index,
                    name.as_mut_ptr(),
                    &mut name_length,
                    std::ptr::null(),
                    &mut kind,
                    data.as_mut_ptr(),
                    &mut data_length,
                )
            };
            if status == ERROR_MORE_DATA && data_length as usize > data.len() {
                // Read the same index again with room for its data.
                data.resize(data_length as usize, 0);
                continue;
            }
            if status == ERROR_NO_MORE_ITEMS || status != ERROR_SUCCESS {
                return values;
            }
            let value_name = String::from_utf16_lossy(&name[..name_length as usize]);
            values.push((value_name, decode(kind, &data[..data_length as usize])));
            index += 1;
        }
    }

    /// One value, or None when it does not exist or cannot be read.
    pub fn value(&self, name: &str) -> Option<Data> {
        let name = wide(name);
        let mut kind = 0u32;
        let mut length = 0u32;
        // SAFETY: a null buffer asks for the size and type.
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut length,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let mut data = vec![0u8; length as usize];
        // SAFETY: the buffer is writable for `length` bytes.
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                data.as_mut_ptr(),
                &mut length,
            )
        };
        (status == ERROR_SUCCESS).then(|| decode(kind, &data[..length as usize]))
    }

    /// Set a `REG_BINARY` value. On failure, the Windows error code.
    pub fn set_binary(&self, name: &str, data: &[u8]) -> Result<(), u32> {
        let name = wide(name);
        // SAFETY: `name` is NUL-terminated and `data` is readable for its
        // length; both outlive the call.
        let status = unsafe {
            RegSetValueExW(
                self.0,
                name.as_ptr(),
                0,
                REG_BINARY,
                data.as_ptr(),
                data.len() as u32,
            )
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(status)
        }
    }
}

/// Turn raw value data into what it holds.
fn decode(kind: u32, data: &[u8]) -> Data {
    match kind {
        REG_SZ | REG_EXPAND_SZ => {
            let units: Vec<u16> = data
                .as_chunks::<2>()
                .0
                .iter()
                .map(|&pair| u16::from_le_bytes(pair))
                .collect();
            // Stored strings usually end with a NUL, and may not.
            let end = units
                .iter()
                .position(|&unit| unit == 0)
                .unwrap_or(units.len());
            Data::Text {
                text: String::from_utf16_lossy(&units[..end]),
                expandable: kind == REG_EXPAND_SZ,
            }
        }
        REG_BINARY => Data::Binary(data.to_vec()),
        _ => Data::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_values_and_says_when_a_key_is_missing() {
        let key = Key::open(
            Root::LocalMachine,
            r"SOFTWARE\Microsoft\Windows NT\CurrentVersion",
        )
        .expect("open");
        assert!(matches!(key.value("ProductName"), Some(Data::Text { .. })));
        assert!(key.values().iter().any(|(name, _)| name == "ProductName"));
        assert!(key.value("TaskManagerNoSuchValue").is_none());
        assert!(Key::open(Root::LocalMachine, r"SOFTWARE\TaskManagerNoSuchKey").is_err());
    }

    #[test]
    fn decodes_strings_with_or_without_their_terminator() {
        let bytes: Vec<u8> = "ab".encode_utf16().flat_map(u16::to_le_bytes).collect();
        let mut terminated = bytes.clone();
        terminated.extend_from_slice(&[0, 0]);
        for data in [&bytes, &terminated] {
            assert_eq!(
                decode(REG_SZ, data),
                Data::Text {
                    text: "ab".into(),
                    expandable: false
                }
            );
        }
    }
}
