//! Programs Windows starts when the user signs in: the Run keys and the
//! Startup folders, which Microsoft documents, and whether each is turned on,
//! which it does not.
//!
//! # On or off
//!
//! Turning an entry off does not remove it. Windows records the choice under
//! `Explorer\StartupApproved`, in the entry's own hive: one `REG_BINARY` value
//! per entry, named after the Run value or the Startup folder's file. The
//! format is not documented, so only what was observed is used:
//!
//! - first byte `02` or `06`: on. On the development machine, Viber (`02`)
//!   and Windows Security's tray icon (`06`) started 13 and 8 seconds after
//!   sign-in;
//! - first byte `03`: off, and when turned off from Windows' own interface,
//!   bytes 4 to 11 hold the time as a FILETIME. Steam and DAEMON Tools (`03`,
//!   turned off on the same day 17 seconds apart) were not running;
//! - no value at all: never switched, so Windows' documented behaviour for the
//!   Run keys applies, and it runs.
//!
//! Anything else is reported as unknown rather than read as either. Switching
//! writes exactly the bytes Windows wrote there: `02` and zeros to turn on,
//! `03` and the current time to turn off. Citrix documents the same two
//! values, and that a Startup-folder item's value is named after its file
//! (CTX492466).

use windows_sys::Win32::Foundation::{ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, FILETIME};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
use windows_sys::Win32::UI::Shell::{
    FOLDERID_CommonStartup, FOLDERID_Startup, SHGetKnownFolderPath,
};

use crate::win::registry::{Data, Key, Root};

const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_32: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run";
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved";

/// Where a startup entry is registered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// The current user's Run key.
    UserRun,
    /// The machine's Run key, for every user.
    MachineRun,
    /// The machine's Run key for 32-bit programs.
    MachineRun32,
    /// The current user's Startup folder.
    UserFolder,
    /// The Startup folder for every user.
    CommonFolder,
}

impl Source {
    pub const ALL: [Source; 5] = [
        Source::UserRun,
        Source::MachineRun,
        Source::MachineRun32,
        Source::UserFolder,
        Source::CommonFolder,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Source::UserRun => "userRun",
            Source::MachineRun => "machineRun",
            Source::MachineRun32 => "machineRun32",
            Source::UserFolder => "userFolder",
            Source::CommonFolder => "commonFolder",
        }
    }

    pub fn parse(name: &str) -> Option<Source> {
        Source::ALL.into_iter().find(|source| source.name() == name)
    }

    /// Where the on or off choice for this source's entries is kept.
    fn approval(self) -> (Root, String) {
        let (root, leaf) = match self {
            Source::UserRun => (Root::CurrentUser, "Run"),
            Source::MachineRun => (Root::LocalMachine, "Run"),
            Source::MachineRun32 => (Root::LocalMachine, "Run32"),
            Source::UserFolder => (Root::CurrentUser, "StartupFolder"),
            Source::CommonFolder => (Root::LocalMachine, "StartupFolder"),
        };
        (root, format!(r"{APPROVED}\{leaf}"))
    }

    /// The Run key for a registry source.
    fn run_key(self) -> Option<(Root, &'static str)> {
        match self {
            Source::UserRun => Some((Root::CurrentUser, RUN)),
            Source::MachineRun => Some((Root::LocalMachine, RUN)),
            Source::MachineRun32 => Some((Root::LocalMachine, RUN_32)),
            Source::UserFolder | Source::CommonFolder => None,
        }
    }
}

/// Whether an entry is turned on, as far as Windows' record of it says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Approval {
    /// Never switched: it runs.
    Default,
    On {
        flag: u8,
    },
    /// `since_100ns` is the FILETIME it was turned off at, when recorded.
    Off {
        flag: u8,
        since_100ns: Option<i64>,
    },
    /// A value in a form not seen: neither on nor off is claimed.
    Unknown {
        flag: Option<u8>,
    },
}

impl Approval {
    /// Read an approval value's bytes.
    pub fn decode(data: &[u8]) -> Approval {
        match data.first().copied() {
            Some(flag @ (0x02 | 0x06)) => Approval::On { flag },
            Some(flag @ 0x03) => {
                let since = data
                    .get(4..12)
                    .map(|bytes| i64::from_le_bytes(bytes.try_into().unwrap_or([0; 8])))
                    .filter(|&filetime| filetime > 0);
                Approval::Off {
                    flag,
                    since_100ns: since,
                }
            }
            flag => Approval::Unknown { flag },
        }
    }

    pub fn is_on(self) -> Option<bool> {
        match self {
            Approval::Default | Approval::On { .. } => Some(true),
            Approval::Off { .. } => Some(false),
            Approval::Unknown { .. } => None,
        }
    }
}

/// One program Windows starts at sign-in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupEntry {
    pub source: Source,
    /// The Run value's name, or the Startup folder file's name.
    pub name: String,
    /// The command as registered; for a Startup folder item, its path.
    pub command: String,
    /// The program it starts, when that can be read from the command.
    pub program: Option<String>,
    pub approval: Approval,
}

/// Every startup entry, from every source this account can read.
pub fn entries() -> Vec<StartupEntry> {
    let mut entries = Vec::new();
    for source in Source::ALL {
        let (approval_root, approval_path) = source.approval();
        let approvals = Key::open(approval_root, &approval_path).ok();
        let approval = |name: &str| match approvals.as_ref().and_then(|key| key.value(name)) {
            Some(Data::Binary(bytes)) => Approval::decode(&bytes),
            Some(_) => Approval::Unknown { flag: None },
            None => Approval::Default,
        };
        match source.run_key() {
            Some((root, path)) => {
                let Ok(key) = Key::open(root, path) else {
                    continue;
                };
                for (name, data) in key.values() {
                    let Data::Text { text, .. } = data else {
                        continue;
                    };
                    entries.push(StartupEntry {
                        source,
                        approval: approval(&name),
                        program: program_of(&text),
                        command: text,
                        name,
                    });
                }
            }
            None => {
                let Some(folder) = startup_folder(source) else {
                    continue;
                };
                let Ok(files) = std::fs::read_dir(&folder) else {
                    continue;
                };
                for file in files.flatten() {
                    let name = file.file_name().to_string_lossy().into_owned();
                    // The folder's own settings file, which Windows does not
                    // start.
                    if name.eq_ignore_ascii_case("desktop.ini")
                        || file.file_type().is_ok_and(|kind| kind.is_dir())
                    {
                        continue;
                    }
                    let path = file.path().to_string_lossy().into_owned();
                    let runs_itself = std::path::Path::new(&name)
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| {
                            ["exe", "com", "bat", "cmd"]
                                .iter()
                                .any(|known| extension.eq_ignore_ascii_case(known))
                        });
                    entries.push(StartupEntry {
                        source,
                        approval: approval(&name),
                        // A shortcut's target is not read, so it is not
                        // claimed.
                        program: runs_itself.then(|| path.clone()),
                        command: path,
                        name,
                    });
                }
            }
        }
    }
    entries
}

/// The program a Run command starts, when it names one by full path.
fn program_of(command: &str) -> Option<String> {
    let expanded = crate::control::expand_environment(command);
    let (program, _) =
        crate::control::split_command(&expanded, |path| std::path::Path::new(path).is_file());
    let absolute =
        program.len() > 2 && (program.as_bytes()[1] == b':' || program.starts_with(r"\\"));
    absolute.then_some(program)
}

/// The folder behind a Startup folder source.
fn startup_folder(source: Source) -> Option<String> {
    let id = match source {
        Source::UserFolder => &FOLDERID_Startup,
        Source::CommonFolder => &FOLDERID_CommonStartup,
        _ => return None,
    };
    let mut path: *mut u16 = std::ptr::null_mut();
    // SAFETY: a known folder id, no flags and no token (this user); the path
    // Windows allocates is freed below whatever the result.
    let result = unsafe { SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut path) };
    let folder = if result >= 0 && !path.is_null() {
        let mut length = 0usize;
        // SAFETY: Windows returned a NUL-terminated string.
        while unsafe { *path.add(length) } != 0 {
            length += 1;
        }
        // SAFETY: the `length` characters before the terminator are readable.
        Some(String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(path, length)
        }))
    } else {
        None
    };
    // SAFETY: freeing what SHGetKnownFolderPath allocated; null is allowed.
    unsafe { CoTaskMemFree(path.cast()) };
    folder
}

/// Why an entry could not be switched.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwitchError {
    /// No such entry any more.
    NotFound,
    /// This account may not write there: the machine-wide entries need
    /// administrator rights.
    AccessDenied,
    Failed(u32),
}

/// Turn an entry on or off, the way Windows records it.
pub fn set_enabled(source: Source, name: &str, enabled: bool) -> Result<(), SwitchError> {
    let exists = match source.run_key() {
        Some((root, path)) => Key::open(root, path)
            .ok()
            .is_some_and(|key| matches!(key.value(name), Some(Data::Text { .. }))),
        None => startup_folder(source).is_some_and(|folder| {
            // A name with a separator would reach outside the folder.
            !name.contains(['\\', '/']) && std::path::Path::new(&folder).join(name).is_file()
        }),
    };
    if !exists {
        return Err(SwitchError::NotFound);
    }
    let (root, path) = source.approval();
    write_approval(root, &path, name, enabled)
}

/// The bytes Windows writes: `02` to turn on; `03` and the time to turn off.
pub fn approval_bytes(enabled: bool, now_100ns: i64) -> [u8; 12] {
    let mut bytes = [0u8; 12];
    if enabled {
        bytes[0] = 0x02;
    } else {
        bytes[0] = 0x03;
        bytes[4..12].copy_from_slice(&now_100ns.to_le_bytes());
    }
    bytes
}

fn write_approval(root: Root, path: &str, name: &str, enabled: bool) -> Result<(), SwitchError> {
    let mut now = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    // SAFETY: writes the current time into a valid FILETIME.
    unsafe { GetSystemTimeAsFileTime(&mut now) };
    let now_100ns = (i64::from(now.dwHighDateTime) << 32) | i64::from(now.dwLowDateTime);
    let key = Key::create_for_writing(root, path).map_err(|error| match error {
        ERROR_ACCESS_DENIED => SwitchError::AccessDenied,
        ERROR_FILE_NOT_FOUND => SwitchError::NotFound,
        error => SwitchError::Failed(error),
    })?;
    key.set_binary(name, &approval_bytes(enabled, now_100ns))
        .map_err(|error| match error {
            ERROR_ACCESS_DENIED => SwitchError::AccessDenied,
            error => SwitchError::Failed(error),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::Registry::{RegDeleteTreeW, HKEY_CURRENT_USER};

    #[test]
    fn reads_only_the_forms_it_has_seen() {
        assert_eq!(Approval::decode(&[2, 0, 0, 0]), Approval::On { flag: 2 });
        assert_eq!(Approval::decode(&[6; 12]), Approval::On { flag: 6 });
        let off = approval_bytes(false, 133_700_000_000_000_000);
        assert_eq!(
            Approval::decode(&off),
            Approval::Off {
                flag: 3,
                since_100ns: Some(133_700_000_000_000_000)
            }
        );
        // Written by something else, without a time.
        assert_eq!(
            Approval::decode(&[3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
            Approval::Off {
                flag: 3,
                since_100ns: None
            }
        );
        assert_eq!(
            Approval::decode(&[7; 12]),
            Approval::Unknown { flag: Some(7) }
        );
        assert_eq!(Approval::decode(&[]), Approval::Unknown { flag: None });
        assert_eq!(Approval::Default.is_on(), Some(true));
    }

    #[test]
    fn writes_what_windows_writes() {
        assert_eq!(
            approval_bytes(true, 99),
            [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
        );
        let off = approval_bytes(false, 0x0102_0304_0506_0708);
        assert_eq!(&off[..4], &[3, 0, 0, 0]);
        assert_eq!(&off[4..], &0x0102_0304_0506_0708i64.to_le_bytes());
    }

    #[test]
    fn switches_an_entry_in_a_scratch_key_and_reads_it_back() {
        // Never the real StartupApproved key: a scratch key of our own,
        // removed afterwards, so running the tests changes nothing that
        // Windows starts.
        let scratch = format!(r"Software\TaskManagerTests\startup-{}", std::process::id());
        let approvals = format!(r"{scratch}\StartupApproved\Run");
        write_approval(Root::CurrentUser, &approvals, "Example", false).expect("off");
        let key = Key::open(Root::CurrentUser, &approvals).expect("open");
        let Some(Data::Binary(bytes)) = key.value("Example") else {
            panic!("no value written");
        };
        assert!(matches!(
            Approval::decode(&bytes),
            Approval::Off {
                since_100ns: Some(_),
                ..
            }
        ));
        write_approval(Root::CurrentUser, &approvals, "Example", true).expect("on");
        let Some(Data::Binary(bytes)) = key.value("Example") else {
            panic!("no value written");
        };
        assert_eq!(Approval::decode(&bytes), Approval::On { flag: 2 });
        drop(key);
        let tree: Vec<u16> = r"Software\TaskManagerTests"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // SAFETY: deleting our own scratch tree under HKCU.
        unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, tree.as_ptr()) };
    }

    #[test]
    fn refuses_to_switch_what_does_not_exist() {
        assert_eq!(
            set_enabled(Source::UserRun, "TaskManagerNoSuchEntry", false),
            Err(SwitchError::NotFound)
        );
        assert_eq!(
            set_enabled(Source::UserFolder, r"..\escape.lnk", false),
            Err(SwitchError::NotFound)
        );
    }

    #[test]
    fn lists_entries_without_changing_anything() {
        for entry in entries() {
            assert!(!entry.name.is_empty());
            assert!(!entry.command.is_empty());
        }
        assert!(startup_folder(Source::UserFolder).is_some());
    }

    #[test]
    fn names_every_source_both_ways() {
        for source in Source::ALL {
            assert_eq!(Source::parse(source.name()), Some(source));
        }
        assert_eq!(Source::parse("elsewhere"), None);
    }
}
