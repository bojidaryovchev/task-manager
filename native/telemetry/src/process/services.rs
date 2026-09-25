//! Which services each process hosts, so `svchost.exe` rows can say what they
//! are.
//!
//! # Off the sampling thread
//!
//! Reading the service list is a round trip to the Service Control Manager
//! that was measured at 34 ms median in a release build. On the sampling thread
//! that would delay every tenth sample by as much, so a small worker thread
//! reads it instead, every `REFRESH_INTERVAL`, and the collector only ever
//! picks up the latest reading. The worker reads only while the process list is
//! being collected, and stops with the collector.
//!
//! # Identity
//!
//! A process is only credited with services when it was created before the
//! list was read: a PID reused since would otherwise inherit services it has
//! nothing to do with.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::clock::{wall_clock_unix_ms, FILETIME_UNIX_EPOCH_DELTA_100NS};
use crate::win::services::{self, ServiceEntry};

/// How long a reading of the service list is used before it is read again.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(5);

/// How long after the collector last asked the worker keeps reading. Longer
/// than any sampling interval, so a slow interval does not pause it.
const WANTED_FOR: Duration = Duration::from_secs(15);

/// A service a process hosts, by both of its names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedService {
    /// The key name, e.g. `Audiosrv`.
    pub name: String,
    /// The name people read, e.g. `Windows Audio`.
    pub display_name: String,
}

/// One reading of the service list.
#[derive(Debug, Default)]
pub struct Reading {
    by_pid: HashMap<u32, Vec<HostedService>>,
    /// When the list was read, in the units process creation times use.
    read_at_100ns: i64,
}

impl Reading {
    /// The services `pid` hosts, provided the process existed when the list
    /// was read.
    pub fn hosted_by(&self, pid: u32, created_100ns: i64) -> Option<&[HostedService]> {
        if created_100ns > self.read_at_100ns {
            return None;
        }
        self.by_pid.get(&pid).map(Vec::as_slice)
    }
}

struct Shared {
    latest: Mutex<Arc<Reading>>,
    /// Milliseconds since `origin` at which the collector last asked.
    wanted_at_ms: AtomicU64,
    origin: Instant,
    stop: AtomicBool,
}

pub struct ServiceIndex {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}

impl ServiceIndex {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                latest: Mutex::new(Arc::new(Reading::default())),
                wanted_at_ms: AtomicU64::new(0),
                origin: Instant::now(),
                stop: AtomicBool::new(false),
            }),
            worker: None,
        }
    }

    /// The latest reading, asking the worker to keep them coming. Empty until
    /// the first read completes, a few tens of milliseconds after first asked.
    pub fn latest(&mut self) -> Arc<Reading> {
        let now = self.shared.origin.elapsed().as_millis() as u64;
        self.shared.wanted_at_ms.store(now, Ordering::Relaxed);
        if self.worker.is_none() {
            let shared = Arc::clone(&self.shared);
            self.worker = std::thread::Builder::new()
                .name("task-manager-services".into())
                .spawn(move || run(&shared))
                .ok();
        }
        match self.shared.latest.lock() {
            Ok(latest) => Arc::clone(&latest),
            Err(_) => Arc::new(Reading::default()),
        }
    }
}

impl Default for ServiceIndex {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ServiceIndex {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            worker.thread().unpark();
            let _ = worker.join();
        }
    }
}

fn run(shared: &Shared) {
    let mut last_read: Option<Instant> = None;
    while !shared.stop.load(Ordering::Relaxed) {
        let now_ms = shared.origin.elapsed().as_millis() as u64;
        let wanted = now_ms.saturating_sub(shared.wanted_at_ms.load(Ordering::Relaxed))
            < WANTED_FOR.as_millis() as u64;
        let due = last_read.is_none_or(|at| at.elapsed() >= REFRESH_INTERVAL);
        if wanted && due {
            // Taken before the read, so a process created during it is never
            // credited with a list that may predate it.
            let read_at_100ns =
                (wall_clock_unix_ms() * 10_000.0) as i64 + FILETIME_UNIX_EPOCH_DELTA_100NS;
            let reading = match services::enumerate() {
                Ok(list) => Reading {
                    by_pid: index(list),
                    read_at_100ns,
                },
                // Unknown is not the same as none: credit nothing until a read
                // succeeds, rather than keep an answer that may be stale.
                Err(_) => Reading::default(),
            };
            if let Ok(mut latest) = shared.latest.lock() {
                *latest = Arc::new(reading);
            }
            last_read = Some(Instant::now());
        }
        // Parked rather than slept, so stopping does not wait out the interval.
        std::thread::park_timeout(Duration::from_millis(500));
    }
}

/// Group running services by the process they run in, in display-name order.
fn index(services: Vec<ServiceEntry>) -> HashMap<u32, Vec<HostedService>> {
    let mut by_pid: HashMap<u32, Vec<HostedService>> = HashMap::new();
    for service in services.into_iter().filter(|service| service.pid != 0) {
        by_pid.entry(service.pid).or_default().push(HostedService {
            name: service.name,
            display_name: service.display_name,
        });
    }
    for hosted in by_pid.values_mut() {
        hosted.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    }
    by_pid
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, display: &str, pid: u32) -> ServiceEntry {
        ServiceEntry {
            name: name.into(),
            display_name: display.into(),
            service_type: 0x20,
            state: if pid == 0 { 1 } else { 4 },
            controls_accepted: 0,
            pid,
        }
    }

    #[test]
    fn groups_running_services_by_process_and_skips_stopped_ones() {
        let indexed = index(vec![
            entry("b", "Beta", 8),
            entry("a", "Alpha", 8),
            entry("c", "Gamma", 12),
            entry("stopped", "Stopped", 0),
        ]);
        let names: Vec<_> = indexed[&8]
            .iter()
            .map(|s| s.display_name.as_str())
            .collect();
        assert_eq!(names, ["Alpha", "Beta"]);
        assert_eq!(indexed[&12].len(), 1);
        assert!(!indexed.contains_key(&0));
    }

    #[test]
    fn never_credits_a_process_created_after_the_list_was_read() {
        let reading = Reading {
            by_pid: index(vec![entry("a", "Alpha", 8)]),
            read_at_100ns: 1_000,
        };
        assert!(reading.hosted_by(8, 999).is_some());
        assert!(reading.hosted_by(8, 1_001).is_none());
    }

    #[test]
    fn reads_the_live_list_on_its_own_thread_and_stops_cleanly() {
        let mut services = ServiceIndex::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while services.latest().by_pid.is_empty() {
            assert!(Instant::now() < deadline, "no reading within ten seconds");
            std::thread::sleep(Duration::from_millis(20));
        }
        // Dropping joins the worker; a hang here would fail the test run.
        drop(services);
    }
}
