//! Windows services: the list the Services page shows, and which services
//! each process hosts, from one reading.
//!
//! # Off the sampling thread
//!
//! Reading the service list is a round trip to the Service Control Manager
//! measured at 27-34 ms in a release build, and reading every service's
//! configuration as well costs about 160 ms more. On the sampling thread that
//! would delay samples by as much, so a small worker thread reads instead,
//! every `REFRESH_INTERVAL`, and the collector only ever picks up the latest
//! reading. The worker reads only while something wants the list - the process
//! list, for its `svchost.exe` rows, or the Services page - and configurations
//! only while the Services page is open.
//!
//! A configuration changes far less often than a state, so each is kept for
//! `CONFIG_REFRESH` before it is read again. A change made in `services.msc`
//! shows within that; a service started or stopped shows within
//! `REFRESH_INTERVAL`, or at once when this application asked for a refresh
//! because it did the starting or stopping.
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

use windows_sys::Win32::System::Services::{SC_MANAGER_CONNECT, SERVICE_QUERY_CONFIG};

use crate::clock::{wall_clock_unix_ms, FILETIME_UNIX_EPOCH_DELTA_100NS};
use crate::win::services::{self, ServiceConfig, ServiceEntry};

/// How long a reading of the service list is used before it is read again.
pub const REFRESH_INTERVAL: Duration = Duration::from_secs(5);

/// How long a service's configuration is kept before it is read again.
pub const CONFIG_REFRESH: Duration = Duration::from_secs(60);

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

/// One service as last read.
#[derive(Debug, Clone)]
pub struct ServiceRecord {
    pub entry: ServiceEntry,
    /// Absent when configurations were not being read, or this one could not
    /// be.
    pub config: Option<Arc<ServiceConfig>>,
}

/// One reading of the service list.
#[derive(Debug, Default)]
pub struct Reading {
    /// Every Win32 service, in the order Windows listed them.
    pub services: Vec<ServiceRecord>,
    by_pid: HashMap<u32, Vec<HostedService>>,
    /// When the list was read, in the units process creation times use.
    read_at_100ns: i64,
    /// When the list was read, for display.
    pub read_at_unix_ms: f64,
    /// The Windows error that stopped the list being read, if one did.
    pub failure: Option<u32>,
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
    /// When the list and the configurations were last asked for, as
    /// milliseconds since `origin` plus one; zero for never.
    list_wanted: AtomicU64,
    configs_wanted: AtomicU64,
    /// Read again now rather than at the next interval.
    refresh: AtomicBool,
    origin: Instant,
    stop: AtomicBool,
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.origin.elapsed().as_millis() as u64
    }

    fn mark(&self, wanted: &AtomicU64) {
        wanted.store(self.now_ms() + 1, Ordering::Relaxed);
    }

    fn recently(&self, wanted: &AtomicU64) -> bool {
        let at = wanted.load(Ordering::Relaxed);
        at != 0 && self.now_ms().saturating_sub(at - 1) < WANTED_FOR.as_millis() as u64
    }
}

/// Reads the service list on a worker thread, while something wants it.
pub struct ServiceMonitor {
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl ServiceMonitor {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                latest: Mutex::new(Arc::new(Reading::default())),
                list_wanted: AtomicU64::new(0),
                configs_wanted: AtomicU64::new(0),
                refresh: AtomicBool::new(false),
                origin: Instant::now(),
                stop: AtomicBool::new(false),
            }),
            worker: Mutex::new(None),
        }
    }

    /// The latest reading, asking for readings to keep coming, with every
    /// service's configuration as well when `with_configs`. Empty until the
    /// first read completes, a few tens of milliseconds after first asked.
    pub fn latest(&self, with_configs: bool) -> Arc<Reading> {
        self.shared.mark(&self.shared.list_wanted);
        if with_configs {
            self.shared.mark(&self.shared.configs_wanted);
        }
        if let Ok(mut worker) = self.worker.lock() {
            if worker.is_none() {
                let shared = Arc::clone(&self.shared);
                *worker = std::thread::Builder::new()
                    .name("task-manager-services".into())
                    .spawn(move || run(&shared))
                    .ok();
            }
        }
        match self.shared.latest.lock() {
            Ok(latest) => Arc::clone(&latest),
            Err(_) => Arc::new(Reading::default()),
        }
    }

    /// Read the list again as soon as possible, for when a service has just
    /// been started or stopped from here.
    pub fn refresh(&self) {
        self.shared.refresh.store(true, Ordering::Relaxed);
        if let Ok(worker) = self.worker.lock() {
            if let Some(worker) = worker.as_ref() {
                worker.thread().unpark();
            }
        }
    }
}

impl Default for ServiceMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ServiceMonitor {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        let worker = self.worker.get_mut().ok().and_then(Option::take);
        if let Some(worker) = worker {
            worker.thread().unpark();
            let _ = worker.join();
        }
    }
}

/// A configuration as last read, or the fact that it could not be.
struct CachedConfig {
    read_at: Instant,
    config: Option<Arc<ServiceConfig>>,
}

fn run(shared: &Shared) {
    let mut last_read: Option<Instant> = None;
    let mut configs: HashMap<String, CachedConfig> = HashMap::new();
    while !shared.stop.load(Ordering::Relaxed) {
        let wanted = shared.recently(&shared.list_wanted);
        let with_configs = shared.recently(&shared.configs_wanted);
        let refresh = shared.refresh.swap(false, Ordering::Relaxed);
        let due = refresh || last_read.is_none_or(|at| at.elapsed() >= REFRESH_INTERVAL);
        if !with_configs {
            // Nothing is showing them; the memory can go.
            configs.clear();
        }
        if wanted && due {
            // Taken before the read, so a process created during it is never
            // credited with a list that may predate it.
            let read_at_unix_ms = wall_clock_unix_ms();
            let read_at_100ns =
                (read_at_unix_ms * 10_000.0) as i64 + FILETIME_UNIX_EPOCH_DELTA_100NS;
            let reading = match services::enumerate() {
                Ok(list) => {
                    if with_configs {
                        read_configs(&list, &mut configs, &shared.stop);
                    }
                    build(list, &configs, read_at_100ns, read_at_unix_ms)
                }
                // Unknown is not the same as none: credit nothing until a read
                // succeeds, rather than keep an answer that may be stale.
                Err(error) => Reading {
                    read_at_unix_ms,
                    failure: Some(error),
                    ..Reading::default()
                },
            };
            if let Ok(mut latest) = shared.latest.lock() {
                *latest = Arc::new(reading);
            }
            last_read = Some(Instant::now());
        }
        // Parked rather than slept, so stopping or a refresh does not wait out
        // the interval.
        std::thread::park_timeout(Duration::from_millis(500));
    }
}

/// Read the configuration of every listed service whose copy is missing or
/// older than `CONFIG_REFRESH`, and forget services no longer listed.
fn read_configs(
    list: &[ServiceEntry],
    cache: &mut HashMap<String, CachedConfig>,
    stop: &AtomicBool,
) {
    cache.retain(|name, _| list.iter().any(|service| &service.name == name));
    let Ok(manager) = services::open_manager(SC_MANAGER_CONNECT) else {
        return;
    };
    for service in list {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let fresh = cache
            .get(&service.name)
            .is_some_and(|cached| cached.read_at.elapsed() < CONFIG_REFRESH);
        if fresh {
            continue;
        }
        let config = services::open_service(&manager, &service.name, SERVICE_QUERY_CONFIG)
            .and_then(|handle| services::query_config(&handle))
            .ok()
            .map(Arc::new);
        cache.insert(
            service.name.clone(),
            CachedConfig {
                read_at: Instant::now(),
                config,
            },
        );
    }
}

fn build(
    list: Vec<ServiceEntry>,
    configs: &HashMap<String, CachedConfig>,
    read_at_100ns: i64,
    read_at_unix_ms: f64,
) -> Reading {
    let by_pid = index(&list);
    let services = list
        .into_iter()
        .map(|entry| {
            let config = configs
                .get(&entry.name)
                .and_then(|cached| cached.config.clone());
            ServiceRecord { entry, config }
        })
        .collect();
    Reading {
        services,
        by_pid,
        read_at_100ns,
        read_at_unix_ms,
        failure: None,
    }
}

/// Group running services by the process they run in, in display-name order.
fn index(services: &[ServiceEntry]) -> HashMap<u32, Vec<HostedService>> {
    let mut by_pid: HashMap<u32, Vec<HostedService>> = HashMap::new();
    for service in services.iter().filter(|service| service.pid != 0) {
        by_pid.entry(service.pid).or_default().push(HostedService {
            name: service.name.clone(),
            display_name: service.display_name.clone(),
        });
    }
    for hosted in by_pid.values_mut() {
        hosted.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    }
    by_pid
}

/// The svchost group a service runs in: what follows `-k` in its command
/// line, e.g. `LocalServiceNetworkRestricted`. None for a service that is not
/// hosted by `svchost.exe`.
pub fn svchost_group(binary_path: &str) -> Option<String> {
    let (program, rest) = split_program(binary_path.trim());
    let file = program.rsplit(['\\', '/']).next().unwrap_or(program);
    if !file.eq_ignore_ascii_case("svchost.exe") {
        return None;
    }
    let mut tokens = rest.split_whitespace();
    while let Some(token) = tokens.next() {
        if token.eq_ignore_ascii_case("-k") {
            return tokens.next().map(str::to_string);
        }
    }
    None
}

/// Split a command line into its program, unquoted, and the rest.
fn split_program(command: &str) -> (&str, &str) {
    if let Some(quoted) = command.strip_prefix('"') {
        return match quoted.split_once('"') {
            Some((program, rest)) => (program, rest),
            None => (quoted, ""),
        };
    }
    command
        .split_once(char::is_whitespace)
        .unwrap_or((command, ""))
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
        let indexed = index(&[
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
            by_pid: index(&[entry("a", "Alpha", 8)]),
            read_at_100ns: 1_000,
            ..Reading::default()
        };
        assert!(reading.hosted_by(8, 999).is_some());
        assert!(reading.hosted_by(8, 1_001).is_none());
    }

    #[test]
    fn finds_the_svchost_group_and_nothing_else() {
        assert_eq!(
            svchost_group(r"C:\WINDOWS\system32\svchost.exe -k LocalServiceNetworkRestricted -p")
                .as_deref(),
            Some("LocalServiceNetworkRestricted")
        );
        assert_eq!(
            svchost_group(r#""C:\Windows\System32\svchost.exe" -k netsvcs"#).as_deref(),
            Some("netsvcs")
        );
        assert_eq!(
            svchost_group(r"C:\Windows\System32\SVCHOST.EXE -K apphost").as_deref(),
            Some("apphost")
        );
        // Not svchost, even with a -k of its own.
        assert_eq!(
            svchost_group(r#""C:\Program Files\App\app.exe" -k thing"#),
            None
        );
        assert_eq!(svchost_group(r"C:\Windows\System32\svchost.exe"), None);
        assert_eq!(svchost_group(""), None);
    }

    #[test]
    fn reads_the_live_list_on_its_own_thread_and_stops_cleanly() {
        let services = ServiceMonitor::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        while services.latest(false).by_pid.is_empty() {
            assert!(Instant::now() < deadline, "no reading within ten seconds");
            std::thread::sleep(Duration::from_millis(20));
        }
        // Without configurations asked for, none are read.
        assert!(services
            .latest(false)
            .services
            .iter()
            .all(|service| service.config.is_none()));
        // Dropping joins the worker; a hang here would fail the test run.
        drop(services);
    }

    #[test]
    fn reads_configurations_when_asked_and_on_refresh() {
        let services = ServiceMonitor::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        // The first reading may predate the request for configurations; a
        // refresh brings one that has them without waiting out the interval.
        services.latest(true);
        services.refresh();
        loop {
            let reading = services.latest(true);
            let configured = reading
                .services
                .iter()
                .filter(|service| service.config.is_some())
                .count();
            // Nearly all of them are readable without administrator rights.
            if configured * 10 > reading.services.len() * 9 && !reading.services.is_empty() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "no configurations within ten seconds"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}
