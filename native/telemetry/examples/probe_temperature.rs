//! Probe: which temperature sources does this machine expose, and what do they cost?
//!
//! Run with `cargo run --example probe_temperature`. Exercises the real
//! `ThermalCollector` rather than a parallel implementation, so what it prints
//! is what the application would show. It reports each source's availability for
//! an **unelevated** process, because the application ships `asInvoker` and a
//! sensor that needs administrator is a sensor it cannot use.

use std::time::{Duration, Instant};

use telemetry::thermal::{gpu_temperature_by_pci_id, ThermalCollector};
use telemetry::win::dxgi;
use telemetry::win::pdh::PdhQuery;

fn main() {
    let mut query = PdhQuery::open();
    let mut collector = match query.as_mut() {
        Some(query) => ThermalCollector::register(query),
        None => {
            println!("PDH could not be opened; ACPI zones unavailable.");
            ThermalCollector::unavailable()
        }
    };

    println!("Sources:");
    println!(
        "   ACPI thermal zones (PDH): {}",
        if collector.zones_available() {
            "counter set registered"
        } else {
            "counter set absent"
        }
    );
    println!(
        "   NVML (NVIDIA):            {}",
        if collector.nvml_available() {
            "loaded"
        } else {
            "no NVIDIA driver"
        }
    );
    println!("   Physical drives open:     {}", collector.drive_count());

    let adapters = dxgi::enumerate_adapters();
    let pci_ids: Vec<(u32, u32)> = adapters
        .iter()
        .map(|adapter| (adapter.vendor_id, adapter.device_id))
        .collect();

    // PDH rate counters need two collections before they format, and the
    // polled sources need one pass to prime their caches.
    for tick in 0..6 {
        // A real interval between collections: PDH derives its values from the
        // gap between them, so back-to-back ticks would just reread one sample.
        std::thread::sleep(Duration::from_millis(1000));
        let monotonic_ms = f64::from(tick) * 1000.0;
        if let Some(query) = query.as_mut() {
            query.collect();
        }
        let started = Instant::now();
        let sample = collector.sample(query.as_ref(), monotonic_ms);
        let cost_ms = started.elapsed().as_secs_f64() * 1000.0;

        if tick == 0 {
            continue;
        }
        println!("\n--- tick {tick} (collector cost {cost_ms:.3} ms) ---");

        for zone in &sample.zones {
            println!(
                "   zone   {:<12} {:6.1} C   {}",
                zone.instance,
                zone.celsius,
                if zone.high_precision {
                    "high precision"
                } else {
                    "whole kelvin"
                }
            );
        }
        if sample.zones.is_empty() {
            println!("   zone   (none reporting)");
        }

        let matched = gpu_temperature_by_pci_id(&sample.gpus, &pci_ids);
        for gpu in &sample.gpus {
            println!(
                "   gpu    {:<28} {:6.1} C   slowdown {:?} shutdown {:?}  age {:.0} ms  {}",
                gpu.name,
                gpu.celsius,
                gpu.slowdown_celsius,
                gpu.shutdown_celsius,
                gpu.measured_ago_ms,
                if matched.contains_key(&(gpu.vendor_id, gpu.device_id)) {
                    "-> matched to a DXGI adapter"
                } else {
                    "-> not uniquely matchable"
                }
            );
        }

        for drive in &sample.drives {
            println!(
                "   drive  {:<28} {:6.1} C   warn {:?} crit {:?}  age {:.0} ms",
                format!(
                    "PhysicalDrive{} {}",
                    drive.drive_index,
                    drive.model.as_deref().unwrap_or("")
                )
                .trim_end(),
                drive.celsius,
                drive.warning_celsius,
                drive.critical_celsius,
                drive.measured_ago_ms,
            );
        }
    }
}
