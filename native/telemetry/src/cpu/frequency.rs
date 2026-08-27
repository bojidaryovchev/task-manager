//! Processor frequency, from the only two sources Windows offers without
//! vendor-specific drivers.
//!
//! * `CallNtPowerInformation(ProcessorInformation)` reports `MaxMhz`,
//!   `CurrentMhz` and `MhzLimit` per logical processor. `CurrentMhz` is derived
//!   by the power manager and on many modern parts simply mirrors the nominal
//!   frequency, so it is reported as-is and never used to fabricate a
//!   "measured" clock speed.
//! * The registry value `~MHz` under `CentralProcessor\0` is the nominal (base)
//!   frequency recorded at boot. Combined with the PDH `% Processor
//!   Performance` counter it yields the speed Task Manager displays.
//!
//! Nothing here computes a frequency by timing a loop, and no value is
//! synthesised when the source is unavailable.

use windows_sys::Win32::System::Power::{CallNtPowerInformation, ProcessorInformation};
use windows_sys::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
};

/// `PROCESSOR_POWER_INFORMATION` as returned by `CallNtPowerInformation`.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
struct ProcessorPowerInformation {
    number: u32,
    max_mhz: u32,
    current_mhz: u32,
    mhz_limit: u32,
    max_idle_state: u32,
    current_idle_state: u32,
}

/// What we could learn about one logical processor's clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessorFrequency {
    pub max_mhz: Option<u32>,
    pub current_mhz: Option<u32>,
    pub mhz_limit: Option<u32>,
}

/// Reads per-processor frequency, reusing one buffer across samples.
pub struct FrequencyReader {
    buffer: Vec<ProcessorPowerInformation>,
    /// Set when the API failed, so we stop paying for a call that will not work.
    unavailable: bool,
}

impl FrequencyReader {
    pub fn new(logical_processor_count: usize) -> Self {
        Self {
            buffer: vec![ProcessorPowerInformation::default(); logical_processor_count.max(1)],
            unavailable: false,
        }
    }

    /// Read current frequencies. Returns an empty vector when unavailable.
    ///
    /// Note the documented limitation: this reports processors in the calling
    /// thread's group only, so on machines with multiple processor groups the
    /// tail of the list has no frequency information. That is reflected as
    /// `None` rather than by repeating group 0's values.
    pub fn read(&mut self) -> Vec<ProcessorFrequency> {
        if self.unavailable || self.buffer.is_empty() {
            return Vec::new();
        }
        let bytes = std::mem::size_of_val(&self.buffer[..]) as u32;
        // SAFETY: ProcessorInformation takes no input buffer and writes one
        // PROCESSOR_POWER_INFORMATION per processor into the output buffer,
        // whose true byte length we pass.
        let status = unsafe {
            CallNtPowerInformation(
                ProcessorInformation,
                std::ptr::null(),
                0,
                self.buffer.as_mut_ptr() as *mut _,
                bytes,
            )
        };
        if status != 0 {
            self.unavailable = true;
            return Vec::new();
        }
        self.buffer
            .iter()
            .map(|entry| ProcessorFrequency {
                max_mhz: (entry.max_mhz > 0).then_some(entry.max_mhz),
                current_mhz: (entry.current_mhz > 0).then_some(entry.current_mhz),
                mhz_limit: (entry.mhz_limit > 0).then_some(entry.mhz_limit),
            })
            .collect()
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

const CENTRAL_PROCESSOR_KEY: &str = r"HARDWARE\DESCRIPTION\System\CentralProcessor\0";

/// Nominal base frequency in MHz, from the registry value Windows writes at boot.
pub fn read_base_frequency_mhz() -> Option<u32> {
    let subkey = wide(CENTRAL_PROCESSOR_KEY);
    let value_name = wide("~MHz");
    let mut data: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: output buffer is a u32 and we pass its exact size; RegGetValueW
    // validates the type against RRF_RT_REG_DWORD before writing.
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
    if status != 0 || data == 0 {
        return None;
    }
    Some(data)
}

/// CPU brand string, e.g. "Intel(R) Core(TM) Ultra 9 275HX".
pub fn read_processor_brand_string() -> Option<String> {
    let subkey = wide(CENTRAL_PROCESSOR_KEY);
    let value_name = wide("ProcessorNameString");
    let mut size: u32 = 0;
    // SAFETY: a null data pointer asks for the required size in bytes.
    let status = unsafe {
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
    if status != 0 || size == 0 || size > 4096 {
        return None;
    }
    let mut buffer = vec![0u16; size as usize / 2 + 1];
    let mut size_out = size;
    // SAFETY: buffer holds at least `size` bytes; RegGetValueW NUL-terminates.
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
}
