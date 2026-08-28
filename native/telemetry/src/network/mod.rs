//! Network telemetry.
//!
//! # What is measured
//!
//! Per-adapter throughput from the `Network Interface` counter set, which counts
//! bytes at the interface, plus the adapter's negotiated link speed. Totals are
//! summed across adapters here rather than taken from a `_Total` instance,
//! because that counter set does not publish one.
//!
//! # What is not measured
//!
//! Per-process network attribution. Windows does not expose it through a
//! counter set; it requires either ETW (`Microsoft-Windows-Kernel-Network`) or
//! periodic polling of the TCP/UDP connection tables joined against owning PIDs.
//! Neither is implemented yet, so no per-process network figure is reported
//! rather than one derived from the general-purpose process I/O counters, which
//! mix file, network and device traffic and would be wrong.
//!
//! # Loopback and virtual adapters
//!
//! A machine with WSL, Hyper-V, Docker or a VPN has many adapters, and loopback
//! traffic can dwarf real network use. They are reported individually with their
//! names so the UI can show what is actually carrying traffic, and the loopback
//! pseudo-interface is flagged so a total can exclude it.

use std::collections::HashMap;

use crate::win::pdh::{CounterId, PdhQuery};

/// One network interface over one interval.
#[derive(Debug, Clone)]
pub struct InterfaceSample {
    /// PDH instance name, which is the adapter description Windows shows.
    pub name: String,
    pub received_bytes_per_second: f64,
    pub sent_bytes_per_second: f64,
    pub total_bytes_per_second: f64,
    /// Negotiated link speed in bits per second, when the counter reported one.
    pub link_speed_bits_per_second: Option<f64>,
    /// Packets per second, useful for spotting a chatty link that moves few bytes.
    pub received_packets_per_second: Option<f64>,
    pub sent_packets_per_second: Option<f64>,
    /// Outbound packets discarded because the queue was full.
    pub outbound_discards_per_second: Option<f64>,
    /// True for the Windows loopback pseudo-interface.
    pub is_loopback: bool,
}

#[derive(Debug, Clone, Default)]
pub struct NetworkSample {
    pub interfaces: Vec<InterfaceSample>,
    /// Sum over non-loopback interfaces.
    pub received_bytes_per_second: f64,
    pub sent_bytes_per_second: f64,
    /// True when the counter set could not be registered at all.
    pub unavailable: bool,
}

pub struct NetworkCollector {
    received: Option<CounterId>,
    sent: Option<CounterId>,
    link_speed: Option<CounterId>,
    received_packets: Option<CounterId>,
    sent_packets: Option<CounterId>,
    outbound_discards: Option<CounterId>,
}

impl NetworkCollector {
    /// A collector for a machine where PDH itself could not be opened.
    pub fn unavailable() -> Self {
        Self {
            received: None,
            sent: None,
            link_speed: None,
            received_packets: None,
            sent_packets: None,
            outbound_discards: None,
        }
    }

    pub fn register(query: &mut PdhQuery) -> Self {
        Self {
            received: query.add(r"\Network Interface(*)\Bytes Received/sec"),
            sent: query.add(r"\Network Interface(*)\Bytes Sent/sec"),
            link_speed: query.add(r"\Network Interface(*)\Current Bandwidth"),
            received_packets: query.add(r"\Network Interface(*)\Packets Received/sec"),
            sent_packets: query.add(r"\Network Interface(*)\Packets Sent/sec"),
            outbound_discards: query.add(r"\Network Interface(*)\Packets Outbound Discarded"),
        }
    }

    pub fn is_available(&self) -> bool {
        self.received.is_some() && self.sent.is_some()
    }

    pub fn sample(&self, query: &PdhQuery) -> NetworkSample {
        if !self.is_available() {
            return NetworkSample {
                unavailable: true,
                ..Default::default()
            };
        }

        let received = collect(query, self.received);
        let sent = collect(query, self.sent);
        let speed = collect(query, self.link_speed);
        let received_packets = collect(query, self.received_packets);
        let sent_packets = collect(query, self.sent_packets);
        let discards = collect(query, self.outbound_discards);

        let mut names: Vec<String> = received.keys().chain(sent.keys()).cloned().collect();
        names.sort();
        names.dedup();

        let mut interfaces = Vec::with_capacity(names.len());
        let mut total_received = 0.0;
        let mut total_sent = 0.0;

        for name in names {
            let received_bytes = received.get(&name).copied().unwrap_or(0.0);
            let sent_bytes = sent.get(&name).copied().unwrap_or(0.0);
            let is_loopback = is_loopback_name(&name);
            if !is_loopback {
                total_received += received_bytes;
                total_sent += sent_bytes;
            }
            interfaces.push(InterfaceSample {
                received_bytes_per_second: received_bytes,
                sent_bytes_per_second: sent_bytes,
                total_bytes_per_second: received_bytes + sent_bytes,
                // Current Bandwidth is reported in bits per second; a zero means
                // the adapter is down rather than that it has no speed.
                link_speed_bits_per_second: speed.get(&name).copied().filter(|value| *value > 0.0),
                received_packets_per_second: received_packets.get(&name).copied(),
                sent_packets_per_second: sent_packets.get(&name).copied(),
                outbound_discards_per_second: discards.get(&name).copied(),
                is_loopback,
                name,
            });
        }

        interfaces.sort_by(|a, b| {
            b.total_bytes_per_second
                .total_cmp(&a.total_bytes_per_second)
        });

        NetworkSample {
            interfaces,
            received_bytes_per_second: total_received,
            sent_bytes_per_second: total_sent,
            unavailable: false,
        }
    }
}

fn collect(query: &PdhQuery, id: Option<CounterId>) -> HashMap<String, f64> {
    match id {
        Some(id) => query.instances(id).into_iter().collect(),
        None => HashMap::new(),
    }
}

/// Recognise the Windows loopback pseudo-interface by its description.
///
/// Matched on the adapter description Windows publishes rather than on an
/// address, because the counter set gives us only the name.
pub fn is_loopback_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("loopback")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_loopback_pseudo_interface() {
        assert!(is_loopback_name("Software Loopback Interface 1"));
        assert!(is_loopback_name("software loopback interface 1"));
    }

    #[test]
    fn does_not_treat_a_real_adapter_as_loopback() {
        for name in [
            "Intel[R] Wi-Fi 6E AX211 160MHz",
            "Killer E3100G 2.5 Gigabit Ethernet Controller",
            "Hyper-V Virtual Ethernet Adapter",
            "vEthernet [WSL [Hyper-V firewall]]",
        ] {
            assert!(!is_loopback_name(name), "{name} treated as loopback");
        }
    }
}
