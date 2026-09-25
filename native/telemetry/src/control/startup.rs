//! Startup apps, for the Startup apps page: what Windows starts at sign-in,
//! and turning each on or off. `win::startup` explains what is read and
//! written, and how much of it Windows documents.

use napi_derive::napi;

use crate::clock::FILETIME_UNIX_EPOCH_DELTA_100NS;
use crate::process::image_metadata;
use crate::win::startup::{self, Approval, Source, SwitchError};

/// One program Windows starts when the user signs in.
#[napi(object)]
pub struct JsStartupItem {
    /// Where it is registered: a Run key or a Startup folder.
    #[napi(ts_type = "'userRun' | 'machineRun' | 'machineRun32' | 'userFolder' | 'commonFolder'")]
    pub source: String,
    /// The Run value's name, or the Startup folder file's name.
    pub name: String,
    /// The command as registered; for a Startup folder item, its path.
    pub command: String,
    /// The program it starts, when the command names one by full path.
    pub program_path: Option<String>,
    /// Whether that program is where the command says.
    pub program_exists: bool,
    /// The program's own name for itself: its FileDescription, or its
    /// ProductName.
    pub description: Option<String>,
    /// The program's CompanyName.
    pub publisher: Option<String>,
    /// `unknown` when Windows' record is in a form not seen before.
    #[napi(ts_type = "'enabled' | 'disabled' | 'unknown'")]
    pub status: String,
    /// When it was turned off, when Windows recorded the time.
    pub disabled_at_unix_ms: Option<f64>,
    /// The first byte of Windows' record, when there is one.
    pub approval_flag: Option<u32>,
}

/// Every startup entry this account can read. Reads the registry and the
/// Startup folders, and each program's version resource; changes nothing.
#[napi]
pub fn list_startup_items() -> Vec<JsStartupItem> {
    startup::entries()
        .into_iter()
        .map(|entry| {
            let metadata = entry
                .program
                .as_deref()
                .map(image_metadata)
                .unwrap_or_default();
            let program_exists = entry
                .program
                .as_deref()
                .is_some_and(|path| std::path::Path::new(path).is_file());
            let (status, disabled_at, flag) = match entry.approval {
                Approval::Default => ("enabled", None, None),
                Approval::On { flag } => ("enabled", None, Some(u32::from(flag))),
                Approval::Off { flag, since_100ns } => (
                    "disabled",
                    since_100ns.map(|filetime| {
                        (filetime - FILETIME_UNIX_EPOCH_DELTA_100NS) as f64 / 10_000.0
                    }),
                    Some(u32::from(flag)),
                ),
                Approval::Unknown { flag } => ("unknown", None, flag.map(u32::from)),
            };
            JsStartupItem {
                source: entry.source.name().into(),
                name: entry.name,
                command: entry.command,
                program_path: entry.program,
                program_exists,
                description: metadata.file_description.or(metadata.product_name),
                publisher: metadata.company_name,
                status: status.into(),
                disabled_at_unix_ms: disabled_at,
                approval_flag: flag,
            }
        })
        .collect()
}

/// What became of turning a startup entry on or off.
#[napi(object)]
pub struct JsStartupOutcome {
    /// `done`; `notFound` (no such entry any more); `accessDenied` (the
    /// machine-wide entries need administrator rights); or `failed`, with
    /// the Windows error.
    #[napi(ts_type = "'done' | 'notFound' | 'accessDenied' | 'failed'")]
    pub outcome: String,
    pub win32_error: Option<u32>,
}

/// Turn a startup entry on or off, the way Windows records it.
#[napi]
pub fn set_startup_item_enabled(source: String, name: String, enabled: bool) -> JsStartupOutcome {
    let outcome = |outcome: &str, win32_error: Option<u32>| JsStartupOutcome {
        outcome: outcome.into(),
        win32_error,
    };
    let Some(source) = Source::parse(&source) else {
        return outcome("notFound", None);
    };
    match startup::set_enabled(source, &name, enabled) {
        Ok(()) => outcome("done", None),
        Err(SwitchError::NotFound) => outcome("notFound", None),
        Err(SwitchError::AccessDenied) => outcome("accessDenied", None),
        Err(SwitchError::Failed(error)) => outcome("failed", Some(error)),
    }
}
