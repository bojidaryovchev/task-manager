//! NVIDIA Management Library, for GPU die temperature.
//!
//! NVML is the interface `nvidia-smi` itself is built on. It reports the
//! temperature the GPU's own on-die sensor measures, which makes it the one
//! temperature source in this application that needs no interpretation: the
//! vendor says what it is, and it needs no administrator rights.
//!
//! # Why it is loaded dynamically
//!
//! `nvml.dll` ships with the NVIDIA display driver, so it is absent on a
//! machine with no NVIDIA GPU and must not be a link-time dependency - that
//! would stop the whole native module from loading on an AMD or Intel machine.
//! It is resolved with `LoadLibraryW`/`GetProcAddress`, and every failure at any
//! stage degrades to "no NVIDIA temperature available".
//!
//! # Other vendors
//!
//! There is no equivalent here for AMD or Intel. AMD's ADLX and Intel's IGCL
//! are SDK distributions rather than components present on an end-user machine,
//! and neither publishes GPU temperature through a Windows API or a PDH counter
//! set. Those adapters therefore report no temperature rather than a guess.

use std::ffi::{c_char, c_void};

use windows_sys::core::PCSTR;
use windows_sys::Win32::Foundation::HMODULE;
use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

/// `NVML_SUCCESS`.
const NVML_SUCCESS: u32 = 0;

/// `NVML_TEMPERATURE_GPU` - the die sensor. The only sensor type NVML defines.
const NVML_TEMPERATURE_GPU: u32 = 0;

/// `NVML_TEMPERATURE_THRESHOLD_SHUTDOWN` - where the driver cuts power.
const NVML_TEMPERATURE_THRESHOLD_SHUTDOWN: u32 = 0;
/// `NVML_TEMPERATURE_THRESHOLD_SLOWDOWN` - where the driver starts throttling.
const NVML_TEMPERATURE_THRESHOLD_SLOWDOWN: u32 = 1;

/// `NVML_DEVICE_NAME_BUFFER_SIZE`.
const NAME_BUFFER_SIZE: usize = 64;

/// An opaque `nvmlDevice_t`.
type NvmlDeviceHandle = *mut c_void;

/// `nvmlPciInfo_t`, as of NVML's v3 PCI info structure.
///
/// Only `pci_device_id` is read, but the whole structure must be declared so
/// NVML writes into storage of the right size.
#[repr(C)]
#[derive(Clone, Copy)]
struct NvmlPciInfo {
    bus_id_legacy: [c_char; 16],
    domain: u32,
    bus: u32,
    device: u32,
    /// `(deviceId << 16) | vendorId` - the same pair DXGI reports separately,
    /// which is what lets an NVML device be joined to a DXGI adapter.
    pci_device_id: u32,
    pci_sub_system_id: u32,
    bus_id: [c_char; 32],
}

type FnInit = unsafe extern "system" fn() -> u32;
type FnShutdown = unsafe extern "system" fn() -> u32;
type FnDeviceGetCount = unsafe extern "system" fn(*mut u32) -> u32;
type FnDeviceGetHandleByIndex = unsafe extern "system" fn(u32, *mut NvmlDeviceHandle) -> u32;
type FnDeviceGetName = unsafe extern "system" fn(NvmlDeviceHandle, *mut c_char, u32) -> u32;
type FnDeviceGetTemperature = unsafe extern "system" fn(NvmlDeviceHandle, u32, *mut u32) -> u32;
type FnDeviceGetTemperatureThreshold =
    unsafe extern "system" fn(NvmlDeviceHandle, u32, *mut u32) -> u32;
type FnDeviceGetPciInfo = unsafe extern "system" fn(NvmlDeviceHandle, *mut NvmlPciInfo) -> u32;

/// One NVIDIA GPU as NVML enumerated it at startup.
#[derive(Debug, Clone)]
pub struct NvmlDevice {
    handle: NvmlDeviceHandle,
    /// Board name, e.g. "NVIDIA GeForce RTX 4080".
    pub name: String,
    /// PCI vendor id, extracted from `pciDeviceId`. `0x10de` for NVIDIA.
    pub vendor_id: u32,
    /// PCI device id, extracted from `pciDeviceId`. Matches DXGI's `DeviceId`.
    pub device_id: u32,
    /// Temperature at which the driver begins throttling, when NVML reports one.
    pub slowdown_celsius: Option<f64>,
    /// Temperature at which the driver shuts the board down.
    pub shutdown_celsius: Option<f64>,
}

// SAFETY: an nvmlDevice_t is an opaque handle into NVML's own tables, not a
// pointer into this process's heap, and NVML's device queries are documented as
// thread-safe. Only the sampling thread ever touches these.
unsafe impl Send for NvmlDevice {}

/// A loaded, initialised NVML.
pub struct Nvml {
    shutdown: FnShutdown,
    get_temperature: FnDeviceGetTemperature,
    devices: Vec<NvmlDevice>,
}

// SAFETY: as for NvmlDevice - the entry points are plain function pointers into
// a module that stays mapped for the life of the process.
unsafe impl Send for Nvml {}

/// Read a NUL-terminated ASCII buffer NVML filled in.
fn from_c_string(buffer: &[c_char]) -> String {
    let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
    buffer[..end]
        .iter()
        .map(|&c| c as u8 as char)
        .collect::<String>()
        .trim()
        .to_string()
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Resolve one export, or give up on NVML entirely.
///
/// # Safety
///
/// `module` must be a live module handle, and `T` must be the exact signature
/// NVML declares for `name`. Every call site below pairs a symbol with the
/// type alias transcribed from `nvml.h`.
unsafe fn symbol<T: Copy>(module: HMODULE, name: &std::ffi::CStr) -> Option<T> {
    debug_assert_eq!(
        std::mem::size_of::<T>(),
        std::mem::size_of::<*const c_void>(),
        "symbol() transmutes a code address, so T must be pointer-sized",
    );
    // SAFETY: the caller guarantees `module` is live; `name` is NUL-terminated.
    let address = unsafe { GetProcAddress(module, name.as_ptr() as PCSTR) }?;
    // SAFETY: GetProcAddress returned a non-null code address, and the caller
    // guarantees `T` matches the exported signature.
    Some(unsafe { std::mem::transmute_copy::<_, T>(&address) })
}

impl Nvml {
    /// Load NVML, initialise it and enumerate the GPUs.
    ///
    /// Returns `None` on a machine with no NVIDIA driver, which is the normal
    /// case rather than an error.
    pub fn load() -> Option<Self> {
        let name = wide("nvml.dll");
        // SAFETY: `name` is a NUL-terminated UTF-16 string that outlives the
        // call. The module is deliberately never freed: NVML is initialised for
        // the life of the process and unloading it while a device handle is
        // still held would invalidate that handle.
        let module: HMODULE = unsafe { LoadLibraryW(name.as_ptr()) };
        if module.is_null() {
            return None;
        }

        // SAFETY: `module` was just loaded, and each type alias is transcribed
        // from the corresponding declaration in NVML's public header.
        let (
            init,
            shutdown,
            get_count,
            get_handle,
            get_name,
            get_temperature,
            get_threshold,
            get_pci,
        ) = unsafe {
            (
                symbol::<FnInit>(module, c"nvmlInit_v2")?,
                symbol::<FnShutdown>(module, c"nvmlShutdown")?,
                symbol::<FnDeviceGetCount>(module, c"nvmlDeviceGetCount_v2")?,
                symbol::<FnDeviceGetHandleByIndex>(module, c"nvmlDeviceGetHandleByIndex_v2")?,
                symbol::<FnDeviceGetName>(module, c"nvmlDeviceGetName")?,
                symbol::<FnDeviceGetTemperature>(module, c"nvmlDeviceGetTemperature")?,
                symbol::<FnDeviceGetTemperatureThreshold>(
                    module,
                    c"nvmlDeviceGetTemperatureThreshold",
                ),
                symbol::<FnDeviceGetPciInfo>(module, c"nvmlDeviceGetPciInfo_v3"),
            )
        };

        // SAFETY: NVML's documented entry point; takes no arguments.
        if unsafe { init() } != NVML_SUCCESS {
            return None;
        }

        let mut count: u32 = 0;
        // SAFETY: the out-parameter points at local storage that outlives the call.
        if unsafe { get_count(&mut count) } != NVML_SUCCESS {
            // SAFETY: init() succeeded, so shutdown() is the matching call.
            unsafe { shutdown() };
            return None;
        }

        let mut devices = Vec::new();
        // Bounded independently of what NVML reports, so a nonsense count
        // cannot spin this loop.
        for index in 0..count.min(64) {
            let mut handle: NvmlDeviceHandle = std::ptr::null_mut();
            // SAFETY: out-parameter points at local storage; `index` is below
            // the count NVML just reported.
            if unsafe { get_handle(index, &mut handle) } != NVML_SUCCESS || handle.is_null() {
                continue;
            }

            let mut name_buffer = [0 as c_char; NAME_BUFFER_SIZE];
            // SAFETY: the buffer length passed is the true allocated length.
            let named =
                unsafe { get_name(handle, name_buffer.as_mut_ptr(), NAME_BUFFER_SIZE as u32) }
                    == NVML_SUCCESS;

            let mut pci: NvmlPciInfo = NvmlPciInfo {
                bus_id_legacy: [0; 16],
                domain: 0,
                bus: 0,
                device: 0,
                pci_device_id: 0,
                pci_sub_system_id: 0,
                bus_id: [0; 32],
            };
            if let Some(get_pci) = get_pci {
                // SAFETY: passing a correctly sized, fully initialised
                // structure for NVML to overwrite.
                unsafe { get_pci(handle, &mut pci) };
            }

            let threshold = |kind: u32| -> Option<f64> {
                let get_threshold = get_threshold?;
                let mut value: u32 = 0;
                // SAFETY: out-parameter points at local storage that outlives
                // the call; `kind` is one of NVML's declared threshold enums.
                (unsafe { get_threshold(handle, kind, &mut value) } == NVML_SUCCESS)
                    .then(|| f64::from(value))
            };

            devices.push(NvmlDevice {
                handle,
                name: if named {
                    from_c_string(&name_buffer)
                } else {
                    String::new()
                },
                // pciDeviceId packs the pair DXGI reports as two fields.
                vendor_id: pci.pci_device_id & 0xffff,
                device_id: pci.pci_device_id >> 16,
                slowdown_celsius: threshold(NVML_TEMPERATURE_THRESHOLD_SLOWDOWN),
                shutdown_celsius: threshold(NVML_TEMPERATURE_THRESHOLD_SHUTDOWN),
            });
        }

        if devices.is_empty() {
            // SAFETY: init() succeeded, so shutdown() is the matching call.
            unsafe { shutdown() };
            return None;
        }

        Some(Self {
            shutdown,
            get_temperature,
            devices,
        })
    }

    pub fn devices(&self) -> &[NvmlDevice] {
        &self.devices
    }

    /// Current die temperature in degrees Celsius.
    ///
    /// NVML reports whole degrees; the value is not interpolated or smoothed.
    pub fn temperature_celsius(&self, device: &NvmlDevice) -> Option<f64> {
        let mut value: u32 = 0;
        // SAFETY: `device.handle` came from this same NVML instance and is
        // valid until shutdown; the out-parameter is local storage.
        let status =
            unsafe { (self.get_temperature)(device.handle, NVML_TEMPERATURE_GPU, &mut value) };
        (status == NVML_SUCCESS).then(|| f64::from(value))
    }
}

impl Drop for Nvml {
    fn drop(&mut self) {
        // SAFETY: matched against the successful nvmlInit_v2 in `load`. The
        // device handles are dropped with this struct and are not used after.
        unsafe { (self.shutdown)() };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_a_pci_device_id_the_way_dxgi_reports_it() {
        // A real RTX-class pciDeviceId: device 0x2b85, vendor 0x10de (NVIDIA).
        let packed: u32 = 0x2b85_10de;
        assert_eq!(packed & 0xffff, 0x10de);
        assert_eq!(packed >> 16, 0x2b85);
    }

    #[test]
    fn reads_a_nul_terminated_name() {
        let mut buffer = [0 as c_char; NAME_BUFFER_SIZE];
        for (slot, byte) in buffer.iter_mut().zip(b"NVIDIA GeForce RTX 4080") {
            *slot = *byte as c_char;
        }
        assert_eq!(from_c_string(&buffer), "NVIDIA GeForce RTX 4080");
    }

    #[test]
    fn reads_a_name_that_fills_the_buffer_with_no_terminator() {
        let buffer = [b'A' as c_char; NAME_BUFFER_SIZE];
        assert_eq!(from_c_string(&buffer).len(), NAME_BUFFER_SIZE);
    }

    #[test]
    fn loading_nvml_never_panics_whether_or_not_a_driver_is_present() {
        // On a machine with no NVIDIA driver this returns None; on one with a
        // driver it enumerates. Either is a pass - what must not happen is a
        // crash inside the native module on an AMD or Intel machine.
        let _ = Nvml::load();
    }
}
