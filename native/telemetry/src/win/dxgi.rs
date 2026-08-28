//! Graphics adapter enumeration through DXGI.
//!
//! Windows publishes GPU utilisation and memory through PDH counter sets whose
//! instance names identify an adapter only by LUID
//! (`..._luid_0x00000000_0x000194b3_...`). Turning that into "NVIDIA GeForce RTX
//! 4080" needs `IDXGIFactory1::EnumAdapters1`, which is also the only supported
//! source for an adapter's total dedicated video memory - the amount VRAM usage
//! has to be measured against.
//!
//! # Why the interfaces are declared by hand
//!
//! `windows-sys` contains no COM interface definitions; they live in the much
//! larger `windows` crate. Rather than take that dependency for two vtable
//! calls, the two interfaces used here are declared directly. Their vtable
//! layouts are frozen ABI - a COM interface cannot reorder or insert methods
//! without breaking every binary ever compiled against it - so this is stable in
//! a way that guessing at an undocumented structure would not be.
//!
//! Every failure degrades to an empty adapter list, leaving the GPU collector to
//! report utilisation against LUIDs with no friendly name rather than nothing.

use std::ffi::c_void;

use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::LUID;

/// `IID_IDXGIFactory1` — {770aae78-f26f-4dba-a829-253c83d1b387}
const IID_IDXGIFACTORY1: GUID = GUID {
    data1: 0x770a_ae78,
    data2: 0xf26f,
    data3: 0x4dba,
    data4: [0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87],
};

/// `DXGI_ERROR_NOT_FOUND`, returned by `EnumAdapters1` past the last adapter.
const DXGI_ERROR_NOT_FOUND: i32 = 0x887A_0002_u32 as i32;

/// `DXGI_ADAPTER_FLAG_SOFTWARE`
const DXGI_ADAPTER_FLAG_SOFTWARE: u32 = 2;

#[link(name = "dxgi")]
extern "system" {
    fn CreateDXGIFactory1(riid: *const GUID, factory: *mut *mut c_void) -> i32;
}

/// `DXGI_ADAPTER_DESC1`.
#[repr(C)]
#[derive(Clone, Copy)]
struct DxgiAdapterDesc1 {
    description: [u16; 128],
    vendor_id: u32,
    device_id: u32,
    sub_sys_id: u32,
    revision: u32,
    dedicated_video_memory: usize,
    dedicated_system_memory: usize,
    shared_system_memory: usize,
    adapter_luid: LUID,
    flags: u32,
}

/// The subset of `IDXGIFactory1`'s vtable we call.
///
/// Order is fixed by the interface inheritance chain:
/// `IUnknown` (3) -> `IDXGIObject` (4) -> `IDXGIFactory` (5) -> `IDXGIFactory1`.
#[repr(C)]
struct IDXGIFactory1Vtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> i32,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    // IDXGIObject
    set_private_data: usize,
    set_private_data_interface: usize,
    get_private_data: usize,
    get_parent: usize,
    // IDXGIFactory
    enum_adapters: usize,
    make_window_association: usize,
    get_window_association: usize,
    create_swap_chain: usize,
    create_software_adapter: usize,
    // IDXGIFactory1
    enum_adapters1: unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> i32,
    is_current: usize,
}

/// The subset of `IDXGIAdapter1`'s vtable we call.
///
/// `IUnknown` (3) -> `IDXGIObject` (4) -> `IDXGIAdapter` (3) -> `IDXGIAdapter1`.
#[repr(C)]
struct IDXGIAdapter1Vtbl {
    query_interface: usize,
    add_ref: usize,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    // IDXGIObject
    set_private_data: usize,
    set_private_data_interface: usize,
    get_private_data: usize,
    get_parent: usize,
    // IDXGIAdapter
    enum_outputs: usize,
    get_desc: usize,
    check_interface_support: usize,
    // IDXGIAdapter1
    get_desc1: unsafe extern "system" fn(*mut c_void, *mut DxgiAdapterDesc1) -> i32,
}

/// A graphics adapter as DXGI describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphicsAdapter {
    /// e.g. "NVIDIA GeForce RTX 4080 Laptop GPU".
    pub description: String,
    /// Locally unique id, matching the `luid_0x..._0x...` in PDH instance names.
    pub luid_high: i32,
    pub luid_low: u32,
    /// Total dedicated video memory in bytes. Zero for adapters with none.
    pub dedicated_video_memory_bytes: u64,
    /// Memory on the adapter carved out of system RAM.
    pub dedicated_system_memory_bytes: u64,
    /// System memory the adapter may share.
    pub shared_system_memory_bytes: u64,
    pub vendor_id: u32,
    pub device_id: u32,
    /// True for software renderers such as the Microsoft Basic Render Driver.
    pub is_software: bool,
}

impl GraphicsAdapter {
    /// The LUID formatted the way PDH writes it in an instance name.
    pub fn luid_key(&self) -> String {
        format_luid(self.luid_high, self.luid_low)
    }
}

/// Format a LUID the way the GPU counter sets do.
pub fn format_luid(high: i32, low: u32) -> String {
    format!("0x{:08x}_0x{:08x}", high as u32, low)
}

/// RAII wrapper so an early return cannot leak a COM reference.
struct ComPtr {
    pointer: *mut c_void,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
}

impl Drop for ComPtr {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            // SAFETY: we hold one reference, taken by the call that produced
            // this pointer, and release it exactly once.
            unsafe { (self.release)(self.pointer) };
            self.pointer = std::ptr::null_mut();
        }
    }
}

/// Enumerate the graphics adapters DXGI reports.
///
/// Returns an empty list when DXGI is unavailable, which is not an error worth
/// propagating: the GPU collector still has the counter data and simply has no
/// friendly names for it.
pub fn enumerate_adapters() -> Vec<GraphicsAdapter> {
    let mut factory: *mut c_void = std::ptr::null_mut();
    // SAFETY: standard COM creation; the out-parameter receives a reference we
    // own on success and is left null on failure.
    let result = unsafe { CreateDXGIFactory1(&IID_IDXGIFACTORY1, &mut factory) };
    if result < 0 || factory.is_null() {
        return Vec::new();
    }
    // SAFETY: a COM object's first field is a pointer to its vtable.
    let factory_vtbl = unsafe { &**(factory as *mut *const IDXGIFactory1Vtbl) };
    let _factory_guard = ComPtr {
        pointer: factory,
        release: factory_vtbl.release,
    };

    let mut adapters = Vec::new();
    // Bounded: no real machine has anywhere near this many adapters, and the
    // loop must not depend solely on the driver returning NOT_FOUND.
    for index in 0..64u32 {
        let mut adapter: *mut c_void = std::ptr::null_mut();
        // SAFETY: calling EnumAdapters1 at its fixed vtable slot with the
        // factory as `this`; it returns DXGI_ERROR_NOT_FOUND past the last one.
        let result = unsafe { (factory_vtbl.enum_adapters1)(factory, index, &mut adapter) };
        if result == DXGI_ERROR_NOT_FOUND || result < 0 || adapter.is_null() {
            break;
        }
        // SAFETY: as above, the first field is the vtable pointer.
        let adapter_vtbl = unsafe { &**(adapter as *mut *const IDXGIAdapter1Vtbl) };
        let _adapter_guard = ComPtr {
            pointer: adapter,
            release: adapter_vtbl.release,
        };

        // SAFETY: DXGI_ADAPTER_DESC1 is plain data with no invalid bit
        // patterns, and GetDesc1 fills every field on success.
        let mut description: DxgiAdapterDesc1 = unsafe { std::mem::zeroed() };
        // SAFETY: passing a correctly sized output structure.
        let result = unsafe { (adapter_vtbl.get_desc1)(adapter, &mut description) };
        if result < 0 {
            continue;
        }

        let end = description
            .description
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(description.description.len());
        adapters.push(GraphicsAdapter {
            description: String::from_utf16_lossy(&description.description[..end])
                .trim()
                .to_string(),
            luid_high: description.adapter_luid.HighPart,
            luid_low: description.adapter_luid.LowPart,
            dedicated_video_memory_bytes: description.dedicated_video_memory as u64,
            dedicated_system_memory_bytes: description.dedicated_system_memory as u64,
            shared_system_memory_bytes: description.shared_system_memory as u64,
            vendor_id: description.vendor_id,
            device_id: description.device_id,
            is_software: description.flags & DXGI_ADAPTER_FLAG_SOFTWARE != 0,
        });
    }

    adapters
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_a_luid_the_way_pdh_does() {
        // Matches the shape seen in a real GPU Engine instance name:
        // pid_111056_luid_0x00000000_0x000194b3_phys_0_eng_0_engtype_3d
        assert_eq!(format_luid(0, 0x0001_94b3), "0x00000000_0x000194b3");
    }

    #[test]
    fn formats_in_lower_case_to_match_the_parsed_counter_key() {
        // gpu::parse_luid lower-cases what PDH returns, so this must match.
        assert_eq!(format_luid(0, 0x0001_94B3), "0x00000000_0x000194b3");
    }

    #[test]
    fn formats_a_negative_high_part_as_unsigned_hex() {
        // LUID.HighPart is signed, but PDH prints the raw 32 bits.
        assert_eq!(format_luid(-1, 1), "0xffffffff_0x00000001");
    }
}
