//! Physical storage device queries, for drive temperature and model names.
//!
//! # The sensor
//!
//! `IOCTL_STORAGE_QUERY_PROPERTY` with `StorageDeviceTemperatureProperty`
//! returns the drive's own temperature sensors - for NVMe, the composite
//! temperature from the controller's SMART/Health log page; for SATA, the SMART
//! temperature attribute. Windows exposes it through the storage class driver,
//! so it is the vendor's own reading rather than anything derived here.
//!
//! # Why this works without administrator
//!
//! `CreateFileW` is called with `dwDesiredAccess = 0`. That asks for neither
//! read nor write access to the device's data - only the right to issue query
//! IOCTLs - and is the reason an unelevated process can read drive temperature
//! when it cannot read a sector. Opening with `GENERIC_READ` would need
//! administrator and would fail for a standard user.
//!
//! # What is not supported
//!
//! Plenty of devices do not implement the property. Observed failures include
//! `ERROR_INVALID_PARAMETER` (the driver has no temperature page) and
//! `ERROR_IO_DEVICE` (typically a card reader with no media). Those devices
//! report no temperature; they are never reported as 0 °C.

use std::ffi::c_void;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::IO::DeviceIoControl;

/// `CTL_CODE(IOCTL_STORAGE_BASE = 0x2d, 0x0500, METHOD_BUFFERED, FILE_ANY_ACCESS)`,
/// from `winioctl.h`.
const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D_1400;

/// `StorageDeviceProperty` from `STORAGE_PROPERTY_ID`.
const STORAGE_DEVICE_PROPERTY: u32 = 0;
/// `StorageDeviceTemperatureProperty` from `STORAGE_PROPERTY_ID`.
const STORAGE_DEVICE_TEMPERATURE_PROPERTY: u32 = 52;
/// `PropertyStandardQuery` from `STORAGE_QUERY_TYPE`.
const PROPERTY_STANDARD_QUERY: u32 = 0;

/// Highest `\\.\PhysicalDriveN` index probed. Well above any real machine, and
/// bounded so enumeration cannot depend on the loop being stopped by an error.
const MAX_PHYSICAL_DRIVES: u32 = 32;

/// `STORAGE_TEMPERATURE_VALUE_NOT_REPORTED` from `winioctl.h`, defined there as
/// `0x8000` - which is `i16::MIN` once read back through the signed field.
///
/// Both NVMe drives on the development machine publish it for their warning and
/// critical thresholds, so this is the normal case rather than an edge one.
/// Zero is deliberately *not* treated as absent: the field is signed precisely
/// because a drive can legitimately be at or below 0 °C.
const TEMPERATURE_NOT_REPORTED: i16 = i16::MIN;

#[repr(C)]
struct StoragePropertyQuery {
    property_id: u32,
    query_type: u32,
    additional_parameters: [u8; 8],
}

/// `STORAGE_TEMPERATURE_INFO`.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct StorageTemperatureInfo {
    index: u16,
    /// Degrees Celsius. Signed: the field is defined as such, and a drive in a
    /// cold room can legitimately report below zero.
    temperature: i16,
    over_threshold: i16,
    under_threshold: i16,
    over_threshold_changeable: u8,
    under_threshold_changeable: u8,
    event_generated: u8,
    reserved0: u8,
    reserved1: u32,
}

/// `STORAGE_TEMPERATURE_DATA_DESCRIPTOR`, followed by `info_count` entries.
#[repr(C)]
struct StorageTemperatureDataDescriptor {
    version: u32,
    size: u32,
    critical_temperature: i16,
    warning_temperature: i16,
    info_count: u16,
    reserved0: [u8; 2],
    reserved1: [u32; 2],
}

/// `STORAGE_DEVICE_DESCRIPTOR`, up to the offsets we read. The strings it points
/// at follow the fixed part, at byte offsets from the start of the structure.
#[repr(C)]
struct StorageDeviceDescriptor {
    version: u32,
    size: u32,
    device_type: u8,
    device_type_modifier: u8,
    removable_media: u8,
    command_queueing: u8,
    vendor_id_offset: u32,
    product_id_offset: u32,
    product_revision_offset: u32,
    serial_number_offset: u32,
    bus_type: u32,
    raw_properties_length: u32,
}

/// What one physical drive reported.
#[derive(Debug, Clone)]
pub struct StorageTemperature {
    /// The `N` in `\\.\PhysicalDriveN`, which is also the leading number in the
    /// `PhysicalDisk` PDH instance name, so the two join directly.
    pub drive_index: u32,
    /// Highest of the drive's sensors, in degrees Celsius. A drive with one
    /// composite sensor - the common case - reports that one.
    pub celsius: f64,
    /// Vendor-declared critical temperature, when the drive publishes one.
    pub critical_celsius: Option<f64>,
    /// Vendor-declared warning temperature, when the drive publishes one.
    pub warning_celsius: Option<f64>,
}

/// An open handle to `\\.\PhysicalDriveN`, held for the life of the collector.
///
/// Reopening on every poll would mean a `CreateFileW` against the storage stack
/// twice a second for no benefit; the handle carries no access rights, so
/// holding it cannot block anything else from using the device.
pub struct PhysicalDrive {
    handle: HANDLE,
    index: u32,
    /// Vendor and product strings joined, e.g. "Samsung SSD 990 PRO 2TB".
    /// Empty when the device descriptor query failed.
    model: String,
    /// False once the temperature property has been shown not to be supported,
    /// so an unsupported device is asked once rather than twice a second.
    supports_temperature: bool,
}

// SAFETY: a file handle is not thread-affine, and a `PhysicalDrive` is only ever
// touched from the single sampling thread that owns the collector.
unsafe impl Send for PhysicalDrive {}

impl PhysicalDrive {
    pub fn index(&self) -> u32 {
        self.index
    }

    /// The drive's model string, or `None` when the device did not publish one.
    pub fn model(&self) -> Option<&str> {
        (!self.model.is_empty()).then_some(self.model.as_str())
    }

    /// Open `\\.\PhysicalDriveN`, or `None` when there is no such drive.
    fn open(index: u32) -> Option<Self> {
        let path = wide(&format!(r"\\.\PhysicalDrive{index}"));
        // SAFETY: `path` is a NUL-terminated UTF-16 string that outlives the
        // call. `dwDesiredAccess = 0` requests neither read nor write access -
        // only the right to issue query IOCTLs - which is what makes this work
        // for an unelevated process.
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_EXISTING,
                0,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE || handle.is_null() {
            return None;
        }
        let mut drive = Self {
            handle,
            index,
            model: String::new(),
            supports_temperature: true,
        };
        drive.model = drive.read_model().unwrap_or_default();
        Some(drive)
    }

    /// Issue a property query, returning the bytes the driver wrote.
    fn query(&self, property_id: u32, buffer: &mut [u8]) -> Option<usize> {
        let query = StoragePropertyQuery {
            property_id,
            query_type: PROPERTY_STANDARD_QUERY,
            additional_parameters: [0; 8],
        };
        let mut returned: u32 = 0;
        // SAFETY: both buffers are described by their true lengths, and
        // `self.handle` is a live device handle owned by this struct.
        let ok = unsafe {
            DeviceIoControl(
                self.handle,
                IOCTL_STORAGE_QUERY_PROPERTY,
                std::ptr::addr_of!(query) as *const c_void,
                std::mem::size_of::<StoragePropertyQuery>() as u32,
                buffer.as_mut_ptr() as *mut c_void,
                buffer.len() as u32,
                &mut returned,
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(returned as usize)
    }

    /// Vendor and product strings from `StorageDeviceProperty`.
    fn read_model(&self) -> Option<String> {
        let mut buffer = [0u8; 1024];
        let returned = self.query(STORAGE_DEVICE_PROPERTY, &mut buffer)?;
        if returned < std::mem::size_of::<StorageDeviceDescriptor>() {
            return None;
        }
        // SAFETY: the returned length was checked against the fixed part of the
        // descriptor, and the structure is plain data with no invalid patterns.
        let descriptor =
            unsafe { std::ptr::read_unaligned(buffer.as_ptr() as *const StorageDeviceDescriptor) };
        let vendor = read_offset_string(&buffer[..returned], descriptor.vendor_id_offset);
        let product = read_offset_string(&buffer[..returned], descriptor.product_id_offset);
        let model = format!("{} {}", vendor.trim(), product.trim())
            .trim()
            .to_string();
        (!model.is_empty()).then_some(model)
    }

    /// Read the drive's temperature sensors.
    ///
    /// Returns `None` when the device does not implement the property, and
    /// records that so the device is not asked again.
    pub fn read_temperature(&mut self) -> Option<StorageTemperature> {
        if !self.supports_temperature {
            return None;
        }
        let mut buffer = [0u8; 1024];
        let Some(returned) = self.query(STORAGE_DEVICE_TEMPERATURE_PROPERTY, &mut buffer) else {
            self.supports_temperature = false;
            return None;
        };
        let header_size = std::mem::size_of::<StorageTemperatureDataDescriptor>();
        if returned < header_size {
            self.supports_temperature = false;
            return None;
        }
        // SAFETY: the returned length was checked against the header size, and
        // the structure is plain data with no invalid bit patterns.
        let descriptor = unsafe {
            std::ptr::read_unaligned(buffer.as_ptr() as *const StorageTemperatureDataDescriptor)
        };

        let entry_size = std::mem::size_of::<StorageTemperatureInfo>();
        let mut hottest: Option<i16> = None;
        for i in 0..descriptor.info_count as usize {
            let offset = header_size + i * entry_size;
            // Bounds checked against what the driver actually wrote, not
            // against what its own count field claims.
            if offset + entry_size > returned {
                break;
            }
            // SAFETY: the read is inside the region the driver reported writing.
            let info = unsafe {
                std::ptr::read_unaligned(
                    buffer.as_ptr().add(offset) as *const StorageTemperatureInfo
                )
            };
            if info.temperature == TEMPERATURE_NOT_REPORTED {
                continue;
            }
            hottest = Some(hottest.map_or(info.temperature, |best| best.max(info.temperature)));
        }

        let celsius = hottest?;
        Some(StorageTemperature {
            drive_index: self.index,
            celsius: f64::from(celsius),
            critical_celsius: (descriptor.critical_temperature != TEMPERATURE_NOT_REPORTED)
                .then(|| f64::from(descriptor.critical_temperature)),
            warning_celsius: (descriptor.warning_temperature != TEMPERATURE_NOT_REPORTED)
                .then(|| f64::from(descriptor.warning_temperature)),
        })
    }
}

impl Drop for PhysicalDrive {
    fn drop(&mut self) {
        if self.handle != INVALID_HANDLE_VALUE && !self.handle.is_null() {
            // SAFETY: the handle was opened by `open` and is closed exactly once.
            unsafe { CloseHandle(self.handle) };
        }
    }
}

/// Open every `\\.\PhysicalDriveN` that exists.
///
/// Drive numbers are not necessarily contiguous - removing a drive leaves a gap
/// until reboot - so the scan continues past a missing index and stops only at
/// the bound or after a long run of absences.
pub fn enumerate_physical_drives() -> Vec<PhysicalDrive> {
    let mut drives = Vec::new();
    let mut consecutive_missing = 0u32;
    for index in 0..MAX_PHYSICAL_DRIVES {
        match PhysicalDrive::open(index) {
            Some(drive) => {
                drives.push(drive);
                consecutive_missing = 0;
            }
            None => {
                // SAFETY: reading the calling thread's last error.
                if unsafe { GetLastError() } == ERROR_FILE_NOT_FOUND {
                    consecutive_missing += 1;
                    // Past this many gaps in a row there is nothing further up.
                    if consecutive_missing >= 8 {
                        break;
                    }
                }
            }
        }
    }
    drives
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Read a NUL-terminated ANSI string at a byte offset inside a descriptor.
///
/// Offset zero means "not present", which is how the structure encodes an
/// absent field.
fn read_offset_string(buffer: &[u8], offset: u32) -> String {
    let offset = offset as usize;
    if offset == 0 || offset >= buffer.len() {
        return String::new();
    }
    let rest = &buffer[offset..];
    let end = rest.iter().position(|&b| b == 0).unwrap_or(rest.len());
    String::from_utf8_lossy(&rest[..end]).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_string_at_an_offset() {
        let mut buffer = vec![0u8; 32];
        buffer[8..16].copy_from_slice(b"Samsung\0");
        assert_eq!(read_offset_string(&buffer, 8), "Samsung");
    }

    #[test]
    fn treats_a_zero_offset_as_absent() {
        // The descriptor encodes a missing vendor or product string this way.
        assert_eq!(read_offset_string(&[b'x', 0], 0), "");
    }

    #[test]
    fn refuses_an_offset_past_the_end_of_the_buffer() {
        // A malformed descriptor must not read out of bounds.
        assert_eq!(read_offset_string(&[0u8; 4], 99), "");
    }

    #[test]
    fn reads_a_string_that_runs_to_the_end_without_a_terminator() {
        assert_eq!(read_offset_string(b"..abc", 2), "abc");
    }

    #[test]
    fn the_temperature_structures_match_the_sizes_windows_writes() {
        // These are ABI, and getting either wrong would silently misparse every
        // sensor entry rather than fail. STORAGE_TEMPERATURE_DATA_DESCRIPTOR is
        // 24 bytes and STORAGE_TEMPERATURE_INFO is 16, per winioctl.h.
        assert_eq!(std::mem::size_of::<StorageTemperatureDataDescriptor>(), 24);
        assert_eq!(std::mem::size_of::<StorageTemperatureInfo>(), 16);
    }

    #[test]
    fn the_not_reported_sentinel_is_the_value_winioctl_defines() {
        // winioctl.h spells it 0x8000; the field is read back signed. Getting
        // this wrong showed -32768 C as a drive's critical threshold.
        assert_eq!(TEMPERATURE_NOT_REPORTED, 0x8000_u16 as i16);
        assert_eq!(TEMPERATURE_NOT_REPORTED, -32_768);
    }

    #[test]
    fn zero_degrees_is_a_reading_rather_than_a_missing_value() {
        // The temperature fields are signed so that a drive in a cold room can
        // report 0 or below. Treating 0 as "not reported" would discard it.
        assert_ne!(TEMPERATURE_NOT_REPORTED, 0);
    }

    #[test]
    fn enumerating_drives_never_panics() {
        // Runs against whatever hardware the test machine has, including none.
        let _ = enumerate_physical_drives();
    }
}
